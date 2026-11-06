#!/usr/bin/env bash
# Build installable tarballs of the Drainproof packages, for use in another project before
# the packages are published to npm. See docs/adoption.md.
# Usage: pnpm pack:local [output-dir]   (default: ./dist-packages)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mkdir -p "${1:-$ROOT/dist-packages}" && cd "${1:-$ROOT/dist-packages}" && pwd)"
pnpm --dir "$ROOT" build >/dev/null
rm -f "$OUT"/drainproof-*.tgz
for p in core runner cli near; do
  (cd "$ROOT/packages/$p" && pnpm pack --pack-destination "$OUT" >/dev/null)
done
ls -1 "$OUT"/drainproof-*.tgz
cat <<MSG

In your project (copy the tarballs into it first, e.g. vendor/drainproof/):
  npm install -D ./vendor/drainproof/drainproof-core-*.tgz ./vendor/drainproof/drainproof-runner-*.tgz ./vendor/drainproof/drainproof-cli-*.tgz
Add ./vendor/drainproof/drainproof-near-*.tgz only if you enable integrations.near.
MSG
