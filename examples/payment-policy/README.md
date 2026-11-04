# Payment policy example

The built-in AgentGuard scenario library (40 scenarios) runs against `policy.yaml`, the same policy that `agentguard init` generates.

```bash
pnpm agentguard test --config examples/payment-policy/agentguard.yaml
```

To see a failure, loosen the policy. For example, add `attacker-wallet` to `recipients.allowed` or raise `max_transaction_amount`, then run the suite again. The run exits with code 1 and reports which security scenario now fails, and why.
