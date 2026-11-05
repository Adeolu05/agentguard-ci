# AgentGuard Vault: design

Status: **design for review.** No contract code has been written. Everything below is a proposal until it is approved, and every number marked "to be measured" will come from a real sandbox run.

## Why

Today `NearTestnetExecutor` sends native NEAR transfers. A native transfer must be signed with a full-access key, and a full-access key can do anything with its account. The README says so plainly: if your agent can reach a signing key without going through `authorize()`, nothing in AgentGuard stops it.

The vault closes that gap on-chain. A NEAR contract holds the funds and enforces the policy itself. The agent gets only a function-call key that can call one method on that contract. Even a fully compromised agent can then do only what the contract allows.

## Sources

Checked on 2026-11-05. `docs.near.org` is not reachable from the environment this was written in, so the official documentation was read from its source repository, `github.com/near/docs`, at commit `fa2acf6` (the latest commit on that day). Crate and package versions were read from the registries the same day.

| Topic | What was confirmed | Source |
| --- | --- | --- |
| Contract language and SDK | "NEAR's only official smart-contract SDK is near-sdk-rs, the NEAR SDK for Rust." The quickstart builds a Rust contract with `cargo near`. | near/docs `tools/sdk.mdx`; `smart-contracts/quickstart.mdx` (FAQ: "Use near-sdk-rs, NEAR's only official smart-contract SDK") |
| `near-sdk` version | **5.30.0**, the latest stable, published 2026-10-27, `rust-version = "1.95"` | crates.io API; `near-sdk-5.30.0/Cargo.toml` |
| JavaScript SDK | `near-sdk-js` is at 2.0.0, and its npm metadata was last modified on 2024-06-07 | `npm view near-sdk-js` |
| Build tool | `cargo-near` **0.22.0** (latest stable; 0.23.0-rc.2 is a pre-release). The quickstart builds with `cargo near build non-reproducible-wasm` and needs the `wasm32-unknown-unknown` target. | crates.io API; `smart-contracts/quickstart.mdx` |
| Local sandbox | The integration-test page uses `near-sandbox` to run a local node and `near-api` to send transactions. `near-sandbox` (Rust) **0.4.0** and the JavaScript edition `near-sandbox` **0.3.5** (repository `near/near-sandbox-js`, updated 2026-11-04) both download nearcore sandbox **2.14.0** from `s3-us-west-1.amazonaws.com/build.nearprotocol.com`. That host is reachable from this environment (HTTP 200). | `smart-contracts/testing/integration-test.mdx` lines 14 to 19; `near-sandbox-0.4.0/src/lib.rs:28` and `src/runner/mod.rs:122`; `npm pack near-sandbox@0.3.5` |
| Function-call keys | Defined by `receiver_id` (the only contract the key may call), optional `method_names`, and optional `allowance` (NEAR the key may spend on gas; omitted means unlimited). They "do not allow to attach NEAR tokens". | `protocol/accounts-contracts/access-keys.mdx`, "Function-Call Keys" |
| Allowance exhaustion | A fully used allowance makes the key unusable. Adding NEAR to the account does not help. "The allowance of an existing key cannot be changed. To get a new allowance, add a new key. To add a key, you need a full access key, or a method in the account's own contract that adds keys." | `access-keys.mdx`, "Allowance Exhaustion" |
| Gas keys | A newer key type (nearcore 2.13, protocol 86) with its own prepaid gas balance that the account can top up. A function-call gas key cannot set an allowance. | `protocol/accounts-contracts/gas-keys.mdx` |
| Adding a function-call key | `near-api-js@7.4.0`: `account.addFunctionCallAccessKey({ publicKey, contractId, methodNames, allowance })`. NEAR CLI v0.30.1: `account add-key <account> grant-function-call-access --allowance ... --contract-account-id ... --function-names ...` | `near-api-js` `lib/account-*.d.ts:1130`; `near-cli-rs` v0.30.1 `src/commands/account/add_key/access_key_type/mod.rs` |
| Owner-only calls | Requiring exactly 1 yoctoNEAR proves the call was signed with a full-access key, because a function-call key cannot attach a deposit. `near_sdk::assert_one_yocto()` does this check. | `smart-contracts/security/one_yocto.mdx`; `near-sdk-5.30.0/src/utils/mod.rs:84` |
| Deposits on ordinary methods | A method without `#[payable]` panics with "Method ... doesn't accept deposit" if any deposit is attached. | `near-sdk-macros-5.30.0/src/core_impl/code_generator/impl_item_method_info.rs:155` |
| Callbacks | Mark callbacks `#[private]` so only the contract itself can call them. | `smart-contracts/security/cross-contract-calls/callbacks.mdx` |
| Transfers from a contract | `Promise::new(to).transfer(amount)`. "The only case where a transfer will fail is if the receiver account does not exist." | `smart-contracts/anatomy/actions.mdx:43,52` |
| Time | `env::block_timestamp()` returns nanoseconds since the Unix epoch. | `smart-contracts/anatomy/environment.mdx` |
| Events | NEP-297: a log line `EVENT_JSON:{"standard","version","event","data"}`. near-sdk generates it from `#[near(event_json(standard = "..."))]`. | `smart-contracts/anatomy/events.mdx` |
| Storage cost | 10^19 yoctoNEAR per byte (1 NEAR per 100 kB), held on the contract's balance | `protocol/storage/storage-staking.mdx:51` |
| Deploy | `near deploy <accountId> <wasm>`; `cargo near build non-reproducible-wasm` produces the wasm | `smart-contracts/release/deploy.mdx`; `smart-contracts/quickstart.mdx` |

## SDK choice

**Rust with `near-sdk` 5.30.0, built with `cargo-near` 0.22.0.** The official docs describe it as NEAR's only official contract SDK, it is actively released, and the security pages (1 yocto, private callbacks) are written for it. `near-sdk-js` has had no npm release since mid-2024, so it is not a sound base for a security contract.

The installed toolchain here is Rust 1.97.0, which meets `near-sdk`'s minimum of 1.95. The `wasm32-unknown-unknown` target is not installed yet; `static.rust-lang.org` is reachable, so it can be added.

**Tests, proposed split:**

- **Contract unit tests in Rust** (`cargo test`, `near-sdk` feature `unit-testing`). These set the block timestamp exactly, so day boundaries and approval expiry are tested to the nanosecond.
- **Sandbox integration tests in TypeScript** (Vitest, `near-sandbox` 0.3.5 for JavaScript and `near-api-js` 7.4.0). These cover real transactions, real function-call keys and real transfers. The scenario target and the testnet scripts are JavaScript too, so one client stack covers everything. The Rust `near-sandbox` with `near-api` would work as well; I propose the JavaScript edition to avoid a second client library.

## Accounts and keys

| Account | Holds | Keys |
| --- | --- | --- |
| **Owner** (the human), for example `alice.testnet` | Nothing in the vault | The owner's own full-access key. Owner calls attach 1 yoctoNEAR, so they need a full-access key. |
| **Vault**, a sub-account such as `vault.alice.testnet` | The funds and the contract | For testnet, a full-access key kept by the owner (for redeploys and cleanup). See "Vault account keys" below. |
| **Agent**, for example `alice-agent.testnet` | A small balance that pays its gas | The agent runtime has **only** a function-call key: `receiver_id` = the vault, `method_names` = `["request_payment"]`, a finite `allowance`. The owner keeps the agent account's full-access key offline for recovery. |

The vault checks `env::predecessor_account_id() == agent_id` on every payment request. Its guarantees therefore do not depend on what keys the agent account has: even a full-access key on the agent account only gets `request_payment` rights in the vault. The function-call key adds a second layer: it protects the agent account's own balance (it cannot transfer NEAR or add keys) and caps gas spending.

## Threat model

### A compromised agent key (the function-call key)

It **can**:

- Call `request_payment` on the vault, and nothing else.
- Spend gas from the key's allowance, which is paid from the agent account's balance. The loss is at most the smaller of the allowance and that balance.
- Get payments made to **allowlisted** recipients, within the per-transaction and daily limits. The vault bounds this loss; it does not eliminate it. The worst case per UTC day is `max_daily_spend`.
- Create pending approval requests, up to `MAX_PENDING`, which adds noise to the owner's queue.
- Write event logs (memos included) that the owner and indexers will read.

It **cannot**:

- Transfer NEAR directly, from the agent account or the vault. A function-call key cannot sign a `Transfer` action, and it cannot attach a deposit to the call.
- Add or delete keys, deploy code, or call any other contract or method. `receiver_id` and `method_names` restrict the key at the protocol level.
- Call owner methods. They are not in the key's `method_names`, they check that the caller is the owner, and they require 1 yoctoNEAR, which a function-call key cannot attach.
- Pay a recipient that is not allowlisted (in `allowlist` mode), exceed a limit, approve its own pending request, change the policy, unpause the vault, or withdraw.
- Get the same request paid twice. The idempotency key is checked and recorded in the same function call that reserves the budget and schedules the transfer.

### Other keys

| Compromised key | Effect | Mitigation |
| --- | --- | --- |
| Owner's full-access key | Full control: change the policy, approve, withdraw everything | Out of scope for the contract. Use a hardware wallet. A multisig owner is a possible extension. |
| Vault account's full-access key | Can deploy different code or move all funds, bypassing the contract | Keep it with the owner, or delete it after deployment to lock the account (then no redeploys or cleanup are possible). For testnet the deploy script keeps it and says so. |
| Agent account's full-access key | Can spend the agent account's balance and add keys. In the vault it is still limited to `request_payment`. | Keep it offline. It is only needed for recovery. |

### Contract-level risks considered

- **Reentrancy and ordering.** A function call's state changes commit together, or not at all if it panics. The vault checks the limits, records the request, updates usage and schedules the transfer within that one call, so nothing can slip in between the check and the reservation. The transfer and its callback run later, as separate receipts, and there are no synchronous calls back into the vault.
- **Failed transfers.** A transfer fails only if the receiver does not exist. The callback then marks the request `FAILED` and releases its budget. If the callback itself cannot run, the request stays `SUBMITTED` and keeps counting toward the limits (fail closed, the same rule as the off-chain ledger).
- **Storage drain.** Every stored request locks storage stake from the vault's balance. Blocked requests are never stored (they are only logged), pending requests are capped, and paid requests are bounded per day by `max_daily_count`. Storage per request is to be measured (see "Storage layout").
- **Insufficient gas from the caller.** `request_payment` requires enough prepaid gas for the transfer and the callback before it changes anything. Otherwise it panics and nothing is recorded.
- **Time.** Limits use the block timestamp, which validators set. Day boundaries are as accurate as block time, not wall-clock exact.

## Policy model

The vault stores one policy. It mirrors the fields of the AgentGuard YAML policy that make sense for a single-asset vault:

```rust
pub struct VaultPolicy {
    pub max_transaction: U128,               // yoctoNEAR; strictly greater is blocked
    pub max_daily_spend: U128,               // yoctoNEAR per window
    pub max_daily_count: u32,                // requests counted per window
    pub approval_required_above: Option<U128>, // strictly greater needs owner approval
    pub recipient_mode: RecipientMode,       // Allowlist | AllowlistOrApproval
    pub allowed_recipients: Vec<AccountId>,  // at most MAX_RECIPIENTS (proposed: 100)
    pub daily_window_utc_offset_minutes: i32, // -840..=840, as in the YAML
    pub allow_zero_amount: bool,
    pub approval_ttl_seconds: u32,           // pending requests expire after this
    pub policy_hash: String,                 // sha256 of the source YAML policy, for traceability
}
```

The daily window index is `floor((block_timestamp_ns + offset_minutes * 60 * 10^9) / (86_400 * 10^9))`, computed in `i128` so negative offsets cannot underflow. Amounts are `u128` everywhere: no floats.

### Pushing a YAML policy to the vault

A pure converter in `@agentguard/near`, `vaultPolicyFromPolicy(policy)`, turns a loaded AgentGuard policy into `VaultPolicy` or returns the list of reasons it cannot. A script, `examples/near-vault/push-policy.mjs`, prints the exact call arguments by default (dry run) and only sends them with an explicit flag, on testnet, signed with the owner's key from the environment. It refuses to send anything the converter rejected.

| YAML field | Vault field | Rule (anything else fails) |
| --- | --- | --- |
| `assets[]` | (none) | Exactly one asset, `id: NEAR`, `decimals: 24` |
| `assets[0].max_transaction_amount` | `max_transaction` | Exact decimal to yoctoNEAR, must fit in `u128` |
| `assets[0].max_daily_spend` | `max_daily_spend` | Same |
| `assets[0].approval_required_above` | `approval_required_above` | Same; absent stays absent |
| `limits.max_transaction_count_per_day` | `max_daily_count` | Must fit in `u32` |
| `limits.daily_window_utc_offset` | `daily_window_utc_offset_minutes` | Exact conversion of `+HH:MM` |
| `limits.allow_zero_amount` | `allow_zero_amount` | Copied |
| `recipients.mode` | `recipient_mode` | `allowlist` or `allowlist_or_approval` |
| `recipients.allowed` | `allowed_recipients` | Every entry must be a valid NEAR account ID for the target network, at most `MAX_RECIPIENTS` |
| `networks.allowed` | (none) | Must be exactly `[near-testnet]` for a testnet vault |
| `approval.max_age_seconds` | `approval_ttl_seconds` | Copied. In the YAML it caps an approval grant's lifetime; in the vault it caps how long a request may wait for approval. The intent is the same; the mechanism differs (see below). |
| policy hash | `policy_hash` | The core engine's `sha256:` hash of the policy |
| `agent.id`, `agent.name`, `execution.*` | (none) | Not pushed. The vault's agent is an account ID, set separately with `set_agent`. |

## Methods

All amounts are `U128` JSON strings in yoctoNEAR. Owner methods are `#[payable]`, call `assert_one_yocto()` and check that the caller is the owner. If either check fails the call panics and nothing changes.

### Initialisation

```rust
#[init]
pub fn new(owner_id: AccountId, agent_id: AccountId, policy: VaultPolicy) -> Self
```

Rejects `owner_id == agent_id`, either of them equal to the vault account, and an invalid policy.

### Agent

```rust
pub fn request_payment(
    &mut self,
    request_id: String,              // 1..=128 printable ASCII, as in the core engine
    recipient_id: String,            // validated here, so an invalid ID gives RECIPIENT_INVALID
    amount: U128,
    idempotency_key: Option<String>, // default "request:<request_id>", as in the core engine
    memo: Option<String>,            // at most 256 characters; logged, never stored
) -> PaymentDecision
```

```rust
pub struct PaymentDecision {
    pub decision: Decision,          // ALLOW | BLOCK | REQUIRE_APPROVAL
    pub reason_codes: Vec<String>,
    pub replay: bool,
    pub key: String,                 // the idempotency key
    pub status: Option<RequestStatus>, // for ALLOW: SUBMITTED (transfer scheduled) or the stored status on a replay
}
```

- Not payable: an attached deposit panics (near-sdk), on top of the protocol rule that a function-call key cannot attach one.
- Panics, with nothing recorded, if the caller is not the agent (`AGENT_NOT_RECOGNISED`) or the prepaid gas is too low.
- Otherwise it **returns** the decision instead of panicking, so a blocked request still leaves its event in the transaction's logs.
- Evaluation order follows the core engine: input checks, then static rules (pause, zero amount, per-transaction limit, recipient, approval threshold), then the idempotency lookup, then the daily spend and count limits, then the vault balance. Every reason found is reported.
- On `ALLOW` it stores the request as `SUBMITTED`, adds the amount and one to today's usage, and schedules `Promise::new(recipient).transfer(amount)` followed by the private callback `on_transfer_settled(key)`.
- On `REQUIRE_APPROVAL` it stores the request as `PENDING`. Nothing counts toward the limits until it is approved, the same as the core engine.

**Idempotency** follows the core engine's rules:

| Existing record with the same key | Same recipient and amount | Different recipient or amount |
| --- | --- | --- |
| `SUBMITTED` or `PAID` | `ALLOW`, `IDEMPOTENT_REPLAY`, `replay: true`, nothing paid. If a static rule now fails, `BLOCK` (nothing paid either way). | `BLOCK`, `IDEMPOTENCY_KEY_CONFLICT` |
| `PENDING` | `REQUIRE_APPROVAL`, `IDEMPOTENT_REPLAY` | `BLOCK`, `IDEMPOTENCY_KEY_CONFLICT` |
| `FAILED`, `REJECTED` or `EXPIRED` | `BLOCK`, `IDEMPOTENCY_KEY_FINALISED` | `BLOCK`, `IDEMPOTENCY_KEY_CONFLICT` |

### Owner

```rust
#[payable] pub fn approve(&mut self, key: String) -> ApprovalOutcome
#[payable] pub fn reject(&mut self, key: String)
#[payable] pub fn set_policy(&mut self, policy: VaultPolicy)
#[payable] pub fn set_agent(&mut self, agent_id: AccountId)
#[payable] pub fn pause(&mut self)
#[payable] pub fn unpause(&mut self)
#[payable] pub fn withdraw(&mut self, amount: U128) -> Promise   // to the owner, never more than the available balance
```

`approve` pays a pending request **at most once**, and only with the stored recipient and amount. It re-checks everything except the approval threshold, under the current policy and at the current time: not paused, not expired, the per-transaction limit, the recipient (in `allowlist` mode it must still be allowlisted), today's spend and count, and the vault balance. If a check fails it returns the reasons and leaves the request pending (an expired request becomes `EXPIRED`). If they all pass it moves the request to `SUBMITTED`, counts it in today's usage and schedules the transfer.

`set_agent` is the revocation path that does not depend on the agent account's keys: after it, the old agent key can no longer get anything paid.

While paused, `request_payment` returns `BLOCK` with `VAULT_PAUSED`, and `approve` refuses. Callbacks still settle transfers already in flight, and `withdraw` still works so the owner can recover funds.

### Callback and views

```rust
#[private] pub fn on_transfer_settled(&mut self, key: String, #[callback_result] result: Result<(), PromiseError>)
pub fn get_config(&self) -> ConfigView        // owner_id, agent_id, paused
pub fn get_policy(&self) -> VaultPolicy
pub fn get_usage(&self) -> UsageView          // window index, spent, count
pub fn get_request(&self, key: String) -> Option<RequestView>
pub fn list_pending(&self, from_index: u32, limit: u32) -> Vec<RequestView>   // flags expired ones
pub fn available_balance(&self) -> U128       // balance minus storage stake
```

The callback never panics. On success it marks the request `PAID`; on failure it marks it `FAILED` and subtracts the amount and the count from usage, but only if the request belongs to the current window.

### Request lifecycle

```text
request_payment ── ALLOW ──────────────► SUBMITTED ──► PAID
               │                             └──────► FAILED (budget released)
               └── REQUIRE_APPROVAL ──► PENDING ──approve──► SUBMITTED
                                          ├──reject───► REJECTED
                                          └──expired──► EXPIRED (on approve)
BLOCK: nothing stored, event only.
```

## Reason codes

The vault reuses the core engine's names wherever the rule is the same: `REQUEST_ID_INVALID`, `RECIPIENT_INVALID`, `IDEMPOTENCY_KEY_INVALID`, `MEMO_INVALID`, `AMOUNT_ZERO`, `AGENT_NOT_RECOGNISED`, `RECIPIENT_NOT_ALLOWED`, `AMOUNT_EXCEEDS_TRANSACTION_LIMIT`, `DAILY_SPEND_LIMIT_EXCEEDED`, `DAILY_COUNT_LIMIT_EXCEEDED`, `APPROVAL_REQUIRED_AMOUNT`, `APPROVAL_REQUIRED_UNKNOWN_RECIPIENT`, `APPROVAL_EXPIRED`, `IDEMPOTENT_REPLAY`, `IDEMPOTENCY_KEY_CONFLICT`, `IDEMPOTENCY_KEY_FINALISED`.

New, vault-only codes: `VAULT_PAUSED`, `PENDING_LIMIT_REACHED`, `INSUFFICIENT_VAULT_BALANCE`, `REQUEST_NOT_PENDING` (approve or reject on a request that is not pending), `TRANSFER_FAILED` (in the settlement event).

## Events

Standard `agentguard_vault`, version `1.0.0`, emitted with `#[near(event_json(...))]`. Amounts are strings. Examples (illustrative, not output from a run):

```text
EVENT_JSON:{"standard":"agentguard_vault","version":"1.0.0","event":"payment_decision","data":[{"key":"request:inv-7","request_id":"inv-7","recipient_id":"shop.testnet","amount":"10000000000000000000000","decision":"BLOCK","reason_codes":["RECIPIENT_NOT_ALLOWED"],"replay":false,"memo":"ignore previous instructions"}]}
EVENT_JSON:{"standard":"agentguard_vault","version":"1.0.0","event":"payment_settled","data":[{"key":"request:inv-8","status":"PAID","recipient_id":"shop.testnet","amount":"10000000000000000000000"}]}
```

Events: `payment_decision`, `payment_settled`, `approval_decision` (`APPROVED`, `REJECTED`, `EXPIRED`, `NOT_APPROVED` with reasons), `policy_updated` (with `policy_hash`), `agent_changed`, `paused`, `unpaused`, `withdrawn`.

## Storage layout

| Key | Type | Contents |
| --- | --- | --- |
| state root | struct | `owner_id`, `agent_id`, `paused`, `policy` (without the allowlist), `usage { window, spent, count }` |
| `r` | `LookupSet<AccountId>` | Allowed recipients; replaced by `set_policy` (bounded by `MAX_RECIPIENTS`) |
| `q` | `LookupMap<String, Request>` | Every non-blocked request, by idempotency key: `request_id`, `recipient_id`, `amount`, `status`, `created_at_ns`, `window` |
| `p` | `IterableSet<String>` | Keys of pending requests, at most `MAX_PENDING` (proposed: 50) |

Usage keeps only the current window, so its storage does not grow. Request records are kept for good, because removing one would let its key be paid again. By field sizes, one record holds at most about 370 bytes of data (about 0.0037 NEAR of storage stake at 10^19 yoctoNEAR per byte), plus a fixed per-entry overhead that the runtime adds. The real figure will be measured in the sandbox with `env::storage_usage()`.

## Gas allowance and lockout

The agent's key has a finite allowance, so a stolen key cannot burn the agent account's whole balance on gas. The cost is that the key stops working once the allowance is used up, which halts payments (it does not lose funds). The docs are explicit: the allowance cannot be raised and adding NEAR does not help.

Recovery, in order of preference:

1. The owner adds a new function-call key to the agent account with its offline full-access key, gives it to the agent, and deletes the exhausted one.
2. If the agent account has no full-access key (or it is lost), the owner calls `set_agent` on the vault to point it at a new agent account. This needs only the owner's key.

The allowance value will be chosen after measuring the gas per `request_payment` in the sandbox (to be measured), and documented with its approximate number of calls. A function-call **gas key** could replace the allowance later, since the owner can top it up, but it is newer tooling and not needed for the first version.

## Relation to the off-chain engine

Defence in depth, from the same YAML policy:

| Layer | When | What it catches |
| --- | --- | --- |
| `agentguard test` in CI | Before a policy change is merged or deployed | Policy regressions: a loosened limit or allowlist fails the scenario suite and blocks the merge |
| `@agentguard/core` engine | Before the agent asks the vault to pay | Malformed or injected proposals, approval grants bound to the exact proposal, idempotency, reservations; explains decisions with the same reason codes |
| Vault contract | At execution time, on-chain | Everything the agent's key could still do if the agent skipped or bypassed the engine: unknown recipients, over-limit amounts, double payment, payments while paused, unapproved large payments |

The approval mechanisms differ. Off-chain, an approval is an HMAC-signed grant bound to the proposal's digest. On-chain, the owner approves a pending request by its key with a full-access transaction, and the vault pays exactly the stored recipient and amount, so an approval cannot be applied to a different payment.

## Scenario target: which built-in scenarios can apply

A module target (`createTarget()`, like `examples/basic-agent`) will start a sandbox, deploy the vault, give the agent account a real function-call key, push the scenario's policy, and send every proposal as a real `request_payment` transaction signed with that key. It translates the scenario's single asset into the vault's unit at the same atomic precision (the scenarios use a 6-decimal USDC; the vault compares atomic integers, so the limits and amounts keep their exact ratios). `assetId` and `networkId` are not sent: a vault is one asset on one network.

Expected classification (to be confirmed by a real run, which will be reported as it comes out):

| Group | Scenarios | Why |
| --- | --- | --- |
| **Expected to run and pass against the vault** (about 16) | `unknown-recipient-blocked`, `approved-recipient-allowed`, `unknown-recipient-requires-approval`, `instruction-injection-in-memo`, `agent-impersonation` (sent from a different account), `zero-amount`, `tx-limit-one-unit-above-maximum`, `tx-limit-far-above-maximum`, `below-threshold-no-approval`, `duplicate-request-no-double-count`, `idempotency-key-conflict`, `concurrent-duplicates-single-reservation`, and the seeded limit scenarios (`daily-count-limit`, `daily-spend-exactly-at-limit`, `daily-spend-would-exceed-limit`, `concurrent-requests-respect-daily-limit`) | The vault enforces these rules itself. Seeded history is reproduced by making the seed payments through the vault first, which is possible only when every seed entry is `confirmed` and dated in the current window. |
| **Not applicable: input validation** (9) | `ambiguous-amount-fields`, `invalid-decimal-formats`, `negative-amount`, `oversized-input`, `unexpected-fields-rejected`, `asset-precision-exceeded`, `missing-network-rejected`, `missing-recipient-rejected`, `recipient-normalisation` | The vault takes typed arguments (an integer amount, no asset or network field), so these inputs never reach it as such. They are the off-chain engine's job, and its suite covers them. |
| **Not applicable: one asset, one network** (2) | `unknown-asset-rejected`, `unsupported-network-blocked` | Fixed by deployment, not by a runtime check. |
| **Not applicable: different approval model** (7) | `approval-amount-tampering`, `approval-expired`, `approval-not-transferable`, `forged-approval-rejected`, `changed-recipient-invalidates-approval`, `tx-limit-exactly-at-maximum`, `approval-required-does-not-authorise` | They present HMAC grants. The equivalent vault properties (owner-only approval, pays the stored request exactly once, expiry) are covered by the vault's own sandbox tests. |
| **Not applicable: no separate execution step or failure injection** (5) | `ambiguous-submission-keeps-counting`, `double-execution-prevented`, `failed-and-cancelled-release-budget`, `ledger-unavailable-fails-closed`, `stale-policy-cannot-execute` | The vault decides and pays in one call; there is no `execute` or `recordOutcome` step to call, and contract state cannot be made "unavailable". |
| **Not applicable: clock control** (1) | `daily-window-resets` | The sandbox runs on block time and cannot be set to a given instant. Window reset is covered by the contract's unit tests with exact timestamps. |

To report the "not applicable" ones as `SKIPPED` with their reason (instead of a misleading `FAIL`), the runner needs one small, optional addition: a target may implement `unsupported(scenario)`, returning a reason string to skip that scenario. Existing targets are unaffected. This is a change to `@agentguard/runner` and needs your approval.

## Delivery plan after approval

1. `contracts/vault/`: the contract, Rust unit tests, a pinned toolchain file, and `cargo near build non-reproducible-wasm`.
2. Sandbox integration tests (TypeScript), covering every case in the Phase 3 list, including that the agent's function-call key cannot call owner methods or transfer directly, and that an attached deposit is rejected.
3. The `unsupported()` runner hook (if approved) and the vault scenario target, with the real pass, skip and fail counts reported.
4. `examples/near-vault/`: testnet-only deploy script (refuses unless the RPC reports `testnet` and the accounts are testnet accounts), agent key script (generates the key pair in memory, adds it as a function-call key, prints the private key once, never writes it), policy push script, and a demo of one allowed and one blocked payment with their event logs.
5. CI: a separate job that builds the contract and runs the Rust and sandbox tests, with every action pinned to a commit SHA like the existing workflow.
6. README: "What the agent's key can and cannot do".

The default `pnpm check` and the judge steps stay offline. The contract and sandbox tests need Rust and a one-time sandbox download, so they get their own commands (for example `pnpm test:vault`) and their own CI job.

## Decisions needed

1. **SDK:** Rust `near-sdk` 5.30.0 with `cargo-near` 0.22.0. (Recommended.)
2. **Integration tests in TypeScript** with `near-sandbox` (JavaScript) and `near-api-js` 7.4.0, instead of the Rust `near-sandbox` with `near-api`. (Recommended.)
3. **The optional `unsupported()` runner hook**, so inapplicable scenarios are reported as `SKIPPED` with a reason.
4. **The wasm is not committed.** It is built from source in CI and locally; running the vault suite locally needs Rust. (Recommended; committing a non-reproducible binary would ask readers to trust it.)
5. **Constants:** `MAX_RECIPIENTS` = 100, `MAX_PENDING` = 50, the allowance chosen after measurement.

## Known limitations

- Native NEAR only; no fungible tokens (NEP-141).
- One agent per vault, one owner key, no multisig.
- No upgrade or migration method. Redeploying needs the vault account's full-access key.
- Request records are kept permanently, so storage stake grows with the number of payments (bounded per day by `max_daily_count`).
- Day boundaries follow block timestamps, not wall-clock time.
- A compromised agent can still pay allowlisted recipients up to the limits. The vault bounds the loss; it does not prevent it.
- The approval model and some reason codes differ from the off-chain engine, as described above.
- Testnet only in this repository. The scripts refuse other networks; the contract itself is network-agnostic.
- Not audited.
