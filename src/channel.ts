/**
 * OpenClaw channel registration for IPv6 P2P messaging.
 * Registers "ipv6-p2p" as a messaging channel so OpenClaw users can
 * chat directly with peers via the standard OpenClaw UI.
 */
import { Identity } from "./types";
import { sendP2PMessage } from "./peer-client";
import { listPeers, getPeerAddresses, upsertPeer } from "./peer-db";
import { onMessage } from "./peer-server";

export function buildChannel(identity: Identity, port: number) {
  return {
    id: "ipv6-p2p",
    meta: {
      id: "ipv6-p2p",
      label: "IPv6 P2P",
      selectionLabel: "IPv6 P2P (Yggdrasil)",
      docsPath: "/channels/ipv6-p2p",
      blurb: "Direct encrypted P2P messaging via Yggdrasil IPv6. No servers, no middlemen.",
      aliases: ["p2p", "ygg", "yggdrasil"],
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
          console.error(`[p2p] Failed to send to ${account.yggAddr}: ${result.error}`);
        }
        return { ok: result.ok };
      },
    },
  };
}

/**
 * Wire incoming P2P messages to the OpenClaw gateway so they appear
 * in the conversation UI as incoming channel messages.
 *
 * api.gateway is the internal Gateway object exposed to plugins.
 * We emit a synthetic inbound message event.
 */
export function wireInboundToGateway(api: any): void {
  onMessage((msg) => {
    if (msg.event !== "chat") return;
    try {
      // OpenClaw's internal gateway receives inbound channel messages via
      // api.gateway.receiveChannelMessage (channel id + account id + text)
      api.gateway?.receiveChannelMessage?.({
        channelId: "ipv6-p2p",
        accountId: msg.fromYgg,
        text: msg.content,
        senderId: msg.fromYgg,
      });
    } catch {
      // Gateway API may differ by OpenClaw version — fallback: just log
      console.log(`[p2p] Message from ${msg.fromYgg.slice(0, 20)}...: ${msg.content}`);
    }
  });
}
