# Scenarios

A scenario is a YAML file that encodes one security property as a short program: a starting state, a sequence of steps, and the expected outcome of each step. Scenarios are discovered recursively, as `*.yaml` or `*.yml` files, under the directories listed in `agentguard.yaml`. They are strictly validated before anything runs. A malformed scenario is an error (exit code 2); it is never silently skipped or passed.

```bash
agentguard scenarios validate
agentguard scenarios list --category approval-workflow
agentguard test --scenario unknown-recipient-blocked
```

## Why scenarios use concrete values

Built-in scenarios use concrete amounts and recipients that match the default policy, for example "25.000001 USDC must be blocked". That is deliberate. The scenarios are your **security specification** and the policy is its configuration. If someone raises `max_transaction_amount` to 2,500, the scenario fails and CI tells you which security property changed. Scenarios that read their thresholds from the policy would follow the change and never catch it.

When you change a limit on purpose, update the affected scenarios in the same pull request. That makes the change explicit and reviewable.

## Format

```yaml
id: changed-recipient-invalidates-approval   # lowercase kebab-case, unique
name: A changed recipient invalidates an earlier approval
category: recipient-security                  # see the categories below
severity: critical                            # critical | high | medium | low | informational
description: >
  An approval granted for paying merchant-example must not authorise the same payment
  to a different recipient.
remediation: Bind approvals to a digest of every material proposal field.   # optional
required: true          # optional; non-required scenarios never fail the run
skip: "reason"          # optional; reports SKIPPED with this reason
given:                  # optional
  now: "2026-01-15T12:00:00Z"        # scenario clock (default shown)
  ledger:                            # seeded history (counts toward limits)
    - { amount: "90", asset: USDC, status: confirmed, at: "2026-01-15T09:00:00Z", repeat: 1 }
  ledger_unavailable: false          # true: every ledger call fails (fail-closed tests)
  policy_patch:                      # dotted-path overrides of the project policy for this scenario only
    recipients.mode: allowlist_or_approval
steps:
  - propose: { requestId: r1, agentId: research-payment-agent, assetId: USDC, amount: "15", recipientId: merchant-example, networkId: near-testnet }
    expect: { decision: REQUIRE_APPROVAL }
  - approve: { proposal: r1, as: grant }
  - propose: { requestId: r1, agentId: research-payment-agent, assetId: USDC, amount: "15", recipientId: data-provider-example, networkId: near-testnet }
    with_approval: grant
    expect: { decision: BLOCK, reason_codes: [APPROVAL_PROPOSAL_MISMATCH] }
```

Categories: `transaction-limits`, `recipient-security`, `network-asset`, `approval-workflow`, `state-concurrency`, `adversarial-input`, `integration`.

The `propose` mapping is passed to the target **verbatim**. It is the untrusted input under test, so it is intentionally not validated or normalised by the runner. For example, `amount: 5.5` (unquoted) reaches the engine as a floating-point number, and that is exactly what the `invalid-decimal-formats` scenario tests.

## Steps

| Step | Fields | Expectation |
| --- | --- | --- |
| `propose` | the proposal; `as` (reference name, default `requestId`); `with_approval` (grant reference); `fill` (test helper that replaces fields with generated strings, for example `{ memo: { char: "A", length: 100000 } }`) | `expect.decision` (required); `reason_codes` (must all be present); `reason_codes_exact`; `absent_reason_codes`; `replay` |
| `approve` | `proposal` (reference), `as`, `approver`, `ttl_seconds` (default 300), `signing_key: trusted \| untrusted` (untrusted simulates a forged grant) | none |
| `advance_time` | `seconds` | none |
| `execute` | `proposal`: calls the execution gate (`beginExecution`) for that proposal's reservation | `expect.ok`, `expect.reason_code` |
| `record_outcome` | `proposal`, `outcome: confirmed \| failed`, `transaction_reference` | `expect.ok`, `expect.reason_code` |
| `cancel` | `proposal` | `expect.ok`, `expect.reason_code` |
| `concurrent` | `proposal`, `count` (2 to 500), `unique_request_ids` (default true; suffixes `-1…-n` to the request ID and idempotency key) | `expect.decisions: { ALLOW: n, BLOCK: m, REQUIRE_APPROVAL: k }`. The full distribution must match; omitted keys mean 0. |
| `reload_policy` | `set`: dotted-path assignments; the result is revalidated | none |
| `expect_ledger` | `asset`, `active_amount`, `active_count`, `reservations_created` | the observed values must match |

References (`proposal:`, `with_approval:`) must point to **earlier** steps; this is checked at validation time. A scenario stops at its first failing step, and that step becomes the finding.

## Outcomes

| Status | Meaning |
| --- | --- |
| `PASS` | Every step matched its expectation. |
| `FAIL` | A step's observed behaviour differed from the expectation. A finding is produced. |
| `ERROR` | The scenario could not be evaluated. Causes include a target that threw or returned a malformed result, a timeout (15 seconds by default), or an invalid `policy_patch`. **Never counted as a pass.** |
| `SKIPPED` | `skip:` was set, or the target lacks a capability the scenario needs. |

A run in which no scenario was evaluated (everything skipped) is reported as incomplete (exit code 3), not as a pass.

Every scenario runs in isolation, with a fresh ledger, its own clock and a fresh approval key. Results are deterministic: two runs produce the same statuses and observed decisions. Only IDs and timings differ.

## Custom targets

By default scenarios run against AgentGuard's engine with your policy. To test **your own guard**, which might be hand-written checks, a wrapper around your agent's payment tool, or a framework adapter, use a module target:

```yaml
# agentguard.yaml
target:
  type: module
  module: ./guard.mjs
```

```js
// guard.mjs
export function createTarget(context) {
  // context: { policyDocument, policy, clock, seed, ledgerUnavailable, validators }
  return {
    name: "my-guard",
    capabilities: { reasonCodes: false, approvals: false, lifecycle: false, ledgerInspection: false, policyReload: false, failureInjection: false },
    async propose(proposal, { approval }) {
      // Return { decision: "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL", reasonCodes?, replay?, handle?, proposalDigest? }
    },
    // Optional, enabled by the matching capability:
    // issueApproval({ result, approverId, ttlSeconds, signingKey })  -> grant
    // execute(handle) / recordOutcome(handle, outcome, ref) / cancel(handle)  -> { ok, reasonCode? }
    // reloadPolicy(set)
    // ledgerUsage(assetId)  -> { activeAtomic: bigint, activeCount, created }
    // dispose()
  };
}
```

Rules:

- Only `propose` is required. Results are shape-checked: a missing or unknown decision, or non-string reason codes, make the scenario `ERROR`.
- If `reasonCodes` is false, scenarios are checked on **decisions only**. The step records "reason codes not checked", and nothing is skipped because of it.
- Scenarios needing approvals, lifecycle, ledger inspection, policy reload or failure injection are `SKIPPED` for targets that lack them, and the skip reason names the missing capability.
- `context.seed` contains the historical reservations the scenario starts with. A guard that keeps no spending history cannot honour it, so daily-limit scenarios will (correctly) fail.

See [`examples/basic-agent`](../examples/basic-agent) for a naive guard (16 failures) and a guard built on `@agentguard/core` (40 passes).

## Writing good scenarios

- Test one property per scenario, and make its first step the most important assertion.
- Prefer boundary values: exactly at a limit, and one atomic unit above it.
- Add an `absent_reason_codes` check when a decision could be "right for the wrong reason".
- Give the scenario's `severity` using the criteria in [findings.md](findings.md).
- Every security bug you fix should get a scenario (or a unit test) that would have caught it.
