# Contributing

Thank you for helping make agent payments safer.

## Setup

```bash
pnpm install
pnpm check      # lint, build (packages and dashboard), typecheck, tests
```

You need Node.js 22.22 or newer and pnpm 10.

## Ground rules

- **Correctness first.** A change to the engine, ledger, approvals or runner needs tests for both the positive and negative cases. Security fixes need a regression test.
- **Fail closed.** No new code path may produce `ALLOW`, or a `PASS` result, on an error.
- **No floating point** in any amount handling.
- **Reason codes are a public contract.** Add new codes, never rename existing ones. After changing `packages/core/src/reasons.ts`, run `pnpm build && node scripts/reason-codes.mjs --write`. A test checks that `docs/policy-schema.md` is up to date.
- **Honest claims.** Documentation must describe verified behaviour. Label anything unverified as such.
- Keep dependencies minimal. Pin GitHub Actions to full commit SHAs.

## Contributing scenarios

New built-in scenarios go in `packages/cli/templates/scenarios/<category>/`. A good scenario:

- tests one security property, with its most important assertion first;
- uses boundary values (exactly at a limit, and one atomic unit above it);
- has a severity justified by [docs/findings.md](docs/findings.md) and a concrete remediation;
- passes against the default policy and fails against a policy that violates the property. Add a runner test that shows the failure if the property is new.

Run `pnpm test` and `pnpm agentguard test --config examples/payment-policy/agentguard.yaml` before opening a pull request.

## Integrations

Integrations live in their own package and plug in through `ProposalValidator`, through custom targets, or through an executor that calls `beginExecution()`. Before you claim that an integration works against a real network, run it end to end and record the evidence in `docs/integrations.md`.
