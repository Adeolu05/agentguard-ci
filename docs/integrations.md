# Integrations

## Adapter boundary

Integrations plug into AgentGuard at three separate points:

| Stage | Interface | May move money? |
| --- | --- | --- |
| Validation | `ProposalValidator`, passed to `PolicyEngine({ validators })`. It can only *add* reasons, for example NEAR account-ID syntax. | No |
| Policy evaluation and reservation | `PolicyEngine.authorize()` | No |
| Execution | An executor that calls `engine.beginExecution(reservationId)` before broadcasting, then `recordOutcome()` | Yes, and only after the gate succeeds |

A custom **scenario target** (see [scenarios.md](scenarios.md#custom-targets)) is how you connect an agent framework or your own guard to the test runner.

## NEAR (`@agentguard/near`)

### Sources and verification

Checked on 2026-11-05 against the official documentation source repository, `github.com/near/docs` at commit `fa2acf6` (2026-11-05), and the published `near-api-js` package. The three documentation pages cited below are unchanged since commit `e2d2ea1` (2026-11-01), where they were first checked.

| Item | Source | Status |
| --- | --- | --- |
| SDK: `near-api-js@7.4.0` (latest on npm, not deprecated) | npm registry; the package README directs users of the older `@near-js/*` packages to migrate to it | Verified |
| `new JsonRpcProvider({ url })`, `new Account(accountId, provider, privateKey)`, private key passed as `KeyPairString` from the environment | Official docs `tools/near-api.mdx` (send-tokens and account examples) and the published `.d.ts` | Verified against docs and types; exercised at runtime against a local RPC stub |
| `Account.signAndSendTransaction({ receiverId, actions, waitUntil, throwOnFailure, retries })`, `actions.transfer(deposit: bigint)` | Published `.d.ts` and compiled JS of `near-api-js@7.4.0`. The docs show the higher-level `account.transfer()`, which throws on an on-chain failure; AgentGuard uses the lower-level call so that a failed transfer still returns its hash. | Verified at type level and at runtime against the stub |
| `provider.viewTransactionStatus({ txHash, accountId, waitUntil })` | Official docs `tools/near-api.mdx` and the published types | Verified against docs and types |
| `getNetworkId()` reads `chain_id` from the `status` RPC | Compiled JS of `near-api-js@7.4.0` | Verified (stub) |
| Default testnet RPC `https://test.rpc.fastnear.com` | Official docs examples (`tools/near-api.mdx`) | Documented endpoint, used as the default. Override with `NEAR_TESTNET_RPC_URL`. It has not yet been exercised by a recorded live run (see below). |
| Account-ID rules: 2 to 64 characters, lowercase `a-z`, `0-9` and `.` `-` `_` separators; implicit (64 hex), ETH-like (`0x`), deterministic (`0s`) and universal (`0u`) forms | Official docs `protocol/accounts-contracts/account-id.mdx` | Verified. The validator also rejects leading, trailing or adjacent separators (protocol rule). It accepts `0s` and `0u` recipients; the executor accepts only `*.testnet` and implicit signers, which is stricter than necessary for universal accounts. |
| Testnet funding: the faucet on the docs site (native NEAR) and `near-faucet.io` | Official docs `getting-started/faucet.mdx` | Verified as documented; not used |
| Explorer link format `https://testnet.nearblocks.io/txns/<hash>` (`testnetExplorerTxUrl`) | Official docs `integrations/accounts.mdx`, `integrations/deposits.mdx` and `integrations/balance-changes.mdx` link testnet transactions this way; `integrations/testing.mdx` names "Testnet NearBlocks" as the testnet explorer | Verified as documented. A link is only built from a well-formed base58 hash. |
| `viewTransactionStatus` sends the RPC method `tx` with `tx_hash`, `sender_account_id` and `wait_until` | Compiled JS of `near-api-js@7.4.0` | Verified (stub) |
| A native NEAR transfer must be signed with a full-access key; function-call keys cannot attach NEAR | Official docs `protocol/accounts-contracts/access-keys.mdx` | Verified as documented. The demo key is therefore full access (see "What is not done"). |
| NEAR CLI commands used in [testnet-run.md](testnet-run.md) | Official docs `tools/cli.mdx` and `getting-started/create-account.mdx`, checked against the `near-cli-rs` v0.30.1 source (latest on npm) | Verified against the source. `near generate-keypair`, documented in `tools/cli.mdx`, is not in v0.30.1, so the guide uses `account add-key ... autogenerate-new-keypair`. |

### Broadcast retries (fixed)

Inspecting the `near-api-js@7.4.0` source showed two automatic retry layers:

- `JsonRpcProvider` re-sends a request (including a signed transaction) on HTTP 500, 503 or 408, or on a fetch error. By default it tries up to 12 times.
- `Account.signAndSendTransaction` **re-signs with a new nonce** and sends again on `InvalidNonceError`, by default up to 10 times.

If a first broadcast landed but its response was lost, these could combine into a second, different transfer. The stub tests reproduced both paths with the previous client: each produced two `send_tx` requests. The client now routes broadcasts through a provider with a single HTTP attempt and passes `retries: 0`. Reads keep the default retries. Exactly one transaction is broadcast per authorised reservation. Any failure after signing returns `unknown`, and the reservation stays `submitted` (still counting toward limits) until `reconcile()` settles it.

### What works

- **Offline (tested):** account-ID validation in the engine. This covers syntax and cross-network accounts such as `*.near` on testnet and `*.testnet` on mainnet. Exact 24-decimal yoctoNEAR limits and the NEAR scenario pack (`examples/near-testnet`, 6 scenarios) also work offline.
- **Executor (tested against fakes and a local JSON-RPC stub):** `NearTestnetExecutor.execute(reservationId)`:
  1. Refuses unless the reservation is `near-testnet` and `NEAR`, the recipient is a valid account ID, and the signer is a testnet account.
  2. Calls `getNetworkId()` and refuses unless it returns `testnet`. Nothing has been signed at this point.
  3. Calls `engine.beginExecution()`, which rejects stale policies and double execution.
  4. Signs and broadcasts exactly one native transfer with `waitUntil: "FINAL"` and `throwOnFailure: false`. There is no automatic re-send or re-sign (see "Broadcast retries" above).
  5. Records `confirmed` or `failed` with the hash returned by the network. On a thrown error, a timeout or a missing hash it returns `unknown` and leaves the reservation `submitted`.

  `checkStatus(hash)` is a read-only lookup by hash: it reports the network's status and never changes the ledger. The demo uses it to re-read every executed transfer, and `describeExecution()` prints the hash exactly as the network returned it, the explorer link and the final status, calling an ambiguous outcome `UNKNOWN`.

  When a transfer is still pending, the network's hash is stored on the reservation. `reconcile(reservationId, hash)` re-reads the status by hash. It accepts only the stored hash or, when none was stored because the broadcast outcome was ambiguous, a transaction whose signer, receiver and exact amount match the reservation. An unrelated hash cannot settle or release a reservation. The stub test decodes the signed transaction and checks the signer, receiver, a single transfer action with the exact deposit, `wait_until: FINAL`, and that the ed25519 signature verifies over `sha256(borsh(tx))`.
- **Configuration** is off by default:

  ```bash
  AGENTGUARD_NEAR_EXECUTION=testnet          # explicit opt-in
  NEAR_TESTNET_ACCOUNT_ID=<you>.testnet
  NEAR_TESTNET_PRIVATE_KEY=ed25519:...        # testnet-only key; never mainnet
  NEAR_TESTNET_RPC_URL=https://...            # optional; must be https and not look like mainnet
  ```

### AgentGuard Vault (on-chain enforcement)

The executor above signs native transfers, which needs a full-access key. The [AgentGuard Vault](vault-design.md) removes that requirement: a NEAR contract (`contracts/vault`, Rust, `near-sdk` 5.30.0) holds the funds and enforces the policy itself (recipient allowlist, per-transaction and daily limits, owner approval above a threshold with expiry, idempotency, pause). The agent holds only a function-call key that can call `request_payment` on the vault and nothing else, so even a fully compromised agent can only make payments the policy allows.

- `vaultPolicyFromPolicy(policy)` in `@agentguard/near` converts a YAML policy into the vault's on-chain policy, or lists why it cannot (one asset `NEAR` with 24 decimals, `near-testnet` only, valid account IDs).
- `checkTestnetAccountId` and `checkDirectSubAccount` guard the testnet scripts in [`examples/near-vault`](../examples/near-vault) (`deploy.mjs`, `add-agent-key.mjs`, `push-policy.mjs`), which refuse to sign unless the RPC reports `testnet`.
- **Tested on a local NEAR node only** (nearcore 2.14.0 through the official `near-sandbox` package): 40 contract unit tests, 30 sandbox integration tests, and 16 of the 40 built-in scenarios run against the contract (24 skipped, each with its reason). The vault has **not** been deployed to testnet, and no vault transaction is claimed. Run it with the commands in [examples/near-vault/README.md](../examples/near-vault/README.md).

### What is not done

- **Live testnet run: pending.** No live testnet transaction has been executed or verified, and none is claimed. Treat the on-chain path as unverified until the procedure in [testnet-run.md](testnet-run.md) has been run and its result recorded in the README's [Live testnet run](../README.md#live-testnet-run) section.
- The executor signs with a **full-access key**, because native transfers need one. Whoever holds that key can do anything with the account, so use a dedicated testnet account and delete the key after the run (the guide shows how). The vault avoids this for the agent (see above), but it has not run on testnet yet.
- Only native NEAR transfers. Fungible tokens (NEP-141), function calls and meta-transactions are not supported.
- No mainnet support, by design.

### Performing and verifying a real testnet transfer

Follow [testnet-run.md](testnet-run.md). It lists the exact steps (create and fund a testnet account, create a testnet-only key, set the variables, run the demo, check the hash in the explorer, delete the key) and the official source for each tool and URL. Only after the hash has been checked against the network does it go into the README's [Live testnet run](../README.md#live-testnet-run) section.
