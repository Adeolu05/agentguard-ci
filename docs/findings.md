# Findings and severity

Each `FAIL` produces exactly one finding. A finding records:

- the scenario;
- the first failing step;
- the expected and observed behaviour;
- reproduction steps (`drainproof test --scenario <id>` plus the file and step);
- remediation (from the scenario, or a generic fallback);
- evidence: the scenario file, the step index, the scenario definition hash and the policy hash;
- a **severity rationale**.

`ERROR` and `SKIPPED` scenarios do not produce findings. They are listed separately, because they show that something was *not tested*, not that something is wrong.

## Severity criteria

Each scenario declares a risk severity. Assign it with these criteria:

| Severity | Use when a failure of this scenario means… |
| --- | --- |
| `critical` | Funds could move beyond a hard limit, to an unapproved recipient or network, or without a required approval. Also used when accounting could be bypassed (double counting is avoided but double *execution* is not), or when a broken safety mechanism would fail open. |
| `high` | A control is weakened but another control still limits loss. Examples: an approval accepted after its expiry, a daily-count limit not enforced, or malformed input accepted by an otherwise correct path. |
| `medium` | Defence-in-depth or robustness problems: oversized input, window reset behaviour, or zero-amount handling. |
| `low` | Usability or availability problems that do not move money incorrectly. |
| `informational` | Observations with no direct security impact. |

The **finding's** severity is then derived from the direction of the failure:

| Observed versus expected | Finding severity | Rationale |
| --- | --- | --- |
| More permissive (for example, expected `BLOCK` but observed `ALLOW`; an execution that succeeded when it should have been refused; more `ALLOW`s under concurrency; ledger totals differ) | The scenario's severity | This is a potential bypass. |
| More restrictive (for example, expected `ALLOW` but observed `BLOCK`) | At most `low` | Legitimate activity is blocked. That is an availability issue, not a bypass. |
| Same decision, different reason codes | At most `medium` | The outcome is right, but possibly for the wrong reason. The intended control may be broken and masked by another rule. |

Not every failure is critical. A policy that blocks an allowlisted merchant is a real problem, but it is not a security breach, and the report says so.
