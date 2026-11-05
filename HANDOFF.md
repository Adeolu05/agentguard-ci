# Handoff: NEAR HACKATHON work on `near-hackathon`

Branch `near-hackathon` on origin. Nothing was pushed to `main` and no PR was opened.

## Done

- Phase 0 and 1: README judge steps, docs re-verified against near/docs `fa2acf6`, hackathon submission page.
- Phase 2 (prepared, not run on testnet): testnet demo prints the hash as returned, a NearBlocks link and the final status (`describeExecution`, read-only `checkStatus`); `docs/testnet-run.md`.
- Phase 3 (approved design, implemented):
  - `contracts/vault`: the AgentGuard Vault contract (near-sdk 5.30.0, cargo-near 0.22.0, Rust 1.97.0 pinned).
  - `examples/near-vault`: sandbox harness and integration tests, scenario target (`vault-target.mjs`), demo, and testnet-only `deploy.mjs`, `add-agent-key.mjs`, `push-policy.mjs`.
  - `@agentguard/runner`: optional `unsupported(scenario)` hook. `@agentguard/near`: `vaultPolicyFromPolicy`, `checkTestnetAccountId`, `checkDirectSubAccount`.
  - CI job `vault` in `.github/workflows/ci.yml` (actions pinned to SHAs, cargo-near checksum-verified).

## Half-done (WIP)

- README vault section is committed but its judge test count (250) has not been re-checked.
- `docs/vault-design.md` still describes the proposal: status line, storage layout (the allowlist is stored inside the policy, not in a separate set), measured numbers, real scenario results and the approved decisions all need updating.
- `docs/integrations.md` and `docs/hackathon-submission.md` do not mention the vault yet.
- The `vault` CI job has never run on GitHub (CI runs only on pull requests and `main`).

## Tests that last passed (2026-11-05, this session)

| Command | Result |
| --- | --- |
| `cargo test` in `contracts/vault` | 35 passed |
| `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` | clean |
| `pnpm test:vault` (local NEAR sandbox) | 28 passed |
| `pnpm -s agentguard test --config examples/near-vault/agentguard.yaml --no-save` | 16 pass, 0 fail, 0 errors, 24 skipped, exit 0 |
| `npx vitest run packages/near` | 85 passed |
| `npx vitest run packages/runner` | 37 passed |
| `pnpm --filter @agentguard/example-near-vault demo` | allowed payment PAID, injected one BLOCK, exit 0 |
| `pnpm check` (last full run, before Phase 3) | 250 passed in 14 files; **not re-run since Phase 3** |
| payment-policy and near-testnet suites (before Phase 3) | 40/40 and 6/6 |

Environment note: nearcore 2.14.0 requires an open-file limit of 65535. The container used here had a hard limit of 20000, so local sandbox runs used a preload shim kept outside the repository. GitHub runners should not need it.

The testnet scripts were rehearsed only against a local sandbox behind an HTTPS proxy that reported the chain id as `testnet`. Nothing has run on the real testnet.

## Next steps

1. Review fix: expired `PENDING` requests keep occupying the 50 `MAX_PENDING` slots. Free them automatically, or add an owner method to clear expired ones, with unit and sandbox tests.
2. Review fix: `docs/vault-design.md` line 3 still says no contract code has been written. Update the status and the sections listed under Half-done.
3. Review fix: rephrase the lines saying `docs.near.org` is not reachable from the environment, in `docs/vault-design.md` and `docs/testnet-run.md`, to a neutral source note (for example: "checked against the source repository of docs.near.org, github.com/near/docs, commit fa2acf6").
4. Run `pnpm check`, the example suites, `pnpm test:vault` and the vault scenarios; put the real counts in the README; sweep the repository for U+2014; commit in small commits under the owner's name only, with no AI or session lines.
5. Phase 2.4: when the owner sends a testnet hash, verify status, signer, receiver and exact amount via a public RPC (needs `test.rpc.fastnear.com` and `testnet.nearblocks.io` allowed) before filling the README's Live testnet run table.
6. Then Phase 4 (LLM prompt-injection demo), Phase 5 and Phase 6 as specified. Phase 6 includes the plan to strip the Claude trailers from the first 7 commits on `main` and from PR #1's description, with a before/after list and explicit approval before any `--force-with-lease` push.
7. Stop at every remaining CHECKPOINT and wait for the owner's reply.
