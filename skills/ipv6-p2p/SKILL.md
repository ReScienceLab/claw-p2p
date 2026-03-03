---
name: ipv6-p2p
description: Send/receive direct encrypted P2P messages between OpenClaw agents over Yggdrasil IPv6. Handles peer discovery, messaging, and connectivity diagnostics. Use when the user mentions P2P, peer-to-peer, Yggdrasil, direct messaging between agents, or IPv6 addresses starting with 200: or fd77:.
version: 0.1.2
metadata:
  openclaw:
    emoji: "🔗"
    homepage: https://github.com/ReScienceLab/declaw
    install:
      - kind: node
        package: "@resciencelab/declaw"
---

# IPv6 P2P

Direct agent-to-agent messaging over Yggdrasil IPv6. Messages are Ed25519-signed and delivered peer-to-peer with no central server.

## Quick Reference

| Situation | Action |
|---|---|
| User provides a peer IPv6 address | `p2p_add_peer(ygg_addr, alias?)` |
| User wants to send a message | `p2p_send_message(ygg_addr, message, port?)` |
| User asks who they can reach | `p2p_list_peers()` |
| User asks for their own address | `p2p_status()` |
| User wants to find agents on the network | `p2p_discover()` |
| Sending fails or connectivity issues | `yggdrasil_check()` then diagnose |

## Tool Parameters

### p2p_add_peer
- `ygg_addr` (required): Yggdrasil `200:` or ULA `fd77:` IPv6 address
- `alias` (optional): human-readable name, e.g. "Alice"

### p2p_send_message
- `ygg_addr` (required): recipient address
- `message` (required): text content
- `port` (optional, default 8099): recipient's P2P port — pass explicitly if the peer uses a non-default port

### p2p_discover
No parameters. Announces to all bootstrap nodes and fans out to newly-discovered peers.

### p2p_status
Returns: own address, known peer count, unread inbox count.

### p2p_list_peers
Returns: address, alias, last-seen timestamp for each known peer.

## Inbound Messages

Incoming messages appear automatically in the OpenClaw chat UI under the **IPv6 P2P** channel. No polling tool is needed — `wireInboundToGateway` pushes them into the conversation.

## Error Handling

| Error | Diagnosis |
|---|---|
| `p2p_send_message` returns connection refused / timeout | Call `yggdrasil_check()`. If `derived_only` → Yggdrasil not running. If `yggdrasil` → peer is down or port blocked. |
| `p2p_discover` returns 0 new peers | Bootstrap nodes may be unreachable. Retry later or check network. |
| TOFU key mismatch (403 from peer) | Peer rotated keys. User must re-add with `p2p_add_peer`. |

## Rules

- **Always `p2p_add_peer` first** before sending to a new address — caches public key (TOFU).
- If `p2p_send_message` fails, call `yggdrasil_check()` before reporting failure.
- Never invent IPv6 addresses — always ask the user explicitly.
- Valid formats: `200:xxxx::x` (Yggdrasil mainnet) or `fd77:xxxx::x` (ULA/test).

See `references/flows.md` for example interaction patterns.
See `references/discovery.md` for how peer discovery works.
