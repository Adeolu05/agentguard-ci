# Architecture

```text
                   agentguard.yaml ── policy.yaml ── scenarios/**/*.yaml
                          │               │                │
                          ▼               ▼                ▼
 ┌──────────────┐   ┌───────────────────────────────────────────────┐
 │ @agentguard/ │   │ @agentguard/runner                             │
 │ cli          │──▶│  project + scenario loading (strict schemas)   │
 │  init/test/  │   │  runScenario: isolated clock, ledger, keys     │──▶ RunReport (JSON)
 │  report …    │   │  targets: engine │ custom module (shape-checked)│     │  + Markdown
 └──────────────┘   │  findings, severity, redaction                 │     │
                    └──────────────┬────────────────────────────────┘     ▼
                                   │                              .agentguard/runs/*.json
                                   ▼                                       │
                    ┌───────────────────────────────────┐                  ▼
                    │ @agentguard/core                   │       apps/web (read-only
                    │  amounts (BigInt)  policy schema   │        dashboard, validates
                    │  PolicyEngine: authorize / gate    │        every report)
                    │  Ledger (runExclusive) approvals   │
                    └──────────────┬────────────────────┘
                                   │ validators, beginExecution
                                   ▼
                    ┌───────────────────────────────────┐
                    │ @agentguard/near                   │
                    │  account-ID validator              │
                    │  NearTestnetExecutor ─▶ near-api-js│──▶ NEAR testnet RPC (opt-in)
                    └───────────────────────────────────┘
```

## Boundaries

- **`core`** has no file or network I/O. It imports only `zod`, `yaml` and `node:crypto`. It can be used as a library in an agent runtime, without the CLI or the dashboard.
- **`runner`** depends on `core`. It reads scenario and project files and never executes transactions.
- **`cli`** depends on `runner` (and loads `near` only when the project enables the integration). It does not depend on the dashboard.
- **`near`** depends on `core` and loads `near-api-js` lazily. It is only needed for NEAR validation or execution; ordinary unit tests never touch the network.
- **`apps/web`** depends on `runner` for the report schema and types. It is read-only: it has no mutations, no write paths and no execution.

## Runtime flow in a real agent

```ts
const evaluation = await engine.authorize(proposal);            // ALLOW / BLOCK / REQUIRE_APPROVAL
if (evaluation.decision === "REQUIRE_APPROVAL") {
  // ask a human; the approval service issues a grant bound to evaluation.proposalDigest
  // and to policy.hash, then resubmit the identical proposal with { approval: grant }
}
if (evaluation.decision === "ALLOW" && !evaluation.replay) {
  const gate = await engine.beginExecution(evaluation.reservation.reservationId);  // reserved → submitted
  if (gate.ok) {
    // sign and broadcast; then:
    await engine.recordOutcome(id, "confirmed" | "failed", { transactionReference });
    // on an ambiguous outcome do nothing: the reservation stays "submitted" and keeps counting
  }
}
```

AgentGuard protects only the paths that go through `authorize()` and `beginExecution()`. Keep the signing key in a component that refuses to sign without a successful `beginExecution()`. Never give it to the agent. See [threat-model.md](threat-model.md).

## Architecture decisions

| Decision | Rationale | Trade-off |
| --- | --- | --- |
| TypeScript, strict mode, ESM, pnpm monorepo | Matches the agent and web3 tooling ecosystem; one language across engine, CLI and dashboard. | Node 22.22 or newer (required by `near-api-js` 7). |
| `zod` 4 schemas with `strictObject` everywhere | Unknown keys fail instead of being ignored, and errors carry paths. | |
| `yaml` 2 with the core schema, unique keys and capped aliases | No custom tags or code execution; duplicate keys are errors; protects against "billion laughs" alias expansion. | |
| BigInt atomic units, decimal strings at the edges | Exact arithmetic, including 24-decimal yoctoNEAR. | JSON numbers are rejected outright, which is stricter than some callers expect. |
| `node:util.parseArgs` instead of a CLI framework | No dependency, and strict unknown-flag handling. | Help text is hand-written. |
| Run history as one JSON file per run (not SQLite) | No native modules; files are trivially uploaded as CI artifacts and read by the dashboard; one schema serves both. | No queries across thousands of runs. The dashboard reads at most the 500 most recent files. |
| In-memory ledger with a per-agent promise mutex as the reference implementation | Simple and deterministic, and correct for single-process use (CLI, tests, single-instance services). | **Multi-process deployments need a database-backed `Ledger`** (transaction plus row lock). The interface is designed for this, but none ships yet. |
| HMAC-SHA256 approval grants bound to the proposal digest and policy hash | Approvals cannot be replayed, transferred or reused after a policy change; verification is local and fast. | A symmetric key: the verifier can also issue. Keep the engine and the approval service in the same trust boundary, or move to asymmetric signatures later. |
| Fixed UTC offsets for daily windows | Deterministic 24-hour windows. | No IANA time zones, and no daylight-saving changes. |
| Scenarios with concrete expected values | A loosened policy makes scenarios fail, which is the point of CI. | Intentional limit changes must update scenarios in the same pull request. |
| `near-api-js` 7 (single package) for NEAR | It is the current maintained SDK; its README directs users of the older `@near-js/*` packages to migrate to it. | Only native NEAR transfers are supported (no fungible tokens yet). |
