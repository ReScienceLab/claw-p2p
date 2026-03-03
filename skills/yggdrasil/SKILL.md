---
name: yggdrasil
description: Diagnose Yggdrasil installation and daemon status for IPv6 P2P connectivity. Use when P2P fails, user asks about connectivity, or Yggdrasil needs to be installed.
version: 0.1.2
metadata:
  openclaw:
    emoji: "🌐"
    homepage: https://github.com/ReScienceLab/declaw
    install:
      - kind: node
        package: "@resciencelab/declaw"
---

# Yggdrasil Setup

Yggdrasil gives every OpenClaw agent a globally-routable `200::/8` IPv6 address derived from their Ed25519 keypair. Without it, P2P addresses are local-only.

## Quick Reference

| Situation | Action |
|---|---|
| "Is P2P working?" / "Can I connect?" | `yggdrasil_check()`, explain result |
| "What is my address?" (first time) | `yggdrasil_check()` to confirm routable |
| `p2p_send_message` fails | `yggdrasil_check()` to diagnose |
| Yggdrasil not installed | Guide through install (see `references/install.md`) |
| User asks what Yggdrasil is | Explain briefly, offer to install |

## Interpreting yggdrasil_check Results

| Address type | Meaning | Tell the user |
|---|---|---|
| `yggdrasil` | Daemon running, globally routable | Ready. Share the address with peers. |
| `test_mode` | Local/Docker only | Fine for testing on the same machine. Not reachable by internet peers. |
| `derived_only` | Yggdrasil not running | Address is NOT reachable. Install Yggdrasil first. |

## Troubleshooting derived_only

If `yggdrasil_check()` returns `derived_only` after install:

1. **Binary not on PATH**: Run `which yggdrasil`. If not found, add to PATH or reinstall.
2. **Gateway not restarted**: The plugin detects the binary at startup. Restart the OpenClaw gateway.
3. **Permission denied**: On Linux, Yggdrasil needs `CAP_NET_ADMIN` to create a TUN interface. Run as root or use `setcap`.
4. **Docker**: Container needs `--cap-add=NET_ADMIN` and `--device=/dev/net/tun`.

## After Install

1. Restart the OpenClaw gateway.
2. The plugin detects Yggdrasil, generates a config, and starts the daemon automatically.
3. Call `yggdrasil_check()` to confirm the routable `200:` address.

See `references/install.md` for platform-specific install commands.
