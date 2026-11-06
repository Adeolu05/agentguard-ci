# Payment policy example

The built-in Drainproof scenario library (40 scenarios) runs against `policy.yaml`, the same policy that `drainproof init` generates.

```bash
pnpm drainproof test --config examples/payment-policy/drainproof.yaml
```

To see a failure, loosen the policy. For example, add `attacker-wallet` to `recipients.allowed` or raise `max_transaction_amount`, then run the suite again. The run exits with code 1 and reports which security scenario now fails, and why.
