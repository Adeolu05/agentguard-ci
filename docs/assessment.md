# Implementation assessment (Stage 0)

Date: 2026-11-04 (external-requirements table updated 2026-11-05)

## Current repository state

The working directory was empty (no Git history, no source files). Drainproof is being built from scratch in this repository.

Toolchain: Node.js 22.23, pnpm 10.28.

## Verification of external requirements

| Source | Status | Notes |
| --- | --- | --- |
| NEAR HACKATHON rules | **Confirmed** by the project owner from the official rules. | Submission window, judging dates, tracks and required deliverables are listed in [hackathon-submission.md](hackathon-submission.md). |
| NEAR documentation | **Verified** against the official documentation source, `github.com/near/docs` (commit `fa2acf6`, 2026-11-05). | `tools/near-api.mdx` (provider, account and transfer examples, `viewTransactionStatus`), `protocol/accounts-contracts/account-id.mdx` (account-ID rules) and `getting-started/faucet.mdx` (testnet faucets). These pages are unchanged since commit `e2d2ea1`, where they were first checked. |
| `near-api-js@7.4.0` (npm registry) | **Verified at the type level.** The published `.d.ts` files and README were inspected. | `Account(accountId, provider, signer)`, `Account.transfer({ receiverId, amount })` returns `RpcTransactionResponse`, and `JsonRpcProvider.viewTransactionStatus({ txHash, accountId, waitUntil })`. Requires Node >= 22.22.2. |
| Live NEAR testnet run | **Pending.** | No on-chain transaction has been executed or is claimed. The README's "Live testnet run" section records the evidence once a run has been checked against the network. |

## Proposed architecture

A pnpm TypeScript monorepo (strict mode, ESM):

- `packages/core` (`@drainproof/core`): exact amounts (BigInt), the strict policy schema (zod), the deterministic policy engine, the ledger interface and a reference in-memory ledger with atomic reservation, and approvals bound to the proposal digest and policy hash. It has no I/O beyond what the caller injects.
- `packages/runner` (`@drainproof/runner`): the project config, the scenario schema and loader, the scenario runner (steps, concurrency, isolation), target adapters (the built-in engine or a developer's own guard module), the report model, findings, redaction, and JSON/Markdown rendering.
- `packages/cli` (`@drainproof/cli`): the `drainproof` binary with `init`, `policy validate`, `scenarios validate`, `test`, `report` and `list`. It also ships the built-in scenario library and project templates.
- `packages/near` (`@drainproof/near`): NEAR account-ID validation, yoctoNEAR handling, and an execution adapter built on `near-api-js` that sits behind an explicit authorisation boundary and is disabled by default.
- `apps/web`: a read-only Next.js dashboard that reads the JSON run reports written by the CLI.

Run history is persisted as one JSON report file per run (`.drainproof/runs/<runId>.json`). The CLI and the dashboard share this file contract, validated with the same zod schema. SQLite was considered and deferred. Files are enough for local history, need no native modules, and are trivially uploadable as CI artifacts.

## Critical technical uncertainties

1. Hackathon rules and deadline: since confirmed (see [hackathon-submission.md](hackathon-submission.md)).
2. The NEAR execution path: written against the verified `near-api-js` types, but not exercised against testnet. It must be run end-to-end before any on-chain claim is made.
3. Production ledger concurrency: the reference ledger serialises reservations per agent within a single process. A multi-process deployment needs a database-backed ledger with transactional row locking. The interface supports this, but it is not implemented.

## Smallest viable end-to-end implementation

`drainproof init` → `drainproof policy validate` → `drainproof test` produces a terminal summary, a JSON report and a Markdown report with findings. A deliberately loosened policy makes `drainproof test` exit with code 1, and GitHub Actions fails on it.

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
