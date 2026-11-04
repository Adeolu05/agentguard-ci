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

| Item | Source | Status |
| --- | --- | --- |
| SDK choice: `near-api-js@7.4.0` | npm registry metadata and the package README. v7 is a single package, and the README directs users of the older `@near-js/*` packages to migrate to it. | Verified from the published package |
| `new Account(accountId, provider, signer)`, `Account.signAndSendTransaction({ receiverId, actions, waitUntil, throwOnFailure })`, `actions.transfer(deposit: bigint)` | The published `.d.ts` files in `near-api-js@7.4.0` | Verified at type level, and exercised at runtime against a local RPC stub |
| `JsonRpcProvider({ url })`, `getNetworkId()` (reads `chain_id` from the `status` RPC), `viewTransactionStatus({ txHash, accountId, waitUntil })` | The published `.d.ts` files and compiled JS | Verified as above |
| `FinalExecutionStatus` = `NotStarted \| Started \| { Failure } \| { SuccessValue }`; the hash is `transaction_outcome.id` | The published types | Verified at type level |
| Default testnet RPC `https://test.rpc.fastnear.com` | The `near-api-js` README examples | **Not contacted.** It can be overridden with `NEAR_TESTNET_RPC_URL` |
| NEAR account-ID rules (2 to 64 characters; lowercase alphanumerics with non-adjacent `-`, `_` and `.` separators; implicit and ETH-implicit forms) | NEAR protocol account-ID rules | Implemented from protocol knowledge; `docs.near.org` was unreachable, so re-check against the current docs |
| Official NEAR documentation (`docs.near.org`) and hackathon rules (`nearhackathon.com`) | | **Not reachable** from the build environment |

### What works

- **Offline (tested):** account-ID validation in the engine. This covers syntax and cross-network accounts such as `*.near` on testnet and `*.testnet` on mainnet. Exact 24-decimal yoctoNEAR limits and the NEAR scenario pack (`examples/near-testnet`, 6 scenarios) also work offline.
- **Executor (tested against fakes and a local JSON-RPC stub):** `NearTestnetExecutor.execute(reservationId)`:
  1. Refuses unless the reservation is `near-testnet` and `NEAR`, the recipient is a valid account ID, and the signer is a testnet account.
  2. Calls `getNetworkId()` and refuses unless it returns `testnet`. Nothing has been signed at this point.
  3. Calls `engine.beginExecution()`, which rejects stale policies and double execution.
  4. Signs and broadcasts one native transfer with `waitUntil: "FINAL"` and `throwOnFailure: false`.
  5. Records `confirmed` or `failed` with the hash returned by the network. On a thrown error, a timeout or a missing hash it returns `unknown` and leaves the reservation `submitted`.

  When a transfer is still pending, the network's hash is stored on the reservation. `reconcile(reservationId, hash)` re-reads the status by hash. It accepts only the stored hash or, when none was stored because the broadcast outcome was ambiguous, a transaction whose signer, receiver and exact amount match the reservation. An unrelated hash cannot settle or release a reservation. The stub test decodes the signed transaction and checks the signer, receiver, a single transfer action with the exact deposit, `wait_until: FINAL`, and that the ed25519 signature verifies over `sha256(borsh(tx))`.
- **Configuration** is off by default:

  ```bash
  AGENTGUARD_NEAR_EXECUTION=testnet          # explicit opt-in
  NEAR_TESTNET_ACCOUNT_ID=<you>.testnet
  NEAR_TESTNET_PRIVATE_KEY=ed25519:...        # testnet-only key; never mainnet
  NEAR_TESTNET_RPC_URL=https://...            # optional; must be https and not look like mainnet
  ```

### What is not done

- **No live testnet transaction has been executed or verified.** The build environment's network policy blocked NEAR endpoints. Until someone runs `examples/near-testnet/demo.mjs` with a funded testnet account and checks the printed hash on a block explorer, treat the on-chain path as **unverified**.
- Only native NEAR transfers. Fungible tokens (NEP-141), function calls and meta-transactions are not supported.
- No mainnet support, by design.

### Verifying the integration yourself

1. Create a testnet account and fund it from the official faucet (see the NEAR docs).
2. Add an existing testnet account you control as a recipient in `examples/near-testnet/policy.yaml`.
3. Run the demo with the environment variables above and `RECIPIENT=<that account>`.
4. Check that the printed hash exists on a testnet explorer, with the same sender, receiver and amount, and that the demo's re-read status matches.
5. Record the hash and the date in this document. Only after that should the on-chain integration be described as working.
