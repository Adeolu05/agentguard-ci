# Live testnet run

This is the step-by-step procedure for running the NEAR testnet demo with real testnet NEAR and checking the result. It is optional. The judge steps in the README need no account, no key and no network.

**Testnet only.** Use a fresh `.testnet` account and a key created for this run. Never use a mainnet account or key. Never paste the private key or seed phrase into a chat, an issue, a commit or any file in this repository: the demo reads it only from an environment variable.

## Where each step was confirmed

The steps below were checked on 2026-11-05 against these sources. `docs.near.org` was not reachable from the environment this guide was written in, so it was checked against the source repository the site is built from, `github.com/near/docs` at commit `fa2acf6`.

| Step | Source |
| --- | --- |
| Testnet accounts, wallets, CLI installation, `near create-account ... --useFaucet` | near/docs `getting-started/create-account.mdx` |
| Faucets | near/docs `getting-started/faucet.mdx` |
| CLI commands (`add-key`, `delete-keys`, `list-keys`, `view-near-balance`, `transaction view-status`) | near/docs `tools/cli.mdx`, checked against the source of `near-cli-rs` **v0.30.1** (git tag `v0.30.1`, commit `0854b6c`), which is the latest release on npm (`npm view near-cli-rs version` returned `0.30.1`) |
| Native NEAR transfers need a full-access key | near/docs `protocol/accounts-contracts/access-keys.mdx` ("Function-Call keys ... do not allow to attach NEAR tokens") |
| Explorer link format `https://testnet.nearblocks.io/txns/<hash>` | near/docs `integrations/accounts.mdx`, `integrations/deposits.mdx`, `integrations/balance-changes.mdx`; `integrations/testing.mdx` names "Testnet NearBlocks" as the testnet explorer |
| Default RPC `https://test.rpc.fastnear.com` | near/docs `tools/near-api.mdx` |
| Status re-read by hash | `near-api-js@7.4.0`: `JsonRpcProvider.viewTransactionStatus` calls the RPC method `tx` with the hash and sender (`lib/index.js`) |

One difference to know about: `tools/cli.mdx` documents a `near generate-keypair` command, but it is not in v0.30.1, the latest release. Step 4 therefore uses `near account add-key ... autogenerate-new-keypair`, which v0.30.1 does have.

## Before you start

- Node.js 22.22.2 or newer (required by `near-api-js@7.4.0`) and pnpm 10.
- This repository, built:

  ```bash
  git clone https://github.com/Adeolu05/agentguard-ci.git && cd agentguard-ci
  pnpm install
  pnpm build
  ```

- A terminal with internet access. Run every command below from the repository root, in the same terminal session.

## 1. Install the NEAR CLI

```bash
npm install -g near-cli-rs@latest
```

The docs also list Homebrew (`brew install near`), Cargo (`cargo install near-cli-rs`) and installer scripts.

## 2. Create two testnet accounts, funded by the faucet

The agent account sends the payment. The shop account receives it. Both names must end in `.testnet`. Replace `<your-name>` with something unique.

```bash
export AGENT_ACCOUNT=<your-name>-agent.testnet
export SHOP_ACCOUNT=<your-name>-shop.testnet
```

```bash
near create-account "$AGENT_ACCOUNT" --useFaucet
```

```bash
near create-account "$SHOP_ACCOUNT" --useFaucet
```

In v0.30.1 this short form runs `near account create-account sponsor-by-faucet-service <account> autogenerate-new-keypair save-to-keychain network-config testnet create`. The faucet service creates and funds the account, and the CLI stores the account's first key in your system keychain.

On Linux without a system keychain (a headless machine, for example), saving fails with "Failed to save password to keychain". Use the legacy keychain instead, which stores keys as files in `~/.near-credentials`:

```bash
near account create-account sponsor-by-faucet-service "$AGENT_ACCOUNT" autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
```

Do the same for `$SHOP_ACCOUNT`. The `sign-with-keychain` option used below falls back to the legacy keychain when it finds no key in the system keychain.

## 3. Check both balances, and top up from a faucet if needed

```bash
near tokens "$AGENT_ACCOUNT" view-near-balance network-config testnet now
```

```bash
near tokens "$SHOP_ACCOUNT" view-near-balance network-config testnet now
```

Write down the shop account's balance: step 8 checks that it rose by exactly 0.01 NEAR. The demo sends 0.01 NEAR plus a gas fee, and adding the key in step 4 also costs gas. If the agent account needs more, use either faucet from the NEAR docs:

- The faucet built into the docs: https://docs.near.org/getting-started/faucet (enter the account and press "Request").
- The external Testnet Faucet: https://near-faucet.io/

## 4. Create a testnet-only key for the demo

A separate key lets you delete it after the run (step 9) without touching the account's first key. It must be a full-access key, because a native NEAR transfer cannot be signed with a function-call key (see `docs/integrations.md`).

```bash
near account add-key "$AGENT_ACCOUNT" grant-full-access autogenerate-new-keypair --signature-scheme ed25519 print-to-terminal network-config testnet sign-with-keychain send
```

The CLI generates a new ed25519 key pair, adds it to the account in a transaction signed with the key from step 2, and then prints an "Access key info" block that contains:

- `Public Key: ed25519:...`: keep it. You need it in step 9.
- `SECRET KEYPAIR: ed25519:...`: the private key for the demo.
- `Master Seed Phrase: ...`: the same key as words. It is just as secret.

Treat the whole block as secret. `--signature-scheme ed25519` avoids an interactive prompt; the demo accepts only `ed25519:` or `secp256k1:` keys.

## 5. Set the environment variables

```bash
export AGENTGUARD_NEAR_EXECUTION=testnet
export NEAR_TESTNET_ACCOUNT_ID="$AGENT_ACCOUNT"
export RECIPIENT="$SHOP_ACCOUNT"
```

Then read the key without echoing it or saving it in your shell history. Run the command, paste the `SECRET KEYPAIR` value (it starts with `ed25519:`) and press Enter:

```bash
read -rs NEAR_TESTNET_PRIVATE_KEY && export NEAR_TESTNET_PRIVATE_KEY
```

`NEAR_TESTNET_RPC_URL` is optional. It must use https and must not be a mainnet endpoint. The default is `https://test.rpc.fastnear.com`. All of these variables are listed, with empty values, in `.env.example`.

## 6. Allow the shop account in the policy

The demo refuses to send to an account that is not in `recipients.allowed`, and it never edits the policy itself.

```bash
perl -pi -e 's/^    - data-provider-example\.testnet$/    - data-provider-example.testnet\n    - $ENV{SHOP_ACCOUNT}/' examples/near-testnet/policy.yaml
```

```bash
grep -A4 "  allowed:" examples/near-testnet/policy.yaml
```

Expected (with your account name in the last line):

```text
  allowed:
    - merchant-example.testnet
    - data-provider-example.testnet
    - <your-name>-shop.testnet
networks:
```

## 7. Run the demo

```bash
pnpm -s --filter @agentguard/example-near-testnet demo
```

The first line must read `Testnet execution ENABLED (signer <your-name>-agent.testnet, RPC https://test.rpc.fastnear.com)`. If it starts with `Simulation only:`, a variable from step 5 is missing or malformed, and the rest of the line says which.

The first two proposals (5 NEAR, over the limit; and a mainnet account) print `BLOCK` and `Stopped before the execution boundary.` They never reach the network. The third, 0.01 NEAR to your shop account, prints `ALLOW`, is broadcast once, and then prints four lines in this format:

```text
  Transaction hash (exactly as returned by the network): <hash>
  Explorer: https://testnet.nearblocks.io/txns/<hash>
  Final status: CONFIRMED. The transfer executed on testnet.
  Re-read from the RPC by hash: CONFIRMED (matches)
```

That block shows the format only. `<hash>` stands for the real value, and this is not output from a testnet run. The wording is fixed by tests: `packages/near/test/explorer-and-output.test.ts`, and `packages/near/test/near-api-js.test.ts`, which drives the real `near-api-js@7.4.0` code against a local RPC stub.

The `Final status` line can also read:

| Final status | Meaning | What to do |
| --- | --- | --- |
| `FAILED on-chain` | The network processed the transaction and it failed (for example, the receiver does not exist), so the transfer did not go through. | Open the explorer link to see the error. |
| `NOT FINAL YET` | The network accepted the transaction but it had not finished when the demo stopped waiting. | Open the explorer link again after a short wait. |
| `UNKNOWN` | Ambiguous: the connection failed or timed out after the transaction may have been sent. The transfer may or may not have happened. | Check the agent account's history in the explorer **before** running the demo again. |

A line that starts with `Refused before signing` means nothing was signed or sent. Its reason code says why, for example `RPC_UNAVAILABLE` (the RPC could not be reached) or `RPC_NOT_TESTNET` (the RPC is not a testnet node).

Each run starts with an empty in-memory ledger, so running the demo again sends another 0.01 NEAR.

## 8. Check the transaction yourself

Do not rely on the demo's own output alone.

1. Open the `Explorer:` link. Check that the transaction succeeded, that the sender is your agent account, that the receiver is your shop account, and that it is a single transfer of 0.01 NEAR (10000000000000000000000 yoctoNEAR, that is 10^22).
2. Read it from the RPC with the NEAR CLI (replace `<hash>`):

   ```bash
   near transaction view-status <hash> network-config testnet
   ```

   It prints the RPC's full record of the transaction. Check the signer, the receiver, the deposit of the `Transfer` action and a `SuccessValue` status. The CLI may also print explorer links on a different domain, taken from its own configuration. This guide uses the NearBlocks format from the NEAR docs.
3. Check that the shop account's balance rose by exactly 0.01 NEAR since step 3:

   ```bash
   near tokens "$SHOP_ACCOUNT" view-near-balance network-config testnet now
   ```

## 9. Clean up

Delete the demo key (paste the `Public Key` from step 4), then check that it is gone from the list:

```bash
near account delete-keys "$AGENT_ACCOUNT" public-keys <ed25519:public-key-from-step-4> network-config testnet sign-with-keychain send
```

```bash
near account list-keys "$AGENT_ACCOUNT" network-config testnet now
```

Remove the key from the shell and restore the policy:

```bash
unset NEAR_TESTNET_PRIVATE_KEY AGENTGUARD_NEAR_EXECUTION
```

```bash
git checkout -- examples/near-testnet/policy.yaml
```

## 10. Record the evidence

Share only the transaction hash and the two account IDs, never the key or the seed phrase. Before anything goes into the README's [Live testnet run](../README.md#live-testnet-run) table, the hash is checked against a public testnet RPC: final status, signer, receiver and exact amount. If that check cannot be made, the table stays `pending`.
