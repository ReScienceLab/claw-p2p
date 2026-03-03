# DeClaw

OpenClaw plugin for direct P2P communication between agent instances over Yggdrasil IPv6 mesh network. Messages are Ed25519-signed at the application layer; Yggdrasil provides cryptographic routing at the network layer.

## Core Commands

- Build: `npm run build`
- Run tests: `node --test test/*.test.mjs`
- Dev (watch mode): `npm run dev`
- Publish to npm: triggered by GitHub release (see `.github/workflows/`)
- Publish skill to ClawHub: `npx clawhub@latest publish skills/declaw`

Always run build before tests — tests import from `dist/`.

## Project Layout

```
├── src/                        → TypeScript plugin source
│   ├── index.ts                → Plugin entry: service, channel, CLI, agent tools
│   ├── identity.ts             → Ed25519 keypair, CGA/Yggdrasil address derivation
│   ├── yggdrasil.ts            → Daemon management: detect external, spawn managed
│   ├── peer-server.ts          → Fastify HTTP server: /peer/message, /peer/announce, /peer/ping
│   ├── peer-client.ts          → Outbound signed message + ping
│   ├── peer-discovery.ts       → Bootstrap + gossip DHT discovery loop
│   ├── peer-db.ts              → JSON peer store with TOFU and debounced writes
│   ├── channel.ts              → OpenClaw channel registration (inbound/outbound wiring)
│   └── types.ts                → Shared interfaces
├── test/                       → Node.js built-in test runner (node:test)
├── bootstrap/                  → Standalone bootstrap node (deployed on AWS)
│   ├── server.mjs              → Pure ESM, fastify + tweetnacl only
│   ├── Dockerfile              → node:22-alpine container
│   └── package.json            → Minimal deps (no TypeScript)
├── skills/declaw/              → ClawHub skill definition
│   ├── SKILL.md                → Skill frontmatter + tool docs
│   └── references/             → Supplementary docs (flows, discovery, install)
├── docs/                       → GitHub Pages assets
│   └── bootstrap.json          → Dynamic bootstrap node list (fetched by plugin at startup)
├── openclaw.plugin.json        → Plugin manifest (channels, config schema, UI hints)
└── docker/                     → Docker Compose for local multi-node testing
```

## Architecture Overview

Plugin registers a background service (`declaw-node`) that:
1. Loads/creates an Ed25519 identity (`~/.openclaw/declaw/identity.json`)
2. Detects or spawns a Yggdrasil daemon for a routable `200::/7` address
3. Starts a Fastify peer server on `[::]:8099`
4. After 30s delay, bootstraps peer discovery via 5 global AWS nodes
5. Runs periodic gossip loop (10min interval) to keep routing table fresh

Trust model (4-layer):
1. TCP source IP must be Yggdrasil `200::/7` (network-layer)
2. `fromYgg` in body must match TCP source IP (anti-spoofing)
3. Ed25519 signature over canonical JSON (application-layer)
4. TOFU: first message caches public key; subsequent must match

## Development Patterns

### TypeScript
- Strict mode, ES2022 target, CommonJS output
- No semicolons in source (match existing style)
- Tests use `node:test` + `node:assert/strict` (no external test framework)
- Tests import from `dist/` — always `npm run build` first

### Plugin Config
All runtime config is in `openclaw.json` under `plugins.entries.declaw.config`:
```json
{
  "test_mode": "auto",
  "peer_port": 8099,
  "bootstrap_peers": [],
  "discovery_interval_ms": 600000,
  "startup_delay_ms": 30000
}
```
`test_mode` is tri-state: `"auto"` (default) detects Yggdrasil, `true` forces local-only, `false` requires Yggdrasil.

### Bootstrap Nodes
- 5 AWS EC2 t3.medium across us-east-2, us-west-2, eu-west-1, ap-northeast-1, ap-southeast-1
- Managed via AWS SSM (no SSH) — IAM profile `openclaw-p2p-ssm-profile`
- Deploy: `base64 -i bootstrap/server.mjs` → SSM send-command → restart systemd service
- Yggdrasil config locked with `chattr +i` to prevent key regeneration
- Nodes sync peer tables every 5min via sibling announce

### Peer DB
- JSON file at `$data_dir/peers.json`
- Discovery writes are debounced (1s); manual ops and TOFU writes are immediate
- `flushDb()` called on service shutdown

## Git Workflow

- Branch from `main`: `feature/<slug>`, `fix/<slug>`
- Commit prefixes: `feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `chore:`, `test:`
- Breaking changes: `feat!:` with `BREAKING CHANGE:` footer (0.x phase — breaking changes expected)
- Version bumps: `npm version patch|minor|major` → push tag → GitHub release → npm publish
- Never force-push `main`

## Security

- Ed25519 private keys stored at `~/.openclaw/declaw/identity.json` — never log or expose
- Bootstrap nodes reject non-Yggdrasil source IPs (403)
- TOFU key mismatch returns 403 with explicit error (possible key rotation)
- Yggdrasil admin socket (`/var/run/yggdrasil.sock`) requires appropriate permissions
- Plugin spawning Yggdrasil needs root for TUN device — prefer system daemon

## Gotchas

- Tests import `dist/` not `src/` — stale builds cause phantom failures
- Plugin spawns its own Yggdrasil if no system daemon detected; this fails without root (TUN permission). The plugin now auto-detects external daemons via admin socket.
- `alias: undefined` in JSON payloads causes canonicalization mismatches across nodes — always omit the field instead of setting to undefined
- `docs/bootstrap.json` is published via GitHub Pages — update it when adding/removing bootstrap nodes (plugin fetches this at startup)
- The `openclaw.json` config `test_mode: true` silently disables all Yggdrasil integration — now defaults to `"auto"` to prevent this footgun
- Bootstrap discovery runs 30s after startup to let Yggdrasil routes converge; when reusing an external daemon, routes are already converged but the delay still applies

## Archived Knowledge

Before debugging or repeating past work, consult `.archive/MEMORY.md` for deployment history, bug fixes, and infrastructure decisions.
