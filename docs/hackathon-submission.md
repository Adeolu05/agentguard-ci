# NEAR HACKATHON submission

## Rules

These rules were confirmed by the project owner from the official NEAR HACKATHON rules.

| Item | Rule |
| --- | --- |
| Submission window | 1 Nov 2026, 00:00 UTC to **14 Nov 2026, 23:59 UTC** |
| Judging | 16 to 18 Nov 2026. The jury includes AI judges (Claude Code and Codex) that clone the repository and follow the README. |
| Submissions | One per team. A submission cannot be edited after it is sent. |
| Tracks for this entry | Primary: **06 AI Security & Defense**. Secondary: **07 Agent Economy**. |

## Required deliverables

| Requirement | Status |
| --- | --- |
| Public repository | Done: https://github.com/Adeolu05/agentguard-ci |
| README with "do X, see Y" steps an AI judge can follow | Done: [For judges: verify in 5 minutes](../README.md#for-judges-verify-in-5-minutes). Every command was run from a fresh clone on 2026-11-05 and the expected output is the real output. |
| Public X demo post that states the project was built at NEAR HACKATHON, with a video or screenshots | **To do (owner).** Screenshots are in `docs/images/` and the demo script is [demo.md](demo.md). |
| A mainnet NEAR account for the prize payout | **To do (owner).** Only the account ID is submitted. No mainnet key belongs anywhere in this repository, and nothing in it signs on mainnet. |
| "What did you build?" description, 20 to 2,000 characters, covering the problem, the implementation and NEAR's role | **Draft below** (1,613 characters, counted with `wc -m`). Covers the vault; to be revised after the LLM demo phase. |
| No secrets anywhere in the git history | **Pending** a full-history secret scan in the final audit. By design, keys are only read from environment variables, which `.env.example` documents with empty values. |

## "What did you build?" (draft)

```text
AgentGuard CI is an open-source security test suite for AI agents that can move money.

Problem: an agent with a wallet can be talked into paying the wrong account, paying twice after a retry, or overspending through parallel requests. Ordinary unit tests rarely cover these failures, and a policy change can quietly loosen a guardrail.

Implementation: a deterministic TypeScript policy engine (no LLM in the decision) evaluates every proposed payment against a YAML policy: per-transaction and daily limits, recipient and network allowlists, and human-approval thresholds. Amounts use exact integer arithmetic. Spending is reserved atomically, retries are idempotent, approvals are bound to the exact payment, and every error fails closed. A CLI runs 40 adversarial scenarios (prompt injection, boundary amounts, races, replayed approvals, malformed input) against that policy or against your own guard, writes reports, and exits non-zero so CI blocks unsafe changes. A read-only dashboard shows the results.

NEAR's role: the NEAR package validates NEAR account IDs (including mainnet accounts on testnet), enforces limits in exact 24-decimal yoctoNEAR, and executes only payments the engine authorised on NEAR testnet, behind an execution gate that refuses stale policies, never broadcasts twice and refuses to sign unless the RPC reports testnet. A NEAR smart contract, the AgentGuard Vault, holds the funds and enforces the same policy on-chain; the agent holds only a function-call key for one method, so even a compromised agent can only make payments the policy allows. Mainnet signing is not supported.
```

## Before sending (the submission cannot be edited)

1. `pnpm check` passes on the commit you submit, and CI is green on GitHub for that commit.
2. The README "For judges" steps still produce the documented output from a fresh clone.
3. The full-history secret scan is clean.
4. The README's [Live testnet run](../README.md#live-testnet-run) section holds a verified transaction, or clearly says that none was run.
5. The X post is public, states that the project was built at NEAR HACKATHON, and links the repository.
6. The payout account ID is a mainnet account you control.

## Checklist

### Core engine
- [x] Policy schema implemented and documented (`docs/policy-schema.md`)
- [x] Every mandatory policy rule has positive and negative automated tests (`packages/core/test/engine.test.ts`)
- [x] Exact arithmetic (BigInt atomic units; JSON numbers rejected)
- [x] Fail-closed behaviour tested (ledger unavailable, validator throws, no verifier)
- [x] Aggregate spending is safe under the supported concurrency model (single process), with a control experiment showing the race when the lock is removed
- [x] Idempotency tested, including concurrent duplicates
- [x] `REQUIRE_APPROVAL` is never treated as an authorisation (nothing reserved; the gate refuses)

### Scenario runner
- [x] 40 executable built-in scenarios, plus 6 NEAR scenarios
- [x] Scenarios are schema-validated, including references between steps
- [x] `PASS`, `FAIL`, `ERROR` and `SKIPPED` are distinct; an all-skipped run is not a pass
- [x] Reports show expected and observed outcomes per step
- [x] Correct exit codes (0, 1, 2, 3), tested against the built binary

### CLI and CI
- [x] Quick-start works in a clean directory (`agentguard init`, `policy validate`, `test`)
- [x] Help and error messages include file, line and field locations
- [x] JSON and Markdown reports
- [x] GitHub Actions workflows run on GitHub ([Actions](https://github.com/Adeolu05/agentguard-ci/actions))
- [x] An intentional policy violation makes the suite exit with code 1, locally and in the CI `regression-gate` job

### Dashboard
- [x] Data comes only from CLI reports (schema-validated); demo fixtures are generated by the real CLI and labelled
- [x] Run details and findings are inspectable
- [x] Error and empty states; invalid report files are surfaced
- [x] No fabricated metrics (pass rate is `n/a` when a run is incomplete)
- [x] Responsive layout and accessibility audited (no page overflow from 320 px to 2560 px, 0 axe-core WCAG 2.2 AA violations)

### NEAR integration
- [x] SDK calls verified against the official NEAR docs source (`github.com/near/docs`, commit `fa2acf6`) and the published `near-api-js@7.4.0` types
- [x] Runtime exercised against the real `near-api-js` library and a local RPC stub
- [x] Simulation and testnet execution are clearly separated (execution is off unless `AGENTGUARD_NEAR_EXECUTION=testnet`)
- [x] No private keys are committed or exposed
- [x] Blocked proposals make no RPC request; at most one broadcast per reservation (near-api-js retry layers neutralised)
- [x] Integration limitations documented (`docs/integrations.md`)
- [ ] Live testnet run recorded and verified against the network (see the README's [Live testnet run](../README.md#live-testnet-run))

### AgentGuard Vault (NEAR contract)
- [x] Contract in Rust (`near-sdk` 5.30.0), built with `cargo-near` 0.22.0; design and threat model in [vault-design.md](vault-design.md)
- [x] The agent holds only a function-call key for `request_payment`; owner methods need the owner and exactly 1 yoctoNEAR
- [x] 40 unit tests and 30 tests on a local NEAR node; 16 of the 40 built-in scenarios pass against the contract and 24 are skipped with reasons
- [x] Expired approval requests cannot jam the 50-slot approval queue (review fix, with unit and sandbox tests)
- [x] CI job defined (`vault` in `.github/workflows/ci.yml`)
- [ ] CI job has run on GitHub (it runs on pull requests and `main` only)
- [ ] Deployed and exercised on testnet

### LLM prompt-injection demo
- [x] Agent loop with a poisoned page, every proposal through `authorize()` (`examples/llm-agent`), 12 offline tests
- [x] NEAR AI Cloud API checked against the official docs (base URL, key, request format, models, response signatures, attestation)
- [x] Optional vault mode on a local NEAR node prints the on-chain rejection event
- [ ] A real NEAR AI Cloud run recorded (needs the owner's API key); the shipped recording is a labelled stand-in

### Project delivery
- [x] Repository is public
- [x] README with a working quick-start and the "For judges" steps
- [x] Architecture and threat model documented
- [x] License (Apache-2.0)
- [x] Environment variables documented without values (`.env.example`)
- [x] Demo instructions are reproducible ([demo.md](demo.md))
- [x] Dashboard screenshots of a real CLI run (`docs/images/`)
- [ ] Full-history secret scan clean
- [ ] Public X demo post
- [ ] Mainnet payout account ID
- [ ] Submission sent before 14 Nov 2026, 23:59 UTC

## Demo script

See [demo.md](demo.md): a three-minute script with the real output of every command. It will be extended to cover the live testnet run, the guarded vault and the LLM attack demo once those exist and have been verified.

## Evidence to include

- `pnpm check` output (all tests passing).
- A CI run link from https://github.com/Adeolu05/agentguard-ci/actions.
- JSON and Markdown reports from the demo.
- Dashboard screenshots (`docs/images/`).
- A NEAR testnet transaction hash and explorer link, **only** if a run was actually executed and verified against the network.
