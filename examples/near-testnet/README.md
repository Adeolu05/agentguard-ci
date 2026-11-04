# NEAR testnet example

This example has two parts.

1. **Policy test suite (works offline).** NEAR-specific scenarios run with the NEAR account-ID validator enabled: account-ID syntax, cross-network accounts, mainnet blocking, exact 24-decimal yoctoNEAR limits, and concurrent spending against a daily limit.

   ```bash
   pnpm --filter @agentguard/example-near-testnet test
   ```

2. **Execution demo (`demo.mjs`).** By default this is a simulation: it evaluates three proposals and states that nothing was signed or sent. Real testnet execution happens only if you opt in with a **testnet** account you control:

   ```bash
   AGENTGUARD_NEAR_EXECUTION=testnet \
   NEAR_TESTNET_ACCOUNT_ID=<you>.testnet \
   NEAR_TESTNET_PRIVATE_KEY=ed25519:<testnet-only key> \
   RECIPIENT=<existing testnet account, also added to policy.yaml> \
   pnpm --filter @agentguard/example-near-testnet demo
   ```

   The allowed proposal passes through the AgentGuard execution gate (`beginExecution`), is broadcast with `near-api-js` (`Account.signAndSendTransaction` with a `transfer` action), and its status is then re-read from the RPC by transaction hash (`JsonRpcProvider.viewTransactionStatus`). The executor refuses to run if the RPC does not report `testnet`, or if the signer is not a testnet account.

**Verification status:** the adapter is unit-tested against a fake client, and type-checked against `near-api-js@7.4.0`. It has **not** yet been run end-to-end against NEAR testnet, because the environment this release was built in had no network access to NEAR RPC endpoints. Run the demo with your own testnet account and check the hash it prints before relying on it. See [docs/integrations.md](../../docs/integrations.md).

Never use a mainnet key here. Never commit keys; pass them through the environment or your CI secret store.
