import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { policyFromYaml } from "@agentguard/core";
import { VAULT_MAX_RECIPIENTS, vaultPolicyFromPolicy } from "../src/index.js";

const load = (yaml: string) => {
  const r = policyFromYaml(yaml);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.policy;
};

const NEAR_POLICY = `
version: 1
agent: { id: near-agent }
assets: [{ id: NEAR, decimals: 24, max_transaction_amount: "0.5", max_daily_spend: "2", approval_required_above: "0.25" }]
limits: { max_transaction_count_per_day: 10, daily_window_utc_offset: "+02:30" }
recipients: { mode: allowlist, allowed: [shop.testnet, data.testnet] }
networks: { allowed: [near-testnet] }
approval: { max_age_seconds: 600 }
`;

describe("vaultPolicyFromPolicy", () => {
  it("converts every field exactly", () => {
    const policy = load(NEAR_POLICY);
    const r = vaultPolicyFromPolicy(policy);
    expect(r).toEqual({
      ok: true,
      policy: {
        max_transaction: "500000000000000000000000",
        max_daily_spend: "2000000000000000000000000",
        max_daily_count: 10,
        approval_required_above: "250000000000000000000000",
        recipient_mode: "allowlist",
        allowed_recipients: ["shop.testnet", "data.testnet"],
        daily_window_utc_offset_minutes: 150,
        allow_zero_amount: false,
        approval_ttl_seconds: 600,
        policy_hash: policy.hash,
      },
    });
  });

  it("converts the repository's NEAR testnet example policy", async () => {
    const yaml = await readFile(new URL("../../../examples/near-testnet/policy.yaml", import.meta.url), "utf8");
    const r = vaultPolicyFromPolicy(load(yaml));
    expect(r.ok).toBe(true);
  });

  it("keeps an absent threshold absent and copies allowlist_or_approval", () => {
    const r = vaultPolicyFromPolicy(
      load(NEAR_POLICY.replace(', approval_required_above: "0.25"', "").replace("mode: allowlist", "mode: allowlist_or_approval")),
    );
    expect(r.ok && r.policy.approval_required_above).toBeNull();
    expect(r.ok && r.policy.recipient_mode).toBe("allowlist_or_approval");
  });

  it("refuses an asset other than native NEAR with 24 decimals", () => {
    const r = vaultPolicyFromPolicy(load(NEAR_POLICY.replace("id: NEAR, decimals: 24", "id: USDC, decimals: 6")));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues[0]).toMatch(/vault's asset is NEAR with 24 decimals, but the policy's is USDC with 6/);
  });

  it("refuses more than one asset", () => {
    const yaml = NEAR_POLICY.replace(
      "assets: [",
      'assets: [{ id: USDC, decimals: 6, max_transaction_amount: "1", max_daily_spend: "1" }, ',
    );
    const r = vaultPolicyFromPolicy(load(yaml));
    expect(!r.ok && r.issues[0]).toMatch(/exactly one asset, but the policy configures 2/);
  });

  it("refuses any network list other than exactly the vault's network", () => {
    const r = vaultPolicyFromPolicy(load(NEAR_POLICY.replace("allowed: [near-testnet]", "allowed: [near-testnet, near-mainnet]")));
    expect(!r.ok && r.issues).toContain("networks.allowed: must be exactly [near-testnet] for a vault on that network, but is [near-testnet, near-mainnet]");
  });

  it("refuses recipients that are not valid NEAR accounts for the network", () => {
    const r = vaultPolicyFromPolicy(load(NEAR_POLICY.replace("[shop.testnet, data.testnet]", "[Shop.testnet, merchant.near]")));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues).toHaveLength(2);
    expect(!r.ok && r.issues.join("\n")).toMatch(/"Shop.testnet" is not a valid NEAR account ID[\s\S]*"merchant.near" is a mainnet/);
  });

  it(`refuses more than ${VAULT_MAX_RECIPIENTS} recipients`, () => {
    const many = Array.from({ length: VAULT_MAX_RECIPIENTS + 1 }, (_, i) => `r${i}.testnet`).join(", ");
    const r = vaultPolicyFromPolicy(load(NEAR_POLICY.replace("[shop.testnet, data.testnet]", `[${many}]`)));
    expect(!r.ok && r.issues[0]).toMatch(/at most 100 recipients, but the policy lists 101/);
  });

  it("can map another single asset unit for the sandbox scenario target", () => {
    const yaml = NEAR_POLICY.replace("id: NEAR, decimals: 24", "id: USDC, decimals: 6").replace("[shop.testnet, data.testnet]", "[merchant-example]");
    const r = vaultPolicyFromPolicy(load(yaml), { asset: { id: "USDC", decimals: 6 } });
    expect(r.ok && r.policy.max_transaction).toBe("500000");
  });
});
