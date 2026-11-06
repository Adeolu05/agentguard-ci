# Recipient-check scenario pack

Eight scenarios about **who** the agent pays, run against the same policy as the built-in suite ([examples/payment-policy/policy.yaml](../payment-policy/policy.yaml), allowlist `merchant-example` and `data-provider-example`). Every proposal is 5 USDC, below every limit, so the recipient check is the only rule that can stop it. Each scenario ends with a payment to the real allowlisted account that must be **allowed**, so a target that blocks everything does not pass.

| Scenario | Recipients that must be blocked |
| --- | --- |
| `lookalike-zero-for-o` | `data-pr0vider-example`, `data-pr0vider-examp1e` |
| `lookalike-one-for-l` | `merchant-examp1e`, `data-provider-examp1e` |
| `lookalike-rn-for-m` | `rnerchant-example`, `merchant-exarnple` |
| `lookalike-small-edits` | `merchant-exampel`, `merchant-exmple`, `merchant-examples`, `merchamt-example`, `merchant_example`, `merchant.example` |
| `lookalike-network-suffix` | `merchant-example.testnet`, `merchant-example.near` |
| `not-allowlisted-partial-match` | `merchant-example-payout`, `evil-merchant-example`, `pay.merchant-example`, `merchant`, `example` |
| `not-allowlisted-unknown` | `attacker-wallet`, `attacker.testnet`, a 64-character implicit account |
| `lookalike-unicode-homoglyph` | `data-prоvider-example` and `merchant-exampӏe` (Cyrillic о and ӏ), expected `RECIPIENT_INVALID` |

All other look-alikes are expected `BLOCK` with exactly `RECIPIENT_NOT_ALLOWED`. Every recipient except the two Cyrillic ones is a valid NEAR account ID.

## Run it

From the repository root, after `pnpm install && pnpm build`:

```bash
pnpm -s drainproof test --config examples/recipient-checks/drainproof.yaml --no-save --quiet | grep -E "Passed:|Failed:|Errors:|Skipped:|Result"
```

Against the [Drainproof Vault](../near-vault) on a local NEAR node (needs Rust and `pnpm build:vault`, see the README's [Verify the vault yourself](../../README.md#verify-the-vault-yourself-optional)):

```bash
ulimit -n 65535 && pnpm -s drainproof test --config examples/recipient-checks/drainproof.vault.yaml --no-save
```

## Results (2026-11-06, Node 24.10.0, local NEAR sandbox 2.14.0)

| Target | Passed | Failed | Errors | Skipped | Exit code |
| --- | ---: | ---: | ---: | ---: | ---: |
| Drainproof policy engine | 8 | 0 | 0 | 0 | 0 |
| Drainproof Vault contract | 7 | 0 | 0 | 1 | 0 |

**What the vault target cannot express:** `lookalike-unicode-homoglyph`. The vault takes NEAR account IDs, and the Cyrillic look-alikes are not valid ones, so the scenario target skips it with this reason: *"its recipient ... is not a valid NEAR account ID ... the vault blocks every such string as RECIPIENT_INVALID, which the vault's own tests check"*. Those tests are `blocks recipient strings that are not NEAR account IDs` in [vault.sandbox.test.ts](../near-vault/test/vault.sandbox.test.ts) (both Cyrillic forms, against a real local node) and the contract's unit tests. The other seven scenarios ran as real `request_payment` transactions signed with the agent's function-call key, and the contract's own decisions matched.

## Does the pack catch loose matching?

[test/recipient-checks.test.ts](test/recipient-checks.test.ts) runs the pack against eight guards that each use a different recipient matcher ([test/loose-matchers.mjs](test/loose-matchers.mjs)); seven are deliberately wrong. It is part of `pnpm test`. Each wrong matcher fails exactly these scenarios:

| Matcher | Scenarios that fail |
| --- | --- |
| exact (`===`), the correct one | none |
| `includes` either way | network-suffix, small-edits, partial-match |
| `startsWith` | network-suffix, small-edits, partial-match |
| `endsWith` | partial-match |
| edit distance at most 1 | zero-for-o, one-for-l, small-edits, unicode-homoglyph |
| look-alike folding (lower case, 0 to o, 1 to l, rn to m, Cyrillic to Latin) | zero-for-o, one-for-l, rn-for-m, unicode-homoglyph |
| strip `.testnet` or `.near` | network-suffix |
| treat `_` and `.` as `-` | small-edits |
