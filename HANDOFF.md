# Handoff: NEAR HACKATHON work on `near-hackathon`

Branch `near-hackathon` on origin. Nothing was pushed to `main` and no PR was opened.

## Done

- Phase 0 and 1: README judge steps, docs re-verified against near/docs `fa2acf6`, hackathon submission page.
- Phase 2 (prepared, not run on testnet): testnet demo prints the hash as returned, a NearBlocks link and the final status; `docs/testnet-run.md`.
- Phase 3: the Drainproof Vault contract (`contracts/vault`), sandbox tests, scenario target, demo and testnet-only scripts (`examples/near-vault`), the runner's `unsupported()` hook, the `vault` CI job.
- Review fixes (2026-11-06): expired pending requests no longer hold the 50 approval slots (`request_payment` frees one when the queue is full; owner method `clear_expired`; expired requests are deleted, which keeps storage bounded); `docs/vault-design.md` describes what was built, with numbers measured on a local sandbox; neutral source notes; the vault in the threat model, `docs/integrations.md` and `docs/hackathon-submission.md`; `pnpm bench` reproduces the README's timing figures.

## Not verified yet

- The `vault` CI job has never run on GitHub (CI runs only on pull requests and `main`).
- Nothing has run on the real testnet. The testnet scripts were rehearsed only against a local sandbox behind an HTTPS proxy that reported the chain id as `testnet`.

## Tests that last passed (2026-11-06, Node 24.10.0, pnpm 10.28.0, Rust 1.97.0, cargo-near 0.22.0, WSL Ubuntu 24.04)

| Command | Result |
| --- | --- |
| `pnpm check` | 283 tests passed in 16 files |
| payment-policy, near-testnet and fixed-guard suites | 40/40, 6/6, 40/40 |
| `cargo test` in `contracts/vault` | 40 passed |
| `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` | clean |
| `pnpm test:vault` (local NEAR sandbox) | 30 passed |
| `pnpm -s drainproof test --config examples/near-vault/drainproof.yaml --no-save` | 16 pass, 0 fail, 0 errors, 24 skipped, exit 0 |
| `pnpm --filter @drainproof/example-near-vault demo` | allowed PAID, injected BLOCK, large PENDING, agent key refused twice, exit 0 |

Sandbox commands need an open-file limit of 65535: run them with `ulimit -n 65535 &&` in front.

## Next steps

1. Phase 4 (built, 2026-11-06): `examples/llm-agent`, 12 offline tests. Still needed: a real NEAR AI Cloud run recorded by the owner (`NEAR_AI_API_KEY=... pnpm --filter @drainproof/example-llm-agent demo -- --record`), reviewed and committed in place of the labelled stand-in recording; then add the demo to the README judge steps with its real output.
2. Phase 5: `apps/web` deployable to Vercel in demo mode; Node 20 and 22 checks.
3. Phase 6: audits, fresh-clone rerun of every README command, and the plan to strip the AI trailers from the first 7 commits on `main` (before/after list, explicit approval before any `--force-with-lease` push).
4. When the owner sends a testnet hash, verify status, signer, receiver and exact amount via a public RPC before filling the README's Live testnet run table.
5. Decide whether to delete this file before submission.
