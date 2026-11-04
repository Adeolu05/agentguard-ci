# Policy schema and decision semantics

A policy is a YAML file validated against a strict schema (`policyDocumentSchema` in `packages/core/src/policy.ts`). Validation rejects:

- unknown keys at any level;
- unquoted numeric amounts;
- amounts with more decimals than the asset supports;
- duplicate asset IDs and duplicate allowlist entries;
- duplicate YAML keys and YAML syntax errors.

Each error names the file, line, column and field.

```bash
agentguard policy validate policies/default.yaml
```

## Example

```yaml
version: 1
agent:
  id: research-payment-agent
  name: Research Payment Agent
execution:
  mode: simulation
  fail_closed: true
assets:
  - id: USDC
    decimals: 6
    max_transaction_amount: "25"
    max_daily_spend: "100"
    approval_required_above: "10"
limits:
  max_transaction_count_per_day: 20
  daily_window_utc_offset: "+00:00"
  allow_zero_amount: false
recipients:
  mode: allowlist
  allowed: [merchant-example, data-provider-example]
networks:
  allowed: [near-testnet]
approval:
  max_age_seconds: 900
```

## Fields

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `version` | yes | | Must be `1`. |
| `agent.id` | yes | | Identifier of the agent governed by this policy. Proposals with another `agentId` are blocked (`AGENT_NOT_RECOGNISED`). |
| `agent.name` | no | | Display name. |
| `execution.mode` | no | `simulation` | Declarative label (`simulation` or `testnet`). It does **not** enable execution. Scenario runs always simulate, and real execution needs an explicitly configured adapter. |
| `execution.fail_closed` | no | `true` | Can only be `true`. It exists to make the guarantee explicit; `false` is a validation error. |
| `assets[]` | yes, at least one | | Assets the agent may spend. Any other asset is blocked (`ASSET_NOT_ALLOWED`). |
| `assets[].id` | yes | | Asset identifier, for example `USDC` or `NEAR`. |
| `assets[].decimals` | yes | | Integer from 0 to 30. Defines the atomic unit: `1 USDC = 10^6`, `1 NEAR = 10^24`. |
| `assets[].max_transaction_amount` | yes | | Quoted decimal. A single transaction strictly greater than this is blocked. |
| `assets[].max_daily_spend` | yes | | Quoted decimal. Blocks a transaction if *active* spend in the current window plus this transaction would exceed the limit. |
| `assets[].approval_required_above` | no | none | Quoted decimal. Amounts strictly greater than this require approval. |
| `limits.max_transaction_count_per_day` | yes | | Maximum active reservations per window, across all assets. |
| `limits.daily_window_utc_offset` | no | `+00:00` | Fixed UTC offset defining the calendar day (from `-14:00` to `+14:00`). |
| `limits.allow_zero_amount` | no | `false` | When `false`, zero-value transfers are blocked (`AMOUNT_ZERO`). |
| `recipients.mode` | yes | | `allowlist`: unknown recipients are blocked. `allowlist_or_approval`: unknown recipients require approval. |
| `recipients.allowed` | yes | | List of recipient IDs. **Missing is an error; `[]` is explicit and allows no one.** An empty allowlist never means "allow all". |
| `networks.allowed` | yes | | List of network IDs. An empty list blocks everything. |
| `approval.max_age_seconds` | no | `900` | Maximum lifetime of an approval grant (1 second to 7 days). |

There are no hidden defaults beyond those listed. Limits have no "unlimited" value; set a large number if you really mean it.

## Amounts

- **Policy amounts** are quoted decimal strings in whole units (`"25"`, `"0.5"`).
- **Proposal amounts** are either `amount`, a decimal string in whole units, or `amountAtomic`, an integer string in atomic units. Exactly one must be supplied; both together is `AMOUNT_AMBIGUOUS`.
- The grammar is `0` or `[1-9][0-9]*`, optionally followed by `.` and digits. The following are all rejected: exponents, signs, whitespace, leading zeros, `.5`, `5.`, thousands separators, hex, `NaN` and `Infinity`.
- JSON or YAML **numbers** are rejected (`AMOUNT_INVALID`), because a floating-point value may already have lost precision before AgentGuard sees it.
- Non-zero digits beyond the asset's decimals are rejected (`AMOUNT_PRECISION_EXCEEDED`). Trailing zeros are accepted.
- Strings longer than 78 integer digits are rejected (`AMOUNT_TOO_LARGE`).
- All comparisons and sums use `BigInt` atomic units. No floating point is ever used for a decision.

## Identifiers

Agent, asset, recipient, network, request and idempotency identifiers must be 1 to 128 **printable ASCII** characters with no whitespace. They are compared byte for byte, with no case folding, trimming or Unicode normalisation. Identifiers that contain whitespace, zero-width characters or non-ASCII homoglyphs are rejected outright rather than "cleaned", because cleaning could make two distinct identities compare equal. Integrations can add stricter syntax; for example, the NEAR validator enforces NEAR account-ID rules.

## Proposals

```ts
{
  requestId: string;          // required
  agentId: string;            // required, must equal agent.id
  assetId: string;            // required
  amount?: string;            // exactly one of amount / amountAtomic
  amountAtomic?: string;
  recipientId: string;        // required
  networkId: string;          // required
  idempotencyKey?: string;    // defaults to "request:<requestId>"
  memo?: string;              // up to 256 characters; audit only, never interpreted
}
```

Any other field is rejected (`PROPOSAL_UNKNOWN_FIELD`). The engine validates a JSON snapshot of the proposal, so every field is read exactly once; getters, proxies or `toJSON` cannot show one value to validation and another later. This means an agent cannot slip in `approved: true` or a limit override. `null` counts as missing. A proposal larger than 4 KiB when serialised is rejected (`PROPOSAL_TOO_LARGE`). The engine computes a **proposal digest**, a SHA-256 hash over the canonical form of every material field (including the request ID, the effective idempotency key and the memo). Approvals and idempotency are bound to this digest.

## Decisions

| Decision | Meaning |
| --- | --- |
| `ALLOW` | Every applicable rule passed. `authorize()` has **reserved** the amount. The proposal may proceed to the next, separately authorised execution stage. `ALLOW` does not sign, submit or execute anything. |
| `REQUIRE_APPROVAL` | No hard rule failed, but approval is required. **Nothing is reserved, and this is not an authorisation.** Obtain a grant from the approval service and submit the identical proposal again with it. |
| `BLOCK` | A rule failed, the input is invalid, or the evaluation could not be completed safely. |

### Evaluation order and precedence

1. **Structural validation.** If the proposal is invalid, the result is `BLOCK` with validation reasons only.
2. **Integration validators.** These can only add reasons.
3. **Static rules:** agent, asset, network, recipient, zero amount, per-transaction limit, and the approval triggers (amount threshold and unknown recipient in `allowlist_or_approval` mode).
4. **Approval verification**, if a grant was presented: signature, policy hash, proposal digest, lifetime and expiry.
5. **Ledger stage**, run atomically per agent: idempotency lookup, then daily spend, then daily count, then approval reuse.
6. **Decision.** Any *blocking* reason gives `BLOCK`. Otherwise, approval triggers without a valid, unused grant give `REQUIRE_APPROVAL`. Otherwise the result is `ALLOW` (and `authorize()` reserves the amount).

An approval can never override a blocking reason. Every reason found is reported, in a deterministic order. The decision is a pure function of the policy, the ledger state, the clock and the input.

### Fail closed

If the ledger cannot be read or written, the result is `BLOCK` with `LEDGER_UNAVAILABLE`. If an integration validator or any unexpected error throws, the result is `BLOCK` with `EVALUATION_ERROR`. A grant presented to an engine with no approval verifier is `BLOCK` with `APPROVAL_VERIFICATION_UNAVAILABLE`. No error path produces `ALLOW`.

## Ledger semantics

The ledger records **reservations**, not wallet balances.

```text
reserved ──► submitted ──► confirmed
   │             └──────► failed
   └──────► cancelled
```

- `reserved`, `submitted` and `confirmed` count toward the daily spend and count limits.
- `failed` and `cancelled` release the budget. Record `failed` only when the transaction is **known** not to have executed. If the outcome is ambiguous (a timeout or lost response), leave it `submitted` so that it keeps counting.
- Proposals that are blocked, or that require approval, are never recorded and never count.
- A reservation belongs to the daily window in which it was **created**. The window is the calendar day at `daily_window_utc_offset`, half-open `[00:00, 24:00)`. IANA time zones are not supported, because daylight-saving changes would create 23- and 25-hour days.
- **Idempotency.** The key is `idempotencyKey`, or `request:<requestId>` if none is given, scoped per agent.
  - The same key with the same digest returns the existing reservation (`IDEMPOTENT_REPLAY`, `replay: true`) and records nothing new. If the replay itself carries a blocking reason (for example a forged approval, or a rule the current policy now fails), the decision is `BLOCK`.
  - The same key with a different digest is `IDEMPOTENCY_KEY_CONFLICT`.
  - A key whose reservation failed or was cancelled is `IDEMPOTENCY_KEY_FINALISED`; use a new key.
  - Replaying a reservation that is still `reserved` after a policy change is `STALE_POLICY_VERSION`.
- **Concurrency.** The "check limits, then reserve" step runs inside `Ledger.runExclusive(agentId, …)`. The in-memory reference ledger serialises it per agent. A database-backed ledger must provide the same guarantee, for example with a transaction and row locks.
- **Execution gate.** `beginExecution(reservationId)` moves `reserved` to `submitted` atomically. It succeeds only if the reservation was authorised under the **current** policy hash. A second call fails with `INVALID_STATE_TRANSITION`.

## Approvals

`ApprovalAuthority` (held by your approval service, never by the agent) issues HMAC-SHA256-signed grants:

```json
{ "version": 1, "approvalId": "apr_…", "proposalDigest": "sha256:…", "policyHash": "sha256:…",
  "approverId": "alice", "issuedAt": "…Z", "expiresAt": "…Z", "signature": "…" }
```

The engine accepts a grant only if all of the following hold:

- The signature verifies.
- The grant has the current policy hash.
- It has the exact proposal digest, so any change to amount, recipient, network, asset, request ID, idempotency key or memo invalidates it.
- It has not expired, and its lifetime does not exceed `approval.max_age_seconds`.
- It has not already been consumed by another reservation.

The signing key must be at least 32 bytes. Grants are also read from a JSON snapshot, and timestamps must be real calendar instants (`25:00` or `Feb 30` are rejected rather than rolled over).

## Immutability

Reservations returned by the engine or the ledger are deeply frozen copies, and a policy's document and asset limits are frozen. A caller holding a result cannot change the amount, recipient or status the ledger accounts for. A ledger that returns malformed usage figures makes the evaluation fail closed (`LEDGER_UNAVAILABLE`).

## Policy hash

`policy.hash` is `sha256:` over the canonical JSON of the validated document, with defaults applied. Formatting and comments do not change it. Any semantic change does. Reports, approvals and reservations all record it.

## Reason codes

Reason codes are a stable public contract: they are never renamed, only added. The table below is generated from `packages/core/src/reasons.ts` by `node scripts/reason-codes.mjs`, and a test fails if it is out of date. "Blocking" means the reason alone forces `BLOCK`.

<!-- reason-codes:start -->
| Code | Category | Blocking | Meaning |
| --- | --- | --- | --- |
| `PROPOSAL_MALFORMED` | validation | yes | Proposal is not a plain JSON object |
| `PROPOSAL_TOO_LARGE` | validation | yes | Proposal exceeds the maximum serialised size |
| `PROPOSAL_UNKNOWN_FIELD` | validation | yes | Proposal contains an unsupported field |
| `REQUEST_ID_MISSING` | validation | yes | requestId is missing |
| `REQUEST_ID_INVALID` | validation | yes | requestId is not a valid identifier |
| `AGENT_ID_MISSING` | validation | yes | agentId is missing |
| `AGENT_ID_INVALID` | validation | yes | agentId is not a valid identifier |
| `ASSET_MISSING` | validation | yes | assetId is missing |
| `ASSET_INVALID` | validation | yes | assetId is not a valid identifier |
| `RECIPIENT_MISSING` | validation | yes | recipientId is missing |
| `RECIPIENT_INVALID` | validation | yes | recipientId is not a valid identifier |
| `NETWORK_MISSING` | validation | yes | networkId is missing |
| `NETWORK_INVALID` | validation | yes | networkId is not a valid identifier |
| `AMOUNT_MISSING` | validation | yes | Neither amount nor amountAtomic was provided |
| `AMOUNT_AMBIGUOUS` | validation | yes | Both amount and amountAtomic were provided |
| `AMOUNT_INVALID` | validation | yes | Amount is not a valid non-negative decimal string |
| `AMOUNT_NEGATIVE` | validation | yes | Amount is negative |
| `AMOUNT_PRECISION_EXCEEDED` | validation | yes | Amount has more decimal places than the asset supports |
| `AMOUNT_TOO_LARGE` | validation | yes | Amount exceeds the supported magnitude |
| `AMOUNT_ZERO` | validation | yes | Zero-amount transactions are not permitted by policy |
| `IDEMPOTENCY_KEY_INVALID` | validation | yes | idempotencyKey is not a valid identifier |
| `MEMO_INVALID` | validation | yes | memo must be a string of at most 256 characters |
| `ADAPTER_VALIDATION_FAILED` | validation | yes | An integration adapter rejected the proposal |
| `AGENT_NOT_RECOGNISED` | policy | yes | agentId does not match the policy's agent |
| `ASSET_NOT_ALLOWED` | policy | yes | Asset is not configured in the policy |
| `NETWORK_NOT_ALLOWED` | policy | yes | Network is not on the allowlist |
| `RECIPIENT_NOT_ALLOWED` | policy | yes | Recipient is not on the allowlist |
| `AMOUNT_EXCEEDS_TRANSACTION_LIMIT` | policy | yes | Amount exceeds max_transaction_amount |
| `DAILY_SPEND_LIMIT_EXCEEDED` | policy | yes | Transaction would exceed max_daily_spend |
| `DAILY_COUNT_LIMIT_EXCEEDED` | policy | yes | Transaction would exceed max_transaction_count_per_day |
| `APPROVAL_REQUIRED_AMOUNT` | approval | no | Amount is above the human-approval threshold |
| `APPROVAL_REQUIRED_UNKNOWN_RECIPIENT` | approval | no | Recipient is not on the allowlist and requires approval |
| `APPROVAL_VERIFIED` | approval | no | A valid approval bound to this exact proposal was presented |
| `APPROVAL_MALFORMED` | approval | yes | Approval grant is malformed |
| `APPROVAL_INVALID_SIGNATURE` | approval | yes | Approval signature does not verify |
| `APPROVAL_PROPOSAL_MISMATCH` | approval | yes | Approval was issued for a different proposal |
| `APPROVAL_POLICY_MISMATCH` | approval | yes | Approval was issued under a different policy version |
| `APPROVAL_EXPIRED` | approval | yes | Approval has expired |
| `APPROVAL_NOT_YET_VALID` | approval | yes | Approval issue time is in the future |
| `APPROVAL_LIFETIME_EXCEEDED` | approval | yes | Approval lifetime exceeds approval.max_age_seconds |
| `APPROVAL_ALREADY_USED` | approval | yes | Approval has already been consumed |
| `APPROVAL_VERIFICATION_UNAVAILABLE` | infrastructure | yes | No approval verification key is configured |
| `IDEMPOTENT_REPLAY` | state | no | Duplicate request: the existing reservation was returned and nothing new was recorded |
| `IDEMPOTENCY_KEY_CONFLICT` | state | yes | Idempotency key was already used for a different proposal |
| `IDEMPOTENCY_KEY_FINALISED` | state | yes | Idempotency key belongs to a failed or cancelled reservation; use a new key |
| `STALE_POLICY_VERSION` | state | yes | Reservation was authorised under a different policy version |
| `RESERVATION_NOT_FOUND` | state | yes | Reservation does not exist |
| `INVALID_STATE_TRANSITION` | state | yes | Requested lifecycle transition is not permitted |
| `LEDGER_UNAVAILABLE` | infrastructure | yes | Ledger state could not be read; failing closed |
| `EVALUATION_ERROR` | infrastructure | yes | Unexpected evaluation error; failing closed |
<!-- reason-codes:end -->
