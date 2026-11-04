#!/usr/bin/env bash
# Build installable tarballs of the AgentGuard packages, for use in another project before
# the packages are published to npm. See docs/adoption.md.
# Usage: pnpm pack:local [output-dir]   (default: ./dist-packages)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mkdir -p "${1:-$ROOT/dist-packages}" && cd "${1:-$ROOT/dist-packages}" && pwd)"
pnpm --dir "$ROOT" build >/dev/null
rm -f "$OUT"/agentguard-*.tgz
for p in core runner cli near; do
  (cd "$ROOT/packages/$p" && pnpm pack --pack-destination "$OUT" >/dev/null)
done
ls -1 "$OUT"/agentguard-*.tgz
cat <<MSG

In your project (copy the tarballs into it first, e.g. vendor/agentguard/):
  npm install -D ./vendor/agentguard/agentguard-core-*.tgz ./vendor/agentguard/agentguard-runner-*.tgz ./vendor/agentguard/agentguard-cli-*.tgz
Add ./vendor/agentguard/agentguard-near-*.tgz only if you enable integrations.near.
MSG
