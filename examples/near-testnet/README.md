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

**Verification status:** the adapter is tested against a fake client and, through the real `near-api-js@7.4.0` code, against a local JSON-RPC stub. Those tests check that blocked proposals make no RPC request at all, that exactly one transaction is broadcast per reservation, and that the signed transfer has the right receiver and amount. The SDK calls were checked against the official NEAR docs (source repository `github.com/near/docs`, commit `fa2acf6`). A live testnet run is pending and none is claimed yet; see the README's [Live testnet run](../../README.md#live-testnet-run) section. Follow the step-by-step procedure in [docs/integrations.md](../../docs/integrations.md#performing-and-verifying-a-real-testnet-transfer) and check the hash it prints before relying on it.

Never use a mainnet key here. Never commit keys; pass them through the environment or your CI secret store.
