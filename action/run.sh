#!/usr/bin/env bash
# Step 2 of the Drainproof GitHub Action (action.yml): validates the policy and scenarios, runs
# the suite, writes the reports and sets the step outputs. Runs in the caller's working
# directory. Inputs arrive as environment variables (never interpolated into this script).
# The step exits with Drainproof's own exit code, so a failed scenario fails the job.
set -uo pipefail

ACTION_PATH="${DRAINPROOF_ACTION_PATH:?DRAINPROOF_ACTION_PATH is not set}"
CLI=(node "$ACTION_PATH/packages/cli/dist/bin.js")
OUTPUT_FILE="${GITHUB_OUTPUT:-/dev/null}"

finish() { # finish <exit-code> <status> [report-json] [report-markdown]
  {
    echo "exit-code=$1"
    echo "status=$2"
    echo "report-json=${3:-}"
    echo "report-markdown=${4:-}"
  } >> "$OUTPUT_FILE"
  exit "$1"
}

GENERATED=""
cleanup() { if [ -n "$GENERATED" ]; then rm -f "$GENERATED"; fi; }
trap cleanup EXIT

if [ -n "${DRAINPROOF_POLICY:-}" ]; then
  if [ ! -f "$DRAINPROOF_POLICY" ]; then
    echo "::error::policy file not found: $DRAINPROOF_POLICY (relative to $(pwd))"
    finish 2 INVALID
  fi
  # A temporary project file: your policy, the 40 built-in scenarios, the built-in engine.
  # JSON is valid YAML, and JSON.stringify quotes every path safely.
  GENERATED="$(pwd)/.drainproof-action-$$.yaml"
  node -e '
    const [policy, scenarios, name] = process.argv.slice(1);
    const project = { version: 1, name, policy, scenarios: [scenarios], target: { type: "engine" }, reports: { dir: ".drainproof/runs" } };
    process.stdout.write(JSON.stringify(project, null, 2) + "\n");
  ' "$DRAINPROOF_POLICY" "$ACTION_PATH/packages/cli/templates/scenarios" "${GITHUB_REPOSITORY:-Drainproof GitHub Action}" > "$GENERATED"
  CONFIG="$GENERATED"
  echo "Policy: $DRAINPROOF_POLICY, with the 40 built-in scenarios"
elif [ -n "${DRAINPROOF_CONFIG:-}" ]; then
  CONFIG="$DRAINPROOF_CONFIG"
elif [ -f drainproof.yaml ]; then
  CONFIG="drainproof.yaml"
else
  echo "::error::set the policy input (a policy YAML file) or the config input (a drainproof.yaml project file)"
  finish 2 INVALID
fi

"${CLI[@]}" policy validate --config "$CONFIG" || finish 2 INVALID
"${CLI[@]}" scenarios validate --config "$CONFIG" || finish 2 INVALID

REPORT_DIR="${DRAINPROOF_REPORT_DIR:-drainproof-report}"
mkdir -p "$REPORT_DIR"
REPORT_DIR="$(cd "$REPORT_DIR" && pwd)"
JSON="$REPORT_DIR/drainproof-report.json"
MD="$REPORT_DIR/drainproof-report.md"
rm -f "$JSON" "$MD"

ARGS=(test --config "$CONFIG" --no-color --no-save --json "$JSON" --markdown "$MD")
if [ "${DRAINPROOF_GITHUB_SUMMARY:-true}" = "true" ] && [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  ARGS+=(--github-summary)
fi

"${CLI[@]}" "${ARGS[@]}"
CODE=$?

case "$CODE" in
  0) STATUS=PASSED ;;
  1) STATUS=FAILED ;;
  2) STATUS=INVALID ;;
  *) STATUS=INCOMPLETE ;;
esac
if [ "$CODE" -eq 1 ]; then
  echo "::error::Drainproof: a required scenario failed. This change would weaken the agent's money policy. See the job summary or $MD."
fi
if [ -f "$JSON" ]; then finish "$CODE" "$STATUS" "$JSON" "$MD"; fi
finish "$CODE" "$STATUS"
