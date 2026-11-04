#!/usr/bin/env bash
# Regenerates apps/web/demo-runs/ by running the real AgentGuard CLI against the bundled
# examples. Every demo report is genuine CLI output; nothing is hand-written.
# Usage (from the repository root, after `pnpm build`): bash apps/web/scripts/generate-demo-runs.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$ROOT/apps/web/demo-runs"
CLI="node $ROOT/packages/cli/dist/bin.js"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
rm -rf "$OUT" && mkdir -p "$OUT"

save() { # save <json-file>
  local id
  id="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runId)' "$1")"
  mv "$1" "$OUT/$id.json"
}

run() { # run <label> <config> ; tolerate non-zero exit codes (failures are the point of some demos)
  echo "== $1"
  $CLI test --config "$2" --no-save --no-color --quiet --json "$WORK/r.json" >/dev/null || true
  save "$WORK/r.json"
  sleep 1
}

# 1. Baseline: default payment policy, all scenarios pass.
run "baseline" "$ROOT/examples/payment-policy/agentguard.yaml"

# 2. Regression: a policy change allowlists an attacker and raises the per-transaction limit.
# The copy sits next to the original so scenario paths in the report stay repository-relative.
REGRESSED="$ROOT/examples/.demo-regressed"
rm -rf "$REGRESSED" && cp -r "$ROOT/examples/payment-policy" "$REGRESSED"
trap 'rm -rf "$WORK" "$REGRESSED"' EXIT
sed -i.bak -e 's/    - data-provider-example/    - data-provider-example\n    - attacker-wallet/' \
  -e 's/max_transaction_amount: "25"/max_transaction_amount: "250"/' "$REGRESSED/policy.yaml"
run "regression" "$REGRESSED/agentguard.yaml"

# 3. Fixed again.
run "fixed" "$ROOT/examples/payment-policy/agentguard.yaml"

# 4. A hand-rolled guard tested as a custom target (fails, with skipped scenarios).
run "naive guard" "$ROOT/examples/basic-agent/agentguard.yaml"

# 5. NEAR testnet policy suite (offline; no transactions).
run "near" "$ROOT/examples/near-testnet/agentguard.yaml"

ls -1 "$OUT"
