/**
 * OpenClaw channel registration for DeClaw P2P messaging.
 * Registers "declaw" as a messaging channel so OpenClaw users can
 * chat directly with peers via the standard OpenClaw UI.
 */
import { Identity } from "./types";
import { sendP2PMessage } from "./peer-client";
import { listPeers, getPeerAddresses, upsertPeer } from "./peer-db";
import { onMessage } from "./peer-server";

export function buildChannel(identity: Identity, port: number) {
  return {
    id: "declaw",
    meta: {
      id: "declaw",
      label: "DeClaw",
      selectionLabel: "DeClaw (Yggdrasil P2P)",
      docsPath: "/channels/declaw",
      blurb: "Direct encrypted P2P messaging via Yggdrasil IPv6. No servers, no middlemen.",
      aliases: ["p2p", "ygg", "yggdrasil", "ipv6-p2p"],
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      /** List all known peer Yggdrasil addresses as "account IDs". */
      listAccountIds: (_cfg: unknown) => getPeerAddresses(),
      /** Resolve an account ID (Ygg address) to an account config object. */
      resolveAccount: (_cfg: unknown, accountId: string | undefined) => {
        const addr = accountId ?? "";
        const peer = listPeers().find((p) => p.yggAddr === addr);
        return { accountId: addr, yggAddr: addr, alias: peer?.alias ?? addr };
      },
    },
    outbound: {
      deliveryMode: "direct" as const,
      sendText: async ({ text, account }: { text: string; account: { yggAddr: string } }) => {
        const result = await sendP2PMessage(identity, account.yggAddr, "chat", text, port);
        if (!result.ok) {
          console.error(`[declaw] Failed to send to ${account.yggAddr}: ${result.error}`);
        }
        return { ok: result.ok };
      },
    },
  };
}

/**
 * Wire incoming P2P messages to the OpenClaw gateway so they appear
 * in the conversation UI as incoming channel messages.
 */
export function wireInboundToGateway(api: any): void {
  onMessage((msg) => {
    if (msg.event !== "chat") return;
    try {
      api.gateway?.receiveChannelMessage?.({
        channelId: "declaw",
        accountId: msg.fromYgg,
        text: msg.content,
        senderId: msg.fromYgg,
      });
    } catch {
      console.log(`[declaw] Message from ${msg.fromYgg.slice(0, 20)}...: ${msg.content}`);
    }
  });
}
