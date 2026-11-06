#!/usr/bin/env bash
# Step 1 of the Drainproof GitHub Action (action.yml): installs and builds the Drainproof CLI
# inside the action's own checkout ($DRAINPROOF_ACTION_PATH). Nothing is installed into the
# caller's repository. pnpm is run at the exact version pinned in package.json through
# `npm exec`, so the caller's own package manager setup is not touched.
set -euo pipefail
cd "${DRAINPROOF_ACTION_PATH:?DRAINPROOF_ACTION_PATH is not set}"

node -e '
  const [maj, min, pat] = process.versions.node.split(".").map(Number);
  const ok = maj > 22 || (maj === 22 && (min > 22 || (min === 22 && pat >= 2)));
  if (!ok) { console.error(`Drainproof needs Node.js 22.22.2 or newer; found ${process.versions.node}. Set the node-version input.`); process.exit(1); }
'

PNPM_SPEC="$(node -p 'require("./package.json").packageManager')"
case "$PNPM_SPEC" in
  pnpm@[0-9]*) ;;
  *) echo "Unexpected packageManager field: $PNPM_SPEC" >&2; exit 1 ;;
esac
pnpm() { npm exec --yes --package="$PNPM_SPEC" -- pnpm "$@"; }

echo "Installing Drainproof's packages with $PNPM_SPEC (frozen lockfile)"
pnpm install --frozen-lockfile --filter drainproof-monorepo --filter "./packages/*"
pnpm --filter "./packages/*" build
node packages/cli/dist/bin.js --help | head -1
