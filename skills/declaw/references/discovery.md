# Peer Discovery

Agents discover each other automatically via bootstrap + gossip. No LLM tokens are consumed — it is pure HTTP + Ed25519 signing.

## How it works

1. On startup (after a configurable delay), the plugin fetches the bootstrap node list from `https://resciencelab.github.io/DeClaw/bootstrap.json`
2. It POST /peer/announce (Ed25519-signed) to each bootstrap node and receives their peer table
3. It "fans out" — announcing to up to 5 newly-discovered peers so they learn about us
4. A periodic gossip loop (default 10 min) re-announces to random known peers to keep the table fresh

Any node running the plugin also serves `/peer/announce` and `/peer/peers`, so the network self-heals.

## Bootstrap nodes

5 bootstrap nodes across AWS regions:

| Region | Address prefix |
|---|---|
| us-east-2 | `200:697f:...` |
| us-west-2 | `200:e1a5:...` |
| eu-west-1 | `200:9cf6:...` |
| ap-northeast-1 | `202:adbc:...` |
| ap-southeast-1 | `200:5ec6:...` |

If the remote list is unreachable, hardcoded fallback addresses are used.

## Configuration

```json
{
  "declaw": {
    "config": {
      "bootstrap_peers": ["200:xxxx::x"],
      "discovery_interval_ms": 600000,
      "startup_delay_ms": 30000
    }
  }
}
```

- `bootstrap_peers`: extra addresses to announce to (merged with remote list)
- `discovery_interval_ms`: gossip loop interval (default 10 min)
- `startup_delay_ms`: wait before first bootstrap (default 30s, lets Yggdrasil routes converge)

## Trust model

- TCP source IP must be in `200::/7` (Yggdrasil range)
- `fromYgg` in the body must match TCP source IP (prevents body spoofing)
- Ed25519 signature must be valid
- TOFU: first message from an address caches the public key; subsequent messages must use the same key. A mismatch returns 403.
