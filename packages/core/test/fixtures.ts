import {
  InMemoryLedger,
  PolicyEngine,
  ApprovalAuthority,
  policyFromYaml,
  type Clock,
  type Ledger,
  type Policy,
} from "../src/index.js";

export const BASE_POLICY_YAML = `
version: 1
agent:
  id: research-payment-agent
  name: Research Payment Agent
execution:
  mode: simulation
  fail_closed: true
assets:
  - id: USDC
    decimals: 6
    max_transaction_amount: "25"
    max_daily_spend: "100"
    approval_required_above: "10"
limits:
  max_transaction_count_per_day: 20
recipients:
  mode: allowlist
  allowed:
    - merchant-example
networks:
  allowed:
    - near-testnet
approval:
  max_age_seconds: 900
`;

export function loadPolicy(yaml = BASE_POLICY_YAML): Policy {
  const r = policyFromYaml(yaml, "test.yaml");
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.policy;
}

export class TestClock implements Clock {
  constructor(private t: number = Date.parse("2026-11-04T12:00:00.000Z")) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(seconds: number): void {
    this.t += seconds * 1000;
  }
}

export const APPROVAL_SECRET = "test-approval-secret-0123456789abcdef";

export function setup(opts: { yaml?: string; ledger?: Ledger } = {}) {
  const policy = loadPolicy(opts.yaml);
  const ledger = opts.ledger ?? new InMemoryLedger();
  const clock = new TestClock();
  const authority = new ApprovalAuthority(APPROVAL_SECRET);
  const engine = new PolicyEngine({ policy, ledger, clock, approvalVerifier: authority.verifier() });
  return { policy, ledger, clock, authority, engine };
}

let counter = 0;
export function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  counter++;
  return {
    requestId: `req-${counter}`,
    agentId: "research-payment-agent",
    assetId: "USDC",
    amount: "5",
    recipientId: "merchant-example",
    networkId: "near-testnet",
    ...overrides,
  };
}
