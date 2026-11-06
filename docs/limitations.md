# Limitations

Read this before relying on Drainproof.

## What a passing suite means

A passing suite means the tested behaviours hold for the scenarios you ran, under their stated conditions, against the target you tested. It does **not** mean the agent is secure, cannot lose money, or resists prompt injection. A finite suite is not formal verification.

## Enforcement

- Drainproof enforces only what is routed through `PolicyEngine.authorize()` and `beginExecution()`. An agent with direct access to a signing key, or another execution path, bypasses it entirely.
- `ALLOW` does not prove that a wallet, contract or payment provider applies the same rules.
- The engine validates *proposals*. It does not inspect what a signer actually signs. An executor that builds a different transaction from the one that was authorised defeats it. The NEAR executor builds the transfer from the stored reservation, not from agent input.

## State and concurrency

- `InMemoryLedger` is safe within one Node.js process. Several processes or instances sharing a budget need a database-backed `Ledger` with transactional locking. This is not implemented yet.
- A reservation counts in the window in which it was created. A transaction confirmed after midnight still counts on the day it was reserved.
- Reservations do not expire. A reservation that is never submitted keeps its budget until it is cancelled.
- Daily windows use fixed UTC offsets; IANA time zones are not supported.

## Approvals

- Grants use HMAC-SHA256. Anyone holding the verification key can also issue grants, so keep it out of the agent's reach.
- The engine does not authenticate *who* approved. `approverId` is recorded, but authenticating the human is the approval service's job.

## Scenarios and targets

- Built-in scenarios assume the default policy's values. If you change limits or recipients on purpose, update the scenarios to match.
- Custom targets that do not report reason codes are checked on decisions only. Targets lacking lifecycle, approval or ledger capabilities skip those scenarios.
- Instruction-injection scenarios test deterministic enforcement, not LLM behaviour.

## Integrations

- The NEAR executor has not been run against live testnet (see [integrations.md](integrations.md)). Only native NEAR transfers are supported.
- No other chain or agent-framework adapters exist yet.

## Operational

- `@drainproof/*` packages are not published to npm yet. Other projects install them from local tarballs (`pnpm pack:local`, see [adoption.md](adoption.md)).
- The dashboard has no authentication. Run it locally, or behind your own access control. It is read-only.
- SARIF output is not implemented.
