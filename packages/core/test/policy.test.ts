import { describe, expect, it } from "vitest";
import { dailyWindow, policyFromYaml } from "../src/index.js";
import { BASE_POLICY_YAML, loadPolicy } from "./fixtures.js";

describe("policy loading", () => {
  it("loads a valid policy and converts amounts exactly", () => {
    const p = loadPolicy();
    const usdc = p.assets.get("USDC")!;
    expect(usdc.maxTransactionAtomic).toBe(25_000_000n);
    expect(usdc.maxDailySpendAtomic).toBe(100_000_000n);
    expect(usdc.approvalRequiredAboveAtomic).toBe(10_000_000n);
    expect(p.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(p.windowOffsetMinutes).toBe(0);
  });

  it("rejects unknown keys with a file location", () => {
    const r = policyFromYaml(BASE_POLICY_YAML.replace("  max_transaction_count_per_day: 20", "  max_transaction_count_per_day: 20\n  max_tx_amount: 5"), "p.yaml");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0]).toMatchObject({ path: "limits.max_tx_amount", source: "p.yaml" });
    expect(r.issues[0]!.line).toBeGreaterThan(1);
  });

  it("rejects unquoted numeric amounts", () => {
    const r = policyFromYaml(BASE_POLICY_YAML.replace('max_transaction_amount: "25"', "max_transaction_amount: 25.5"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]!.message).toMatch(/quoted decimal string/);
  });

  it("rejects amounts with more precision than the asset", () => {
    const r = policyFromYaml(BASE_POLICY_YAML.replace('max_transaction_amount: "25"', 'max_transaction_amount: "25.0000001"'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]!.path).toBe("assets.0.max_transaction_amount");
  });

  it("refuses to disable fail_closed", () => {
    const r = policyFromYaml(BASE_POLICY_YAML.replace("fail_closed: true", "fail_closed: false"));
    expect(r.ok).toBe(false);
  });

  it("distinguishes a missing allowlist (error) from an empty one (blocks everything)", () => {
    const missing = policyFromYaml(BASE_POLICY_YAML.replace("  allowed:\n    - merchant-example\n", ""));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues.map((i) => i.path)).toContain("recipients.allowed");

    const empty = policyFromYaml(BASE_POLICY_YAML.replace("  allowed:\n    - merchant-example\n", "  allowed: []\n"));
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.policy.allowedRecipients.size).toBe(0);
      expect(empty.warnings.map((w) => w.message).join()).toMatch(/every transaction will be blocked/);
    }
  });

  it("rejects duplicate YAML keys and YAML syntax errors", () => {
    expect(policyFromYaml(BASE_POLICY_YAML + "\nversion: 1\n").ok).toBe(false);
    expect(policyFromYaml("version: [1\n").ok).toBe(false);
  });

  it("rejects identifiers with whitespace or non-ASCII characters", () => {
    for (const bad of ['" merchant"', '"merchant​"', '"mérchant"']) {
      const r = policyFromYaml(BASE_POLICY_YAML.replace("- merchant-example", `- ${bad}`));
      expect(r.ok, bad).toBe(false);
    }
  });

  it("rejects duplicate assets and allowlist entries", () => {
    expect(policyFromYaml(BASE_POLICY_YAML.replace("- merchant-example", "- merchant-example\n    - merchant-example")).ok).toBe(false);
  });

  it("produces a hash that ignores formatting but changes with content", () => {
    const a = loadPolicy();
    const b = loadPolicy(BASE_POLICY_YAML.replace(/\n\n/g, "\n").replace("# x", "") + "\n# trailing comment\n");
    const c = loadPolicy(BASE_POLICY_YAML.replace('max_daily_spend: "100"', 'max_daily_spend: "101"'));
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });

  it("warns when the approval threshold is unreachable", () => {
    const r = policyFromYaml(BASE_POLICY_YAML.replace('approval_required_above: "10"', 'approval_required_above: "30"'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.some((w) => w.path === "assets.0.approval_required_above")).toBe(true);
  });
});

describe("dailyWindow", () => {
  it("uses UTC calendar days by default", () => {
    const w = dailyWindow({ windowOffsetMinutes: 0 }, new Date("2026-11-04T23:59:59.999Z"));
    expect(w.start.toISOString()).toBe("2026-11-04T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-11-05T00:00:00.000Z");
  });
  it("honours fixed offsets", () => {
    const w = dailyWindow({ windowOffsetMinutes: -300 }, new Date("2026-11-04T03:00:00.000Z"));
    // 03:00Z is 22:00 on Nov 3 at UTC-5, so the window is Nov 3 05:00Z .. Nov 4 05:00Z
    expect(w.start.toISOString()).toBe("2026-11-03T05:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-11-04T05:00:00.000Z");
  });
});
