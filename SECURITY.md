# Security policy

AgentGuard CI is security tooling, so we treat defects in it as security issues. This includes a scenario that passes when it should fail, a decision path that fails open, or a redaction gap.

## Reporting a vulnerability

Please **do not open a public issue** for a vulnerability. Use GitHub's private vulnerability reporting ("Report a vulnerability" on the repository's Security tab), or contact the maintainers privately. Include:

- the affected package and version, or the commit;
- a minimal policy, scenario or proposal that reproduces the problem;
- the expected and the observed behaviour.

We aim to acknowledge reports within 5 working days.

## What counts

- Any input that makes the engine return `ALLOW` when a documented rule requires `BLOCK` or `REQUIRE_APPROVAL`.
- Any error path that produces `ALLOW` (a fail-open path).
- An approval grant that is accepted for a proposal or policy version it was not issued for.
- Concurrency, idempotency or lifecycle bugs that let reserved spending exceed a limit.
- The runner reporting `PASS` for a scenario that was not actually evaluated.
- Secrets appearing in reports, logs or the dashboard.
- The NEAR executor signing anything outside the documented conditions.

Every confirmed security bug is fixed together with a regression test, and the fix is not considered complete until that test exists.

## Handling secrets

- Never put private keys, seed phrases or API tokens in policies, scenarios or the repository.
- The NEAR executor accepts a **testnet** key only through environment variables. Never use a mainnet key with it.
- CI workflows use `contents: read` permissions, and third-party actions pinned to commit SHAs.

## Scope limits

See [docs/threat-model.md](docs/threat-model.md) and [docs/limitations.md](docs/limitations.md) for what AgentGuard does and does not protect against.
