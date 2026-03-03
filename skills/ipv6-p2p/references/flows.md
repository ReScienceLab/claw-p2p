# IPv6 P2P — Example Interaction Flows

## Flow 1 — Discover peers on the network

```
User: "Find other agents I can talk to"

1. p2p_discover()
→ "Discovery complete — 5 new peer(s) found. Known peers: 8"
2. p2p_list_peers()
→ Show the list so user can pick someone to message.
```

## Flow 2 — User gives a new peer address and asks to send

```
User: "Alice's agent is at 200:abc:def::1 — send her 'hello'"

1. p2p_add_peer(ygg_addr="200:abc:def::1", alias="Alice")
2. p2p_send_message(ygg_addr="200:abc:def::1", message="hello")
→ "Message delivered to Alice (200:abc:def::1)"
```

## Flow 3 — User wants to share their own address

```
User: "What is my agent's P2P address?"

1. p2p_status()
→ "Your agent's P2P address is 200:1234::a. Share this with others."
```

## Flow 4 — User references a peer by alias

```
User: "Send 'ready' to Bob"

1. p2p_list_peers()          ← find Bob's address by alias
2. p2p_send_message(ygg_addr=<bob's addr>, message="ready")
→ "Message sent to Bob."
```

## Flow 5 — Delivery fails (with diagnosis)

```
User: "Send 'hello' to 200:ffff::c"

1. p2p_add_peer(ygg_addr="200:ffff::c")
2. p2p_send_message(ygg_addr="200:ffff::c", message="hello")
   → error: connection refused

3. yggdrasil_check()    ← diagnose before reporting
   → yggdrasil running, address is routable

→ "Could not reach 200:ffff::c — the peer's agent may be
   offline or their port 8099 is blocked. Our Yggdrasil
   connection is healthy."
```

## Flow 6 — Peer uses non-default port

```
User: "Send 'ping' to 200:abc::1 on port 9001"

1. p2p_add_peer(ygg_addr="200:abc::1")
2. p2p_send_message(ygg_addr="200:abc::1", message="ping", port=9001)
→ "Message delivered to 200:abc::1"
```

## Flow 7 — First-time user

```
User: "How do I use P2P?"

1. yggdrasil_check()
   → derived_only (Yggdrasil not running)

→ "You need Yggdrasil installed for P2P to work. It gives your
   agent a globally-routable IPv6 address."
   (Guide through install — see yggdrasil-setup skill)
```

## Flow 8 — Discovery returns nothing

```
User: "Find other agents"

1. p2p_discover()
   → "Discovery complete — 0 new peer(s) found. Known peers: 0"

→ "No peers found — the bootstrap nodes may be temporarily
   unreachable. Try again in a few minutes, or ask someone
   to share their address directly."
```
