# DeClaw

OpenClaw plugin for direct P2P communication between agent instances over Yggdrasil IPv6 mesh network. Messages are Ed25519-signed at the application layer; Yggdrasil provides cryptographic routing at the network layer.

## Core Commands

- Build: `npm run build`
- Run tests: `node --test test/*.test.mjs`
- Dev (watch mode): `npm run dev`
- Release: `bash scripts/release.sh patch|minor|major`
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

We use **Git Flow** for version control. Install with `brew install git-flow`.

### Branching Strategy (Git Flow)

- `main` — Production branch, always deployable
- `develop` — Integration branch for features
- `feature/<slug>` — New features (branch from `develop`)
- `fix/<slug>` — Bug fixes (branch from `develop`)
- `hotfix/<version>` — Urgent production fixes (branch from `main`)

### Git Flow Commands

```bash
# Initialize git flow (first time only)
git flow init

# Start a new feature
git flow feature start <name>

# Finish feature — DO NOT use git flow feature finish
# Instead, push and create PR:
git push -u origin feature/<name>
gh pr create --base develop --head feature/<name>

# Start a hotfix
git flow hotfix start <version>

# Finish hotfix (merges to main and develop)
git flow hotfix finish <version>
git push origin main develop --tags

# Start a release
git flow release start <version>

# Finish release
git flow release finish <version>
git push origin main develop --tags
```

### Important: All Changes Via PR

**Both `main` and `develop` are branch-protected. No direct push allowed.**

1. Push feature/fix branch to origin
2. Create PR targeting `develop` (features/fixes) or `main` (releases/hotfixes)
3. CI must pass (`test (20)` + `test (22)`)
4. Squash merge only — one commit per PR
5. **Close the corresponding issue** when merging (use `Fixes #N` or `Closes #N` in the PR description)
6. Merged branches are auto-deleted

### Commit Convention

- `feat:` — New features
- `fix:` — Bug fixes
- `perf:` — Performance improvements
- `refactor:` — Code refactoring
- `docs:` — Documentation changes
- `test:` — Test additions/changes
- `chore:` — Maintenance tasks
- Breaking changes: `feat!:` with `BREAKING CHANGE:` footer (0.x phase — breaking changes expected)

**Do not add any watermark or AI-generated signatures to commit messages.**

### Issue Management

When creating new issues:
1. **Add type labels**: `bug`, `feature`, `enhancement`, `documentation`, `refactor`, `test`, `chore`
2. **Add tag labels**: `priority:high` / `priority:medium` / `priority:low`, `good first issue`, `help wanted`, area tags (`bootstrap`, `p2p`, `yggdrasil`, etc.)
3. **Write clear descriptions**: bugs include reproduction steps + expected vs actual; features describe use case and desired outcome

### PR Requirements

1. All tests must pass: `npm run build && node --test test/*.test.mjs`
2. TypeScript must compile: `npm run build`
3. Feature branches merge to `develop` via PR
4. Hotfix branches merge to both `main` and `develop`
5. Releases: `develop` → `main` via PR
6. Reference the issue number in the PR description (e.g., `#123`)
7. Use closing keywords to auto-close issues on merge (e.g., `Fixes #123`, `Closes #123`)

## Release Process

### Release Pipeline (Local + CI)

One command kicks off the release via PR — CI handles the rest on merge:

```bash
bash scripts/release.sh patch   # 0.2.2 → 0.2.3
bash scripts/release.sh minor   # 0.2.2 → 0.3.0
bash scripts/release.sh major   # 0.2.2 → 1.0.0
```

**Local (`scripts/release.sh`):**
1. **Preflight**: verifies on `main`, clean tree, synced with remote
2. **Build + test**: `npm run build` + `node --test test/*.test.mjs`
3. **Version bump**: syncs all 3 version-bearing files
4. **Changelog check**: warns if `CHANGELOG.md` is missing new version section
5. **Create Release PR**: pushes `release/vX.Y.Z` branch → creates PR targeting `main`

**CI (`.github/workflows/release.yml`, triggered when `release/v*` PR merges into `main`):**
6. **Build + test gate**: Node 20 + 22 matrix
7. **Tag + GitHub Release**: creates `vX.Y.Z` tag + auto-generated release notes → triggers npm publish
8. **ClawHub publish**: `npx clawhub@latest publish` with `CLAWHUB_TOKEN` secret
9. **Backmerge**: main → develop (via github-actions bot)

### CI Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `release.yml` | Release PR merged into `main` | Verify → Tag → GH Release → ClawHub → Backmerge |
| `publish.yml` | GH Release published | npm publish with `NPM_TOKEN` |
| `test.yml` | Push/PR to main/develop | Build + test (Node 20+22) |
| `auto-close-issues.yml` | PR merged | Close linked issues |
| `bootstrap-health.yml` | Scheduled | Ping all 5 bootstrap nodes |

### Branch Protection

Both `main` and `develop` are protected:
- **No direct push** — all changes via PR (squash merge only)
- **Required CI**: `test (20)` + `test (22)` must pass
- **No force push** or branch deletion
- **Enforced for admins** — no bypass

### Repo Security

- **Secret scanning + push protection**: enabled (GitHub catches leaked tokens)
- **Squash merge only**: one commit per PR, clean history
- **Auto-delete branches**: merged PR branches are cleaned up automatically
- **Required secrets**: `NPM_TOKEN` (npm), `CLAWHUB_TOKEN` (ClawHub)

### Pre-release: Update CHANGELOG

Before running the release script, update `CHANGELOG.md`:
- Add a `[X.Y.Z] - YYYY-MM-DD` section
- Categorize entries: `Breaking Changes`, `Added`, `Changed`, `Fixed`
- Reference issues and PRs (e.g., `PR #8`, `Closes #7`)

### Bootstrap Node Deployment
- Only needed when `bootstrap/server.mjs` or `bootstrap/package.json` changes
- Deploy via AWS SSM (no SSH):
  ```bash
  B64=$(base64 -i bootstrap/server.mjs)
  for pair in "i-04670f4d1a72c7d5d:us-east-2" "i-096ba79b9ae854339:us-west-2" \
    "i-084242224f1a49b13:eu-west-1" "i-0b909aacd92097e43:ap-northeast-1" \
    "i-0141cd0f56a902978:ap-southeast-1"; do
    IID=${pair%%:*}; REGION=${pair##*:}
    aws ssm send-command --instance-ids $IID --region $REGION \
      --document-name "AWS-RunShellScript" \
      --parameters "{\"commands\":[\"echo '${B64}' | base64 -d > /opt/declaw-bootstrap/server.mjs\",\"systemctl restart declaw-bootstrap\"]}" \
      --query 'Command.CommandId' --output text
    echo "$REGION: deployed"
  done
  ```
- If `bootstrap/package.json` also changed (e.g., dependency upgrade), deploy it too and run `npm install`:
  ```bash
  B64_PKG=$(base64 -i bootstrap/package.json)
  # same loop, but commands: decode package.json + cd + npm install + restart
  ```
- Verify: `curl -s http://[node-ygg-addr]:8099/peer/ping`

### Version-bearing Files

These files must always have matching versions (handled by `scripts/release.sh`):
| File | Field |
|---|---|
| `package.json` | `"version"` (canonical source) |
| `package-lock.json` | `"version"` (auto-updated by `npm version`) |
| `openclaw.plugin.json` | `"version"` |
| `skills/declaw/SKILL.md` | `version:` in YAML frontmatter |

### Versioning

Semantic versioning: `vMAJOR.MINOR.PATCH`
- MAJOR: Breaking changes (in 0.x phase, MINOR covers breaking changes)
- MINOR: New features
- PATCH: Bug fixes

## Security

- Ed25519 private keys stored at `~/.openclaw/declaw/identity.json` — never log or expose
- Bootstrap nodes reject non-Yggdrasil source IPs (403)
- TOFU key mismatch returns 403 with explicit error (possible key rotation)
- Yggdrasil admin socket (`/var/run/yggdrasil.sock`) requires appropriate permissions
- Plugin spawning Yggdrasil needs root for TUN device — prefer system daemon