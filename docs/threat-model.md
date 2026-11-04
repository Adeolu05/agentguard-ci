# Threat model

## Scope

AgentGuard evaluates **proposed** financial actions against an explicit policy, records authorised spending, and gates execution. It also tests that this behaviour, or the behaviour of a guard you wrote, matches a security specification (the scenarios). This document covers the engine, the ledger, approvals, the execution gate, the CLI and runner, reports, the dashboard and the NEAR adapter.

## Assets

| Asset | Where it lives |
| --- | --- |
| Signing material (wallet keys) | Outside AgentGuard. Only the NEAR executor touches a key: a **testnet** key from the environment, kept inside a closure. |
| Approval signing key | The approval service. The engine holds a verifier. |
| API credentials and CI secrets | The CI secret store. Never read by scenarios or written to reports. |
| Policy configuration | YAML in the repository, under code review. |
| Approval records and ledger state | The ledger implementation. |
| Transaction integrity (amount, recipient, network, asset) | The proposal digest and the execution gate. |
| Test reports | `.agentguard/runs`, CI artifacts and the dashboard. |
| Developer repositories | CI with `contents: read` permissions only. |

## Threats and controls

| Threat | Control | Tested by |
| --- | --- | --- |
| A malicious or compromised agent proposes an over-limit payment | Deterministic limits on BigInt atomic amounts; no LLM in the decision | `tx-limit-*`, `daily-*`, engine property tests |
| Prompt injection or malicious tool output redirects a payment | Recipient, network and asset allowlists; `memo` is never interpreted; unknown fields are rejected | `instruction-injection-in-memo`, `unexpected-fields-rejected` |
| Malformed or adversarial input (negative amounts, floats, exponents, huge strings, prototype keys) | Strict proposal validation, a 4 KiB size limit, plain-object checks, exact grammar | `adversarial-input/*`, amount property tests |
| Identity confusion (case, whitespace, zero-width characters, homoglyphs) | Printable-ASCII identifiers compared byte for byte; no normalisation | `recipient-normalisation` |
| Concurrent requests race past a shared budget | `Ledger.runExclusive`: check-and-reserve is atomic per agent | `concurrent-requests-respect-daily-limit`, plus an unlocked-ledger control experiment |
| Retries cause double accounting or double payment | Idempotency key bound to the proposal digest; atomic `reserved → submitted` gate | `duplicate-request-*`, `concurrent-duplicates-*`, `double-execution-prevented` |
| A replayed, forged, transferred, tampered or expired approval | HMAC over the digest, policy hash, issue and expiry times; lifetime cap; single use | `approval-*`, `forged-approval-rejected`, `changed-recipient-invalidates-approval` |
| `REQUIRE_APPROVAL` mistaken for an authorisation | Nothing is reserved; the execution gate has no reservation to execute | `approval-required-does-not-authorise` |
| A stale policy authorises a transaction after a change | Reservations and approvals record the policy hash; the gate and the verifier reject mismatches | `stale-policy-cannot-execute`, approval policy-mismatch tests |
| Ledger unavailable, or unexpected errors | Fail closed: `BLOCK` with `LEDGER_UNAVAILABLE` or `EVALUATION_ERROR` | `ledger-unavailable-fails-closed`, engine tests |
| Ambiguous provider result (timeout, lost response) treated as success or failure | The reservation stays `submitted` and keeps counting; a hash is recorded only from a network response | `ambiguous-submission-keeps-counting`, NEAR executor tests |
| A developer misconfigures the policy | Strict schema; an empty allowlist means "no one", never "everyone"; warnings for unreachable thresholds; CI fails on loosened limits | policy tests, `regression-gate` CI job |
| A malicious or incorrect custom target or adapter | Results are shape-checked; exceptions and timeouts become `ERROR`; all-skipped runs are incomplete; reports are redacted | runner tests |
| Wrong-network execution (mainnet) | Adapter executes only `near-testnet` and `NEAR`; requires the RPC to report `testnet` and a testnet signer; rejects mainnet-looking RPC URLs | NEAR tests |
| Secrets leaking into reports or logs | Key- and pattern-based redaction plus exact-match redaction of secret environment values | redaction tests |
| Dashboard misuse | Read-only; route parameters checked against strict patterns (no path traversal); every report schema-validated; security headers | data-layer tests |
| Compromised dependency | Lockfile and frozen installs in CI; actions pinned to commit SHAs; small dependency set | CI configuration |

## Out of scope and residual risks

- **Bypass of the enforcement point.** If the agent, or anything it controls, can reach a signing key without `authorize()` and `beginExecution()`, AgentGuard cannot stop it. The key must sit behind a component that enforces the gate.
- **Wallet- or chain-level enforcement.** `ALLOW` is not proof that a wallet, smart contract or payment provider independently enforces the same rules.
- **LLM behaviour.** AgentGuard does not detect or prevent prompt injection. It limits what an injected agent can achieve, within the policy.
- **Multi-process ledgers.** The in-memory reference ledger only serialises within one process.
- **Symmetric approval keys.** Whoever can verify grants can also issue them.
- **Finite test suites.** Passing the scenarios proves only the tested properties under the tested conditions.
