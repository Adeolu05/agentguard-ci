# The GitHub Action, checking this repository

[policy.yaml](policy.yaml) stands in for "your agent's money policy". This repository's own [Drainproof workflow](../../.github/workflows/drainproof.yml) runs the [Drainproof GitHub Action](../../action.yml) against it on every pull request, the same way another repository would use it.

If a pull request loosens this policy so that one of the 40 built-in attack scenarios gets through, the check **Drainproof / Is the agent drainproof?** fails, and the job summary shows the finding. For example, allowlisting `attacker-wallet`:

```bash
perl -pi -e 's/^    - data-provider-example$/    - data-provider-example\n    - attacker-wallet/' examples/github-action/policy.yaml
```

gives this finding (the same as README step 3, because this file has the same rules as [examples/payment-policy/policy.yaml](../payment-policy/policy.yaml)):

```text
[CRITICAL] Instruction injection cannot override deterministic policy rules: expected BLOCK, observed ALLOW
```

The file is separate from `examples/payment-policy` so that a pull request changing it fails only this check, and not the unit tests and example suites that use the payment-policy example.
