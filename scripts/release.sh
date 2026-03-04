#!/usr/bin/env bash
set -euo pipefail

# DeClaw — release script (creates Release PR)
# Usage:
#   bash scripts/release.sh patch    # 0.2.2 → 0.2.3
#   bash scripts/release.sh minor    # 0.2.2 → 0.3.0
#   bash scripts/release.sh major    # 0.2.2 → 1.0.0
#
# Flow:
#   1. Local: preflight → build+test → version bump → create Release PR
#   2. CI: PR merge triggers release.yml → tag + GH Release + npm + ClawHub + backmerge

LEVEL="${1:-patch}"

if [[ "$LEVEL" != "patch" && "$LEVEL" != "minor" && "$LEVEL" != "major" ]]; then
  echo "Usage: bash scripts/release.sh [patch|minor|major]"
  exit 1
fi

echo "=== DeClaw Release (${LEVEL}) ==="

# ── 0. Preflight ─────────────────────────────────────────────────────────────

BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on 'main' branch (currently on '${BRANCH}')"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

git fetch origin main --quiet
LOCAL=$(git rev-parse main)
REMOTE=$(git rev-parse origin/main)
if [[ "$LOCAL" != "$REMOTE" ]]; then
  echo "Error: local main differs from origin/main. Pull or push first."
  exit 1
fi

# ── 1. Build + test ──────────────────────────────────────────────────────────

echo "Building..."
npm run build

echo "Running tests..."
node --test test/*.test.mjs

# ── 2. Version bump ──────────────────────────────────────────────────────────

VERSION=$(npm version "$LEVEL" --no-git-tag-version | tr -d 'v')
echo "New version: ${VERSION}"

sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" openclaw.plugin.json
sed -i '' "s/^version: .*/version: ${VERSION}/" skills/declaw/SKILL.md

echo "Version synced: package.json, openclaw.plugin.json, skills/declaw/SKILL.md"

# ── 3. Changelog check ───────────────────────────────────────────────────────

if ! grep -q "\[${VERSION}\]" CHANGELOG.md; then
  echo ""
  echo "Warning: CHANGELOG.md does not contain a [${VERSION}] section."
  read -p "Continue without changelog entry? (y/N) " -n 1 -r
  echo
  if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
    echo "Aborting. Update CHANGELOG.md and re-run."
    git checkout -- package.json package-lock.json openclaw.plugin.json skills/declaw/SKILL.md
    exit 1
  fi
fi

# ── 4. Create release branch + PR ────────────────────────────────────────────

RELEASE_BRANCH="release/v${VERSION}"

git checkout -b "$RELEASE_BRANCH"
git add -A
git commit -m "chore: release v${VERSION}"
git push -u origin "$RELEASE_BRANCH"

PR_URL=$(gh pr create \
  --base main \
  --head "$RELEASE_BRANCH" \
  --title "chore: release v${VERSION}" \
  --body "## Release v${VERSION}

### Version bump
- \`package.json\` → ${VERSION}
- \`openclaw.plugin.json\` → ${VERSION}
- \`skills/declaw/SKILL.md\` → ${VERSION}

### What happens on merge
CI (\`.github/workflows/release.yml\`) will automatically:
1. Create git tag \`v${VERSION}\`
2. Create GitHub Release (triggers npm publish)
3. Publish skill to ClawHub
4. Backmerge main → develop")

echo ""
echo "=== Release PR created ==="
echo "  ${PR_URL}"
echo ""
echo "Next steps:"
echo "  1. Wait for CI checks to pass"
echo "  2. Merge the PR (squash)"
echo "  3. CI handles: tag → GH Release → npm → ClawHub → backmerge"
echo ""

git checkout main
