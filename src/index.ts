/**
 * openclaw-ipv6-p2p — OpenClaw plugin entry point.
 *
 * Enables direct P2P communication between OpenClaw instances via Yggdrasil IPv6.
 * Each node gets a globally-routable 200::/8 address derived from its Ed25519 keypair.
 * Messages are signed and verified at the application layer (Ed25519).
 * The Yggdrasil network layer provides additional cryptographic routing guarantees.
 *
 * Usage after install:
 *   openclaw p2p status               — show your Yggdrasil address
 *   openclaw p2p add <ygg-addr>       — add a peer
 *   openclaw p2p peers                — list known peers
 *   openclaw p2p send <ygg-addr> <m>  — send a direct message
 *   openclaw p2p ping <ygg-addr>      — check reachability
 *   /p2p-status                       — show status in chat
 */
import * as os from "os";
import * as path from "path";
import { loadOrCreateIdentity } from "./identity";
import { startYggdrasil, stopYggdrasil, isYggdrasilAvailable } from "./yggdrasil";
import { initDb, listPeers, upsertPeer, removePeer, getPeer } from "./peer-db";
import { startPeerServer, stopPeerServer, getInbox } from "./peer-server";
import { sendP2PMessage, pingPeer } from "./peer-client";
import { buildChannel, wireInboundToGateway } from "./channel";
import { Identity, YggdrasilInfo, PluginConfig } from "./types";

let identity: Identity | null = null;
let yggInfo: YggdrasilInfo | null = null;
let dataDir: string = path.join(os.homedir(), ".openclaw", "ipv6-p2p");
let peerPort: number = 8099;

export default function register(api: any) {
  // ── 1. Background service ──────────────────────────────────────────────────
  api.registerService({
    id: "ipv6-p2p-node",

    start: async () => {
      const cfg: PluginConfig = api.config?.plugins?.entries?.["ipv6-p2p"]?.config ?? {};
      dataDir = cfg.data_dir ?? dataDir;
      peerPort = cfg.peer_port ?? peerPort;
      const extraPeers: string[] = cfg.yggdrasil_peers ?? [];

      // Load or create Ed25519 identity
      identity = loadOrCreateIdentity(dataDir);
      initDb(dataDir);

      console.log(`[p2p] Agent ID:  ${identity.agentId}`);
      console.log(`[p2p] CGA IPv6:  ${identity.cgaIpv6}`);
      console.log(`[p2p] Ygg (est): ${identity.yggIpv6} (derived, before daemon starts)`);

      // Start Yggdrasil daemon (best-effort)
      if (isYggdrasilAvailable()) {
        yggInfo = await startYggdrasil(dataDir, extraPeers);
        if (yggInfo) {
          // Update identity with real Yggdrasil address from daemon
          identity.yggIpv6 = yggInfo.address;
          console.log(`[p2p] Yggdrasil: ${yggInfo.address}  (subnet: ${yggInfo.subnet})`);
        }
      } else {
        console.warn("[p2p] yggdrasil not installed — run without Yggdrasil (local network only)");
        console.warn("[p2p] Install: https://yggdrasil-network.github.io/installation.html");
      }

      // Start peer HTTP server
      await startPeerServer(peerPort);

      // Wire incoming messages to OpenClaw gateway
      wireInboundToGateway(api);
    },

    stop: async () => {
      await stopPeerServer();
      stopYggdrasil();
    },
  });

  // ── 2. OpenClaw Channel ────────────────────────────────────────────────────
  if (identity) {
    api.registerChannel({ plugin: buildChannel(identity, peerPort) });
  } else {
    // Register lazily after service starts — use a proxy channel
    // that reads identity at send-time
    api.registerChannel({
      plugin: {
        id: "ipv6-p2p",
        meta: {
          id: "ipv6-p2p",
          label: "IPv6 P2P",
          selectionLabel: "IPv6 P2P (Yggdrasil)",
          docsPath: "/channels/ipv6-p2p",
          blurb: "Direct encrypted P2P messaging via Yggdrasil IPv6.",
          aliases: ["p2p", "ygg"],
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => (identity ? listPeers().map((p) => p.yggAddr) : []),
          resolveAccount: (_: unknown, accountId: string | undefined) => ({
            accountId: accountId ?? "",
            yggAddr: accountId ?? "",
          }),
        },
        outbound: {
          deliveryMode: "direct" as const,
          sendText: async ({ text, account }: { text: string; account: { yggAddr: string } }) => {
            if (!identity) return { ok: false };
            const r = await sendP2PMessage(identity, account.yggAddr, "chat", text, peerPort);
            return { ok: r.ok };
          },
        },
      },
    });
  }

  // ── 3. CLI commands ────────────────────────────────────────────────────────
  api.registerCli(
    ({ program }: { program: any }) => {
      const p2p = program.command("p2p").description("IPv6 P2P node management");

      p2p
        .command("status")
        .description("Show this node's Yggdrasil address and status")
        .action(() => {
          if (!identity) {
            console.log("Plugin not started yet. Try again after gateway restart.");
            return;
          }
          console.log("=== IPv6 P2P Node Status ===");
          console.log(`Agent ID:       ${identity.agentId}`);
          console.log(`CGA IPv6:       ${identity.cgaIpv6}`);
          console.log(`Yggdrasil:      ${yggInfo?.address ?? identity.yggIpv6 + " (no daemon)"}`);
          console.log(`Peer port:      ${peerPort}`);
          console.log(`Known peers:    ${listPeers().length}`);
          console.log(`Inbox messages: ${getInbox().length}`);
        });

      p2p
        .command("peers")
        .description("List known peers")
        .action(() => {
          const peers = listPeers();
          if (peers.length === 0) {
            console.log("No peers yet. Use 'openclaw p2p add <ygg-addr>' to add one.");
            return;
          }
          console.log("=== Known Peers ===");
          for (const peer of peers) {
            const ago = Math.round((Date.now() - peer.lastSeen) / 1000);
            const alias = peer.alias ? ` (${peer.alias})` : "";
            console.log(`  ${peer.yggAddr}${alias}  last seen ${ago}s ago`);
          }
        });

      p2p
        .command("add <yggAddr>")
        .description("Add a peer by their Yggdrasil address")
        .option("-a, --alias <alias>", "Human-readable alias for this peer")
        .action((yggAddr: string, opts: { alias?: string }) => {
          upsertPeer(yggAddr, opts.alias ?? "");
          console.log(`Peer added: ${yggAddr}${opts.alias ? ` (${opts.alias})` : ""}`);
        });

      p2p
        .command("remove <yggAddr>")
        .description("Remove a peer")
        .action((yggAddr: string) => {
          removePeer(yggAddr);
          console.log(`Peer removed: ${yggAddr}`);
        });

      p2p
        .command("ping <yggAddr>")
        .description("Check if a peer is reachable")
        .action(async (yggAddr: string) => {
          console.log(`Pinging ${yggAddr}...`);
          const ok = await pingPeer(yggAddr, peerPort);
          console.log(ok ? `✓ Reachable` : `✗ Unreachable`);
        });

      p2p
        .command("send <yggAddr> <message>")
        .description("Send a direct message to a peer")
        .action(async (yggAddr: string, message: string) => {
          if (!identity) {
            console.error("Plugin not started. Restart the gateway first.");
            return;
          }
          const result = await sendP2PMessage(identity, yggAddr, "chat", message, peerPort);
          if (result.ok) {
            console.log(`✓ Message sent to ${yggAddr}`);
          } else {
            console.error(`✗ Failed: ${result.error}`);
          }
        });

      p2p
        .command("inbox")
        .description("Show received messages")
        .action(() => {
          const msgs = getInbox();
          if (msgs.length === 0) {
            console.log("No messages received yet.");
            return;
          }
          console.log("=== Inbox ===");
          for (const m of msgs.slice(0, 20)) {
            const time = new Date(m.receivedAt).toLocaleTimeString();
            console.log(`  [${time}] from ${m.fromYgg.slice(0, 20)}...: ${m.content}`);
          }
        });
    },
    { commands: ["p2p"] }
  );

  // ── 4. Auto-reply slash commands ───────────────────────────────────────────
  api.registerCommand({
    name: "p2p-status",
    description: "Show IPv6 P2P node status",
    handler: () => {
      if (!identity) return { text: "IPv6 P2P: not started yet." };
      const peers = listPeers();
      const addr = yggInfo?.address ?? identity.yggIpv6;
      return {
        text: [
          `**IPv6 P2P Node**`,
          `Address: \`${addr}\``,
          `Peers: ${peers.length} known`,
          `Inbox: ${getInbox().length} messages`,
        ].join("\n"),
      };
    },
  });

  api.registerCommand({
    name: "p2p-peers",
    description: "List known P2P peers",
    handler: () => {
      const peers = listPeers();
      if (peers.length === 0) return { text: "No peers yet. Use `openclaw p2p add <addr>`." };
      const lines = peers.map((p) => `• \`${p.yggAddr}\`${p.alias ? ` — ${p.alias}` : ""}`);
      return { text: `**Known Peers**\n${lines.join("\n")}` };
    },
  });
}
