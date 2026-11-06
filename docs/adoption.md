# Using Drainproof in your own project

**On GitHub, the simplest path is the GitHub Action:** one `uses: Adeolu05/drainproof@<commit-sha>` step and a policy file, with no installation in your repository. See the README section [Add it to your repository](../README.md#add-it-to-your-repository-github-action). The rest of this page is for running the CLI yourself, locally or in another CI system.

The `@drainproof/*` packages are not published to npm yet. Until they are, install them from local tarballs. This path was verified on 2026-11-04 in a fresh npm project unrelated to this repository: install, `npm ci`, `init`, `test`, and every `run:` step of the generated GitHub workflow.

## 1. Build the tarballs (in a clone of this repository)

```bash
git clone https://github.com/Adeolu05/drainproof.git && cd drainproof
pnpm install
pnpm pack:local /path/to/your-project/vendor/drainproof
```

This writes `drainproof-{core,runner,cli,near}-0.1.0.tgz`.

## 2. Install them in your project

```bash
cd /path/to/your-project
npm install -D ./vendor/drainproof/drainproof-core-0.1.0.tgz \
               ./vendor/drainproof/drainproof-runner-0.1.0.tgz \
               ./vendor/drainproof/drainproof-cli-0.1.0.tgz
```

- All three are needed. Installing only the CLI tarball fails with an npm 404, because npm then looks for the other two on the public registry.
- `package.json` records `file:vendor/drainproof/…` paths. Commit the `vendor/drainproof/*.tgz` files and your lockfile, and `npm ci` works in CI without npm publication.
- The NEAR integration is optional: add `drainproof-near-0.1.0.tgz` only if you set `integrations.near` in `drainproof.yaml`. That adds the NEAR SDK (about 70 packages). Without it, Drainproof installs 5 packages. If the integration is enabled but the package is missing, `drainproof test` exits with code 2 and says what to install.
- pnpm works the same way: `pnpm add -D ./vendor/drainproof/…`.

## 3. Initialise and run

```bash
npx drainproof init --github-actions   # drainproof.yaml, policies/, scenarios/, .github/workflows/drainproof.yml
npx drainproof policy validate
npx drainproof test
```

Then make the policy yours:

1. Set `agent.id` to the identifier your agent uses in proposals.
2. Replace the assets, limits, recipients and networks in `policies/default.yaml` with your real values.
3. **Update the built-in scenarios to match.** They encode concrete values such as `merchant-example`, 25 USDC and `near-testnet`; see [scenarios.md](scenarios.md#why-scenarios-use-concrete-values). After that, run `drainproof test` again until everything passes, and review each change you had to make.
4. To test your own guard rather than the Drainproof engine, point `target.module` at it ([custom targets](scenarios.md#custom-targets)).

## 4. CI

The generated `.github/workflows/drainproof.yml` uses `npm ci` and `npx --no-install drainproof …`, with read-only permissions and actions pinned to commit SHAs. For pnpm, uncomment the `pnpm/action-setup` line and replace `npm ci` with `pnpm install --frozen-lockfile`. The workflow fails the pull request whenever a required scenario fails (exit code 1) or the run is incomplete (exit code 3).

## External-user validation checklist

Use this when asking a developer who has never seen the repository to try Drainproof on their own project. Record the answers in an issue. Do not collect anything beyond what they choose to share.

- [ ] **Install.** Following only this page, how long until the first `drainproof test` ran? Which step was unclear?
- [ ] **Fit.** Could their real spending rules be expressed in `policies/default.yaml`? Which rule could not?
- [ ] **Scenarios.** How many built-in scenarios needed edits to match their values? Was it clear why?
- [ ] **Detection.** After a deliberately unsafe policy change (raise a limit, or allowlist an unknown recipient), did the suite exit with code 1, and did the finding explain the problem without reading the source?
- [ ] **Own guard.** If they have their own spending checks, did a custom target run? Which scenarios were skipped for missing capabilities?
- [ ] **CI.** Did the generated workflow run on their repository? Did it block a pull request with an unsafe change?
- [ ] **Reports.** Were the Markdown report and the findings understandable? Did they open the dashboard?
- [ ] **Trust.** After reading [limitations.md](limitations.md), what would stop them from using it for a real agent?
- [ ] **Outcome.** Would they keep it in CI? Report any defect they found as an issue (security defects via [SECURITY.md](../SECURITY.md)).
