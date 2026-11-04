# Implementation assessment (Stage 0)

Date: 2026-11-04

## Current repository state

The working directory was empty (no Git history, no source files). AgentGuard CI is being built from scratch in this repository.

Toolchain in the build environment: Node.js 22.23, pnpm 10.28.

## Verification of external requirements

| Source | Status | Notes |
| --- | --- | --- |
| `https://nearhackathon.com/HACKATHON.md` | **Not verified.** The host was refused by the build environment's network policy. | The deadline, tracks and submission requirements are **unconfirmed**. They must be checked manually before submission. Nothing in this repo assumes specific hackathon rules. |
| `https://docs.near.org` | **Not verified.** The host was refused by the network policy. | Integration decisions rely on the published package below instead. |
| `near-api-js@7.4.0` (npm registry) | **Verified at the type level.** The published `.d.ts` files and README were inspected. | `Account(accountId, provider, signer)`, `Account.transfer({ receiverId, amount })` returns `RpcTransactionResponse`, and `JsonRpcProvider.viewTransactionStatus({ txHash, accountId, waitUntil })`. Requires Node >= 22.22.2. |
| NEAR testnet RPC | **Not reachable** from the build environment. | No on-chain transaction was executed. None is claimed. |

## Proposed architecture

A pnpm TypeScript monorepo (strict mode, ESM):

- `packages/core` (`@agentguard/core`): exact amounts (BigInt), the strict policy schema (zod), the deterministic policy engine, the ledger interface and a reference in-memory ledger with atomic reservation, and approvals bound to the proposal digest and policy hash. It has no I/O beyond what the caller injects.
- `packages/runner` (`@agentguard/runner`): the project config, the scenario schema and loader, the scenario runner (steps, concurrency, isolation), target adapters (the built-in engine or a developer's own guard module), the report model, findings, redaction, and JSON/Markdown rendering.
- `packages/cli` (`@agentguard/cli`): the `agentguard` binary with `init`, `policy validate`, `scenarios validate`, `test`, `report` and `list`. It also ships the built-in scenario library and project templates.
- `packages/near` (`@agentguard/near`): NEAR account-ID validation, yoctoNEAR handling, and an execution adapter built on `near-api-js` that sits behind an explicit authorisation boundary and is disabled by default.
- `apps/web`: a read-only Next.js dashboard that reads the JSON run reports written by the CLI.

Run history is persisted as one JSON report file per run (`.agentguard/runs/<runId>.json`). The CLI and the dashboard share this file contract, validated with the same zod schema. SQLite was considered and deferred. Files are enough for local history, need no native modules, and are trivially uploadable as CI artifacts.

## Critical technical uncertainties

1. Hackathon rules and deadline: unverified (network policy).
2. The NEAR execution path: written against the verified `near-api-js` types, but not exercised against testnet. It must be run end-to-end before any on-chain claim is made.
3. Production ledger concurrency: the reference ledger serialises reservations per agent within a single process. A multi-process deployment needs a database-backed ledger with transactional row locking. The interface supports this, but it is not implemented.

## Smallest viable end-to-end implementation

`agentguard init` → `agentguard policy validate` → `agentguard test` produces a terminal summary, a JSON report and a Markdown report with findings. A deliberately loosened policy makes `agentguard test` exit with code 1, and GitHub Actions fails on it.

## Scope

Completed in this iteration (verified by tests):

- The core engine.
- The ledger with idempotency and concurrency control.
- Approvals.
- The scenario runner.
- At least 30 built-in scenarios.
- The CLI and reports.
- CI workflows.
- The dashboard.
- NEAR account validation and the adapter with a mocked provider.

Deferred:

- A database-backed ledger.
- SARIF output.
- IANA time zones for daily windows (only fixed UTC offsets are supported).
- Hosted dashboard persistence.
- Live testnet verification.
- Additional agent framework adapters.

## Testing approach

- Vitest unit tests per module, including negative cases for every mandatory rule.
- Property-based tests (fast-check) for amount parsing and the engine's monotonicity invariants.
- A concurrency test that also shows that an *unlocked* ledger is exploitable, so the test is meaningful.
- CLI end-to-end tests: init, validate, test, an intentional violation leading to exit 1, malformed config leading to exit 2, and checks on the report contents.
- NEAR adapter tests with an injected fake provider (no network).
