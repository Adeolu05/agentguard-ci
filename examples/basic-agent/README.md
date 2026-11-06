# Basic agent example

This example shows how to test **your own guard** with Drainproof. A custom target is an ES module that exports `createTarget(context)`; the [scenario docs](../../docs/scenarios.md#custom-targets) describe the interface.

| File | What it is |
| --- | --- |
| `naive-guard.mjs` | A typical hand-rolled spending check. It uses `parseFloat`, case-insensitive recipient matching, no daily accounting, and trusts an `approved` flag from the agent. |
| `drainproof-guard.mjs` | The same guard built on `@drainproof/core`. |
| `agent-demo.mjs` | A simulated agent loop (no LLM, no network) in which a malicious tool response tries to redirect a payment. |

From the repository root, after `pnpm install && pnpm build`:

```bash
pnpm --filter @drainproof/example-basic-agent test:naive   # FAILED, exit code 1: the naive guard's bugs are reported
pnpm --filter @drainproof/example-basic-agent test:fixed   # PASSED, exit code 0
pnpm --filter @drainproof/example-basic-agent demo
```

The naive guard does not report reason codes or support approvals, lifecycle or ledger inspection. The runner therefore checks its *decisions* only, and marks scenarios that need missing capabilities as `SKIPPED`, never `PASS`.
