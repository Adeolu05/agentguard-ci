# CLI reference

```text
agentguard init [dir] [--force] [--github-actions]
agentguard policy validate [policy.yaml] [--config <file>]
agentguard scenarios validate [--config <file>]
agentguard scenarios list [--category <c>] [--config <file>]
agentguard test [--scenario <id>]... [--category <c>]... [options]
agentguard report [--run <id>] [--format markdown|json] [--output <file>] [--config <file>]
agentguard --version | --help
```

The CLI works without an account, telemetry, network access or paid services. It is non-interactive and safe to run in CI. Colours are disabled when stdout is not a TTY, when `NO_COLOR` is set, or when `--no-color` is passed.

## Project file (`agentguard.yaml`)

```yaml
version: 1
name: Research Payment Agent          # optional, shown in reports
policy: policies/default.yaml         # relative to this file
scenarios:                            # one or more directories, searched recursively
  - scenarios
target:
  type: engine                        # or: type: module, module: ./guard.mjs
integrations:                         # optional
  near:
    validate_account_ids: true        # add NEAR account-ID validation to the engine
reports:
  dir: .agentguard/runs               # default
```

Unknown keys are rejected. `--config` selects another project file. The default is `./agentguard.yaml`.

## Commands

**`init`** copies a runnable project into `dir` (default `.`): the project file, a default policy and the 40 built-in scenarios. It refuses to overwrite existing files unless you pass `--force`. `--github-actions` also writes `.github/workflows/agentguard.yml`.

**`policy validate`** validates a policy file (by default, the project's policy) and prints its hash, assets, networks and warnings. Errors include `file:line:column field: message`.

**`scenarios validate` / `scenarios list`** load and validate every scenario. They also check that every `policy_patch` produces a valid policy.

**`test`** validates everything first; if anything is invalid it exits with code 2 and runs nothing. It then runs the selected scenarios and prints one line per scenario, a summary and the findings. It writes the JSON report to `<reports.dir>/<runId>.json` and creates a `.gitignore` there.

| Option | Effect |
| --- | --- |
| `--scenario <id>` | Run only this scenario. Repeatable. An unknown ID is a usage error. |
| `--category <c>` | Run only this category. Repeatable. |
| `--json <file>` | Also write the JSON report to this file. |
| `--markdown <file>` | Also write the Markdown report to this file. |
| `--github-summary` | Append the Markdown report to `$GITHUB_STEP_SUMMARY`, if that variable is set. |
| `--no-save` | Do not store the run in `reports.dir`. |
| `--quiet` | Print only non-passing scenarios and the summary. |

**`report`** renders the latest stored run (or `--run <id>`) as Markdown (the default) or JSON, to stdout or `--output`. The stored JSON is re-validated against the report schema before rendering.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | All required scenarios passed. |
| 1 | At least one required scenario **failed**. This takes precedence over errors, because a confirmed violation is the most actionable signal. |
| 2 | Configuration, scenario validation or usage error. Nothing was run. |
| 3 | No required scenario failed, but at least one **errored**, or nothing was evaluated at all (for example, every scenario was skipped). The run is incomplete. Unexpected internal errors also exit with 3. |

Non-required scenarios (`required: false`) are reported but never affect the exit code.

## JSON report

The schema is `runReportSchema` in `packages/runner/src/report.ts`; the dashboard validates against the same schema. Its main fields are:

- `runId`, `startedAt`, `completedAt`, `durationMs`;
- `status` (`PASSED`, `FAILED` or `ERROR`) and `exitCode`;
- `agentguardVersion`;
- `executionMode`, which is always `simulation` for scenario runs;
- `policy`: `file`, `hash`, `agentId`, `declaredExecutionMode`, `warnings` and the validated `document`;
- `suite`: `hash` and `scenarioCount` (the hash covers every scenario definition);
- `filters`, `target` and `integrations`;
- `environment`: Node version, platform, CI flag, and `GITHUB_SHA` and `GITHUB_REF` when set;
- `summary`: counts, plus `passRate`, which is `null` when nothing was evaluated or a required scenario errored;
- `scenarios[]`: per-step expected and observed results;
- `findings[]`.

The policy hash, suite hash, scenario definition hashes and AgentGuard version identify exactly what ran, so a run can be reproduced.

## Redaction

Reports and printed results are redacted before they are written. The redaction:

- replaces the values of keys that look sensitive (`privateKey`, `secret`, `password`, `apiKey`, `token`, `authorization`, `mnemonic` and similar);
- replaces credential-shaped strings: NEAR or curve-prefixed private keys, PEM private keys, `sk-…` API keys, GitHub and Slack tokens, and JWTs;
- replaces the exact values of environment variables whose names look secret.

Policies and scenarios never need secrets, and the runner never handles signing keys. Redaction is defence in depth against a custom target that echoes credentials into an error message.
