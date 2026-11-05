# AgentGuard Vault example

The [AgentGuard Vault](../../contracts/vault) is a NEAR contract that holds the funds and enforces the payment policy on-chain. The agent never holds a key that can move money: it holds a **function-call key** that can call one method, `request_payment`, on the vault. The vault checks the recipient allowlist, the per-transaction and daily limits, owner approval above a threshold, idempotency and a pause switch before it pays anything. Design and threat model: [docs/vault-design.md](../../docs/vault-design.md).

| File | What it does |
| --- | --- |
| `test/vault.sandbox.test.ts` | Integration tests against the real contract on a local NEAR node |
| `vault-target.mjs`, `agentguard.yaml` | Runs the built-in AgentGuard scenarios against the vault (local node) |
| `demo.mjs` | One payment that goes through and one that is blocked, with the contract's event logs (local node by default, testnet opt-in) |
| `deploy.mjs` | Deploys the vault to **testnet only** |
| `add-agent-key.mjs` | Gives the agent its function-call key (**testnet only**) |
| `push-policy.mjs` | Installs a YAML policy in the vault (**testnet only**; dry run by default) |
| `policy.yaml` | The vault's policy (native NEAR, testnet) |

## Run it locally (no account, no key, no testnet)

Needs Rust (through `rustup`, which installs the toolchain pinned in `contracts/vault/rust-toolchain.toml`) and [cargo-near](https://github.com/near/cargo-near) 0.22.0. The first run downloads the NEAR sandbox node (nearcore 2.14.0). From the repository root:

```bash
pnpm install && pnpm build
```

```bash
pnpm build:vault
```

```bash
pnpm test:vault
```

```bash
pnpm -s agentguard test --config examples/near-vault/agentguard.yaml --no-save
```

```bash
pnpm --filter @agentguard/example-near-vault demo
```

Results of these commands on 2026-11-05 (Node 22.23.4, Rust 1.97.0, Linux):

- `cargo test` in `contracts/vault`: 35 unit tests pass.
- `pnpm test:vault`: 28 sandbox tests pass.
- Built-in scenarios against the vault: 16 pass, 0 fail, 24 are skipped, each with its reason (`Result: PASSED (exit code 0)`). Which scenarios apply, and why the others do not, is explained in [docs/vault-design.md](../../docs/vault-design.md#scenario-target-which-built-in-scenarios-apply).
- The demo prints `ALLOW` for the allowed payment, followed by its `payment_settled` event with status `PAID`; `BLOCK (RECIPIENT_NOT_ALLOWED)` with its `EVENT_JSON` log line for the injected one; `REQUIRE_APPROVAL` for the payment above the threshold; and the protocol rejecting the agent's key when it tries to call `withdraw` ("Access key does not allow method withdraw") or to transfer NEAR ("Access key requires full access").

**Open-file limit.** nearcore 2.14.0 raises its open-file limit to 65535 when it starts (`neard/src/main.rs` in nearcore). Where the hard limit is lower, for example in some containers, the sandbox exits with "couldn't set the file descriptor limit". Raise the limit (for Docker: `--ulimit nofile=65535:65535`).

## Run it on testnet (opt-in)

Testnet only: every script checks that the RPC node reports `testnet` and that every account is a `.testnet` account before it signs anything, and refuses otherwise. Keys come only from environment variables (see [.env.example](../../.env.example)). Never use a mainnet key.

You need three testnet accounts (see [docs/testnet-run.md](../../docs/testnet-run.md) steps 1 to 3 for creating and funding them): the **owner** (needs a little over 3 NEAR), the **agent** (needs a small balance for gas) and a **shop** to pay. Add the shop account to `recipients.allowed` in `policy.yaml`. Then, from this directory:

1. Check what will be deployed (signs nothing):

   ```bash
   NEAR_TESTNET_ACCOUNT_ID=<owner>.testnet AGENTGUARD_VAULT_ACCOUNT_ID=vault.<owner>.testnet AGENTGUARD_AGENT_ACCOUNT_ID=<agent>.testnet node deploy.mjs --dry-run
   ```

2. Deploy, as the owner. With `AGENTGUARD_NEAR_EXECUTION=testnet` exported and the owner's key read into `NEAR_TESTNET_PRIVATE_KEY` (`read -rs NEAR_TESTNET_PRIVATE_KEY && export NEAR_TESTNET_PRIVATE_KEY`):

   ```bash
   node deploy.mjs
   ```

   It creates `vault.<owner>.testnet` with 3 NEAR (`AGENTGUARD_VAULT_FUNDING`), deploys the contract, initialises it in the same transaction and checks that the on-chain policy equals the YAML policy. About 1.9 NEAR stays locked as storage stake for the contract code.

3. Give the agent its function-call key, signed once with the agent account's full-access key (set `NEAR_TESTNET_ACCOUNT_ID` and `NEAR_TESTNET_PRIVATE_KEY` to the agent account for this step):

   ```bash
   node add-agent-key.mjs
   ```

   It reads the key back from the chain and checks that it can call only `request_payment` on the vault. The new private key is printed once; read it into `AGENTGUARD_AGENT_PRIVATE_KEY`.

4. Later policy changes go through the same YAML file (dry run first, then `--send` as the owner):

   ```bash
   node push-policy.mjs
   ```

5. Run the demo against your vault, signed with the agent's function-call key:

   ```bash
   RECIPIENT=<shop>.testnet node demo.mjs
   ```

   It prints the transaction hash of each request as returned by the network, its NearBlocks testnet link, the vault's decision and the event logs. Check both hashes in the explorer.

6. Clean up: revoke the agent's key (`add-agent-key.mjs` prints the exact `near account delete-keys` command), and withdraw the vault's funds as the owner:

   ```bash
   near contract call-function as-transaction vault.<owner>.testnet withdraw json-args '{"amount":"<yoctoNEAR>"}' prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as <owner>.testnet network-config testnet sign-with-keychain send
   ```

## Verification status

- The contract, the sandbox tests, the scenario target and the demo were run as described above.
- The testnet scripts were rehearsed end to end against a local sandbox placed behind an HTTPS proxy that reported the node as `testnet`: deploy, refusal to redeploy, adding and verifying the agent's key, pushing a changed policy (and refusing it when signed by the agent), and the demo's allowed and blocked requests all behaved as described. **They have not been run against the real testnet**, and no vault transaction on testnet is claimed.
- The NEAR tools and APIs used are cited in [docs/vault-design.md](../../docs/vault-design.md#sources).
