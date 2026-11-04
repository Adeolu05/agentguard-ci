# AgentGuard CI

**Test what your AI agent is allowed to do before trusting it with the ability to move money.**

AgentGuard CI is an open-source security testing toolkit for AI agents that can initiate financial transactions. You describe a transaction policy in YAML, for example limits, recipient and network allowlists, and approval thresholds. AgentGuard then runs a suite of adversarial scenarios against it: boundary amounts, injected instructions, malformed input, replayed approvals, concurrent spending and retries. It reports exactly which security properties hold and which do not. It runs locally and in CI, needs no account, LLM or blockchain, and fails the build when a policy or guard regresses.

AgentGuard is **not** a wallet, a custody service or a trading bot. It never signs or sends a transaction during a test run. It is a deterministic policy engine plus a testing layer.

```text
$ agentguard test --quiet      # after someone added "attacker-wallet" to the recipient allowlist
AgentGuard CI 0.1.0
Policy:   policies/default.yaml (sha256:9736d3b8b31f…)
Target:   AgentGuard engine
Mode:     simulation (scenario runs never sign or send transactions)
Running 40 scenarios

FAIL    instruction-injection-in-memo
         step 1: expected BLOCK, observed ALLOW

Summary
  Scenarios: 40
  Passed:    39
  Failed:    1
  Errors:    0
  Skipped:   0

Findings
  [CRITICAL] Instruction injection cannot override deterministic policy rules: expected BLOCK, observed ALLOW

Result: FAILED  (exit code 1)
```

## What is in the box

| Component | Package | Status |
| --- | --- | --- |
| Deterministic policy engine: exact BigInt amounts, strict schema, stable reason codes, fail-closed | `@agentguard/core` | Implemented, tested |
| Spending ledger: atomic per-agent reservations, idempotency, lifecycle, daily windows | `@agentguard/core` | Implemented, tested (single-process reference ledger) |
| Approvals bound to the exact proposal and policy version (HMAC), with expiry and single use | `@agentguard/core` | Implemented, tested |
| Scenario runner: multi-step scenarios, concurrency, PASS/FAIL/ERROR/SKIPPED, custom guard targets | `@agentguard/runner` | Implemented, tested |
| 40 built-in security scenarios in 6 categories | `packages/cli/templates/scenarios` | Implemented, all executable |
| CLI: `init`, `policy validate`, `scenarios validate\|list`, `test`, `report` | `@agentguard/cli` | Implemented, tested |
| JSON and Markdown reports with findings, severity rationale and redaction | `@agentguard/runner` | Implemented, tested |
| GitHub Actions: repository CI and a user workflow template (actions pinned to SHAs) | `.github/workflows` | Running on GitHub; every job passed on the first run |
| Read-only web dashboard over CLI reports | `apps/web` | Implemented, data layer tested, visually checked |
| NEAR: account-ID validation, testnet executor behind the execution gate | `@agentguard/near` | Implemented, tested against a local RPC stub. **Not yet run against live testnet** |

## Quick start

Requirements: Node.js 22.22 or newer, and pnpm 10.

The packages are not yet published to npm. Run them from this repository:

```bash
git clone https://github.com/Adeolu05/agentguard-ci.git && cd agentguard-ci
pnpm install
pnpm build
```

Create a project and run the suite. The CLI binary is `packages/cli/dist/bin.js`; the alias below just shortens it.

```bash
alias agentguard="node $PWD/packages/cli/dist/bin.js"
mkdir /tmp/my-agent && cd /tmp/my-agent
agentguard init
agentguard policy validate
agentguard test
```

All 40 scenarios pass and the command exits with code 0. Now make the policy unsafe and run it again:

```bash
sed -i 's/max_transaction_amount: "25"/max_transaction_amount: "2500"/' policies/default.yaml
agentguard test --quiet        # exit code 1, with a CRITICAL finding for tx-limit-one-unit-above-maximum
agentguard report              # Markdown report of the latest run
```

## How it works

1. **Policy** (`policies/default.yaml`): limits per asset, a daily window, recipient, network and asset allowlists, and an approval threshold. It is validated strictly: unknown keys, unquoted numbers and excess precision are all errors. See [docs/policy-schema.md](docs/policy-schema.md).
2. **Engine**: `PolicyEngine.authorize(proposal)` returns `ALLOW`, `BLOCK` or `REQUIRE_APPROVAL` with reason codes. `ALLOW` atomically reserves budget in the ledger. `REQUIRE_APPROVAL` is never an authorisation. The engine never executes anything; adapters call `beginExecution()`, which is the execution gate.
3. **Scenarios** (`scenarios/**/*.yaml`): each one encodes a security property as steps such as propose, approve, advance time, execute, record outcome, run concurrently, reload the policy and assert ledger state. Because the expected outcomes are concrete, *loosening the policy makes the relevant scenarios fail*. That is how CI catches unsafe policy changes. See [docs/scenarios.md](docs/scenarios.md).
4. **Targets**: by default the scenarios run against AgentGuard's own engine with your policy. To test **your own guard implementation** instead, point `target.module` at an ES module that exports `createTarget()` ([example](examples/basic-agent)).
5. **Reports**: `.agentguard/runs/<runId>.json`, optional `--json` and `--markdown` outputs, and findings with severity, reproduction steps and remediation. See [docs/cli.md](docs/cli.md) and [docs/findings.md](docs/findings.md).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | All required scenarios passed |
| 1 | At least one required scenario failed |
| 2 | Configuration, scenario validation or usage error; nothing was run |
| 3 | Run incomplete: a required scenario errored, or nothing could be evaluated (for example, everything was skipped) |

An infrastructure error or a skipped scenario is never counted as a pass.

## CI

Run `agentguard init --github-actions` to add `.github/workflows/agentguard.yml`. It uses read-only permissions and actions pinned to commit SHAs, validates the policy and scenarios, runs the suite, writes a job summary and uploads the reports. It assumes `@agentguard/cli` is a dev dependency, which requires publishing the package first. Until then, [this repository's CI](.github/workflows/ci.yml) shows the same steps run from source. It includes a `regression-gate` job that deliberately allowlists an attacker and requires the suite to exit with code 1.

## Dashboard

```bash
pnpm dashboard:demo                       # bundled demo reports (labelled as demo data)
AGENTGUARD_RUNS_DIR=/tmp/my-agent/.agentguard/runs \
AGENTGUARD_PROJECT=/tmp/my-agent/agentguard.yaml \
  pnpm --filter @agentguard/web dev       # your own runs, at http://localhost:3000
```

The dashboard is read-only. Every report is validated against the same schema the CLI writes; unreadable files are listed as such, never shown as results. The demo fixtures are produced by [a script](apps/web/scripts/generate-demo-runs.sh) that runs the real CLI.

## NEAR integration

- `@agentguard/near` validates NEAR account IDs, including cross-network mistakes such as a `*.near` recipient on testnet, and handles 24-decimal yoctoNEAR amounts exactly. The [NEAR example suite](examples/near-testnet) passes offline.
- `NearTestnetExecutor` executes **only** reservations that AgentGuard authorised. It goes through the execution gate, which blocks double execution and stale policy versions, and it refuses to sign unless the RPC reports `testnet`. It records a transaction hash only when the network returned one, and leaves ambiguous outcomes as `submitted` so they keep counting toward limits.
- **Verification status:** the executor was exercised with `near-api-js@7.4.0` against a local JSON-RPC stub. The stub checks that the signed transaction decodes to the right receiver and exact amount and that the ed25519 signature verifies. It has **not** been run against live NEAR testnet, because the build environment could not reach NEAR endpoints. No on-chain transaction is claimed. See [docs/integrations.md](docs/integrations.md) for how to run it with your own testnet account.

## Project status

Verified in the build environment (Node 22.23, Linux):

- `pnpm check` runs lint, build, the dashboard build, typecheck and 215 automated tests, and all of it passes.
- The CLI quick-start works, an intentional policy violation exits with code 1, and the example suites pass.
- Policy evaluation averages 25 to 35 µs (p99 under 0.2 ms) on a 2.1 GHz Xeon, against a target of under 10 ms. The 40-scenario suite takes about 20 ms in the runner, or about 0.3 s wall time including Node startup.

- GitHub Actions: all four CI jobs (checks, example suites, regression gate, dashboard build) [pass on GitHub](https://github.com/Adeolu05/agentguard-ci/actions).
- An independent adversarial review of the engine, runner and NEAR executor found 7 defects plus 2 fail-open edge cases. All are fixed, each with a regression test that reproduces the original attack (`packages/*/test/regressions.test.ts` and the NEAR tests).

Not yet verified:

- Live NEAR testnet execution.
- The NEAR hackathon rules (`nearhackathon.com` was not reachable from the build environment). Check the deadline and requirements yourself before submitting; see [docs/hackathon-submission.md](docs/hackathon-submission.md).

## Limitations

Passing the suite shows that the tested behaviours hold under the tested conditions. It is **not** proof that an agent, wallet or payment flow is secure in general. AgentGuard only protects what passes through it: if your agent can reach a signing key without going through `authorize()` and `beginExecution()`, nothing here stops it. The reference ledger is single-process. Read [docs/limitations.md](docs/limitations.md) and [docs/threat-model.md](docs/threat-model.md) before relying on it.

## Documentation

- [Architecture](docs/architecture.md)
- [Policy schema and decision semantics](docs/policy-schema.md)
- [Scenarios and custom targets](docs/scenarios.md)
- [CLI and reports](docs/cli.md)
- [Findings and severity](docs/findings.md)
- [Threat model](docs/threat-model.md)
- [Integrations (NEAR)](docs/integrations.md)
- [Limitations](docs/limitations.md)
- [Hackathon submission checklist and demo script](docs/hackathon-submission.md)
- [Implementation assessment](docs/assessment.md)

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Licensed under [Apache-2.0](LICENSE).
