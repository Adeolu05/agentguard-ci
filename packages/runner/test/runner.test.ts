import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadScenarios,
  renderMarkdown,
  runReportSchema,
  runSuite,
  loadModuleTarget,
  type RunReport,
} from "../src/index.js";
import { policyFromYaml } from "@agentguard/core";
import { builtinSuite, DEFAULT_POLICY_PATH, runWithPolicyYaml, tempProject, TEMPLATES } from "./helpers.js";

const defaultYaml = await readFile(DEFAULT_POLICY_PATH, "utf8");

function statusOf(report: RunReport, id: string) {
  return report.scenarios.find((s) => s.id === id)?.status;
}

describe("built-in suite against the default policy", () => {
  it("has at least 30 valid scenarios covering every category", async () => {
    const set = await builtinSuite();
    expect(set.scenarios.length).toBeGreaterThanOrEqual(30);
    const cats = new Set(set.scenarios.map((s) => s.scenario.category));
    for (const c of ["transaction-limits", "recipient-security", "network-asset", "approval-workflow", "state-concurrency", "adversarial-input"]) {
      expect(cats.has(c as never), c).toBe(true);
    }
  });

  it("passes every scenario and produces a schema-valid report", async () => {
    const report = await runWithPolicyYaml(defaultYaml);
    const notPassing = report.scenarios.filter((s) => s.status !== "PASS").map((s) => `${s.id}: ${s.status} ${JSON.stringify(s.steps.at(-1))} ${s.error?.message ?? ""}`);
    expect(notPassing).toEqual([]);
    expect(report.status).toBe("PASSED");
    expect(report.exitCode).toBe(0);
    expect(report.summary.passRate).toBe(1);
    expect(runReportSchema.safeParse(JSON.parse(JSON.stringify(report))).success).toBe(true);
  });

  it("is deterministic: two runs give identical outcomes", async () => {
    const a = await runWithPolicyYaml(defaultYaml);
    const b = await runWithPolicyYaml(defaultYaml);
    const project = (r: RunReport) => r.scenarios.map((s) => [s.id, s.status, s.steps.map((st) => JSON.stringify(st.observed))]);
    expect(project(a)).toEqual(project(b));
  });
});

describe("detecting unsafe policy changes", () => {
  it("raising max_transaction_amount fails the limit scenarios with critical findings", async () => {
    const report = await runWithPolicyYaml(defaultYaml.replace('max_transaction_amount: "25"', 'max_transaction_amount: "10000"'));
    expect(statusOf(report, "tx-limit-one-unit-above-maximum")).toBe("FAIL");
    expect(statusOf(report, "tx-limit-far-above-maximum")).toBe("FAIL");
    expect(report.exitCode).toBe(1);
    const f = report.findings.find((x) => x.scenarioId === "tx-limit-one-unit-above-maximum")!;
    expect(f.severity).toBe("critical");
    expect(f.expected).toContain("BLOCK");
    expect(f.reproduction[0]).toBe("agentguard test --scenario tx-limit-one-unit-above-maximum");
  });

  it("adding an attacker to the allowlist is caught", async () => {
    const report = await runWithPolicyYaml(defaultYaml.replace("    - data-provider-example", "    - data-provider-example\n    - attacker-wallet"));
    expect(statusOf(report, "instruction-injection-in-memo")).toBe("FAIL");
    expect(report.findings.find((f) => f.scenarioId === "instruction-injection-in-memo")?.severity).toBe("critical");
    expect(report.status).toBe("FAILED");
  });

  it("allowing mainnet is caught", async () => {
    const report = await runWithPolicyYaml(defaultYaml.replace("    - near-testnet", "    - near-testnet\n    - near-mainnet"));
    expect(statusOf(report, "unsupported-network-blocked")).toBe("FAIL");
  });

  it("an over-restrictive policy fails with low severity", async () => {
    const report = await runWithPolicyYaml(defaultYaml.replace("    - merchant-example\n", ""));
    const f = report.findings.find((x) => x.scenarioId === "approved-recipient-allowed")!;
    expect(f.severity).toBe("low");
    expect(f.severityRationale).toMatch(/more restrictive/);
  });
});

describe("filtering", () => {
  it("runs only selected scenarios and categories", async () => {
    const r1 = await runWithPolicyYaml(defaultYaml, { filter: { scenarioIds: ["unknown-recipient-blocked"] } });
    expect(r1.scenarios.map((s) => s.id)).toEqual(["unknown-recipient-blocked"]);
    const r2 = await runWithPolicyYaml(defaultYaml, { filter: { categories: ["approval-workflow"] } });
    expect(r2.scenarios.every((s) => s.category === "approval-workflow")).toBe(true);
    expect(r2.scenarios.length).toBeGreaterThan(3);
  });
});

describe("scenario validation", () => {
  it("rejects malformed scenarios instead of passing them", async () => {
    const dir = await tempProject({
      "scenarios/bad-1.yaml": "id: bad-one\nname: x\ncategory: transaction-limits\nseverity: high\ndescription: d\nsteps:\n  - propose: { requestId: a }\n    expect: { decision: MAYBE }\n",
      "scenarios/bad-2.yaml": "id: bad-two\nname: x\ncategory: nope\nseverity: high\ndescription: d\nsteps: []\n",
      "scenarios/bad-3.yaml": "id: bad-three\nname: x\ncategory: transaction-limits\nseverity: high\ndescription: d\nsteps:\n  - execute: { proposal: never-proposed }\n    expect: { ok: true }\n",
      "scenarios/bad-4.yaml": "id: bad-four\nname: x\ncategory: transaction-limits\nseverity: high\ndescription: d\nsteps:\n  - propose: { requestId: a }\n    expect: { decision: BLOCK, reason_codes: [NOT_A_REAL_CODE] }\n",
      "scenarios/bad-5.yaml": "id: bad-five\nname: x\ncategory: transaction-limits\nseverity: high\ndescription: d\nsteps:\n  - propose: { requestId: a }\n    expect: { decision: BLOCK }\n    typo_field: 1\n",
      "scenarios/bad-6.yaml": "id: bad-six\nname: x\ncategory: transaction-limits\nseverity: high\ndescription: d\nsteps:\n  - { advance_time: { seconds: 1 }, cancel: { proposal: a } }\n",
    });
    const set = await loadScenarios(["scenarios"], dir);
    expect(set.scenarios).toHaveLength(0);
    const files = new Set(set.issues.map((i) => i.source));
    expect(files.size).toBe(6);
    const messages = set.issues.map((i) => `${i.source} ${i.path} ${i.message}`).join("\n");
    expect(messages).toMatch(/refers to unknown or later proposal/);
    expect(messages).toMatch(/not a known AgentGuard reason code/);
    expect(messages).toMatch(/unknown field "typo_field"/);
    expect(messages).toMatch(/exactly one action/);
    expect(set.issues.find((i) => i.source === "scenarios/bad-1.yaml")?.line).toBe(8);
  });

  it("reports duplicate scenario ids", async () => {
    const s = "name: x\ncategory: transaction-limits\nseverity: high\ndescription: d\nsteps:\n  - advance_time: { seconds: 1 }\n";
    const dir = await tempProject({ "scenarios/a.yaml": `id: same-id\n${s}`, "scenarios/b.yaml": `id: same-id\n${s}` });
    const set = await loadScenarios(["scenarios"], dir);
    expect(set.issues.some((i) => /duplicate scenario id/.test(i.message))).toBe(true);
  });

  it("reports an empty scenario directory", async () => {
    const dir = await tempProject({ "scenarios/README.txt": "nothing" });
    const set = await loadScenarios(["scenarios"], dir);
    expect(set.issues[0]?.message).toMatch(/no scenario files/);
  });
});

describe("custom targets", () => {
  async function runModule(source: string, ids?: string[]) {
    const dir = await tempProject({ "guard.mjs": source });
    const factory = await loadModuleTarget(path.join(dir, "guard.mjs"));
    const loaded = policyFromYaml(defaultYaml);
    if (!loaded.ok) throw new Error("policy");
    const set = await builtinSuite();
    return runSuite({
      agentguardVersion: "test",
      policy: loaded.policy,
      policyFile: "p.yaml",
      scenarios: set.scenarios,
      suiteHash: set.suiteHash,
      target: { type: "module", module: "guard.mjs", factory },
      ...(ids ? { filter: { scenarioIds: ids } } : {}),
    });
  }

  it("finds bugs in a naive guard and skips scenarios it cannot support", async () => {
    // A typical hand-rolled guard: float maths, case-insensitive recipients, no daily accounting.
    const report = await runModule(`
      export function createTarget({ policyDocument }) {
        const asset = policyDocument.assets[0];
        const allowed = policyDocument.recipients.allowed.map((r) => r.toLowerCase());
        return {
          name: "naive-guard",
          capabilities: {},
          async propose(p) {
            const amount = parseFloat(p.amount);
            if (!allowed.includes(String(p.recipientId).toLowerCase().trim())) return { decision: "BLOCK" };
            if (amount > parseFloat(asset.max_transaction_amount)) return { decision: "BLOCK" };
            if (amount > parseFloat(asset.approval_required_above)) return { decision: "REQUIRE_APPROVAL" };
            return { decision: "ALLOW" };
          },
        };
      }`);
    expect(report.status).toBe("FAILED");
    const failed = report.scenarios.filter((s) => s.status === "FAIL").map((s) => s.id);
    expect(failed).toEqual(expect.arrayContaining(["negative-amount", "daily-spend-would-exceed-limit", "recipient-normalisation"]));
    const skipped = report.scenarios.filter((s) => s.status === "SKIPPED");
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((s) => /does not support/.test(s.skipReason ?? ""))).toBe(true);
    // Rules the naive guard does implement are still credited.
    expect(report.scenarios.find((s) => s.id === "unknown-recipient-blocked")?.status).toBe("PASS");
    const passStep = report.scenarios.find((s) => s.id === "unknown-recipient-blocked")!.steps[0]!;
    expect(passStep.message).toMatch(/reason codes not checked/);
  });

  it("a run in which every scenario is skipped is not a pass", async () => {
    const report = await runModule(
      `export const createTarget = () => ({ name: "minimal", capabilities: {}, async propose() { return { decision: "BLOCK" }; } });`,
      ["approval-expired", "double-execution-prevented"],
    );
    expect(report.summary.skipped).toBe(2);
    expect(report.status).toBe("ERROR");
    expect(report.exitCode).toBe(3);
  });

  it("reports a throwing target as ERROR, never PASS, and exits 3", async () => {
    const report = await runModule(
      `export function createTarget() { return { name: "broken", capabilities: {}, async propose() { throw new Error("connection refused"); } }; }`,
      ["unknown-recipient-blocked"],
    );
    expect(report.scenarios[0]?.status).toBe("ERROR");
    expect(report.scenarios[0]?.error?.message).toMatch(/connection refused/);
    expect(report.exitCode).toBe(3);
    expect(report.summary.passRate).toBeNull();
  });

  it("treats malformed target results as ERROR", async () => {
    const report = await runModule(
      `export default () => ({ name: "liar", capabilities: {}, async propose() { return { decision: "ok" }; } });`,
      ["unknown-recipient-blocked"],
    );
    expect(report.scenarios[0]?.status).toBe("ERROR");
  });

  it("lets a target skip scenarios it has no equivalent for, with its reason", async () => {
    const report = await runModule(
      `export const createTarget = () => ({
        name: "partial",
        capabilities: { reasonCodes: true },
        unsupported: (s) => (s.id === "zero-amount" ? "amounts are typed integers here" : undefined),
        async propose() { return { decision: "BLOCK", reasonCodes: ["RECIPIENT_NOT_ALLOWED"] }; },
      });`,
      ["zero-amount", "unknown-recipient-blocked"],
    );
    const zero = report.scenarios.find((s) => s.id === "zero-amount");
    expect(zero?.status).toBe("SKIPPED");
    expect(zero?.skipReason).toBe('target "partial" does not support this scenario: amounts are typed integers here');
    expect(zero?.steps).toEqual([]);
    expect(report.scenarios.find((s) => s.id === "unknown-recipient-blocked")?.status).toBe("PASS");
  });

  it("treats a malformed unsupported() answer as ERROR, never as a skip or a pass", async () => {
    const report = await runModule(
      `export const createTarget = () => ({ name: "odd", capabilities: {}, unsupported: () => 42, async propose() { return { decision: "BLOCK" }; } });`,
      ["unknown-recipient-blocked"],
    );
    expect(report.scenarios[0]?.status).toBe("ERROR");
    expect(report.scenarios[0]?.error?.message).toMatch(/unsupported\(\) must return/);
  });

  it("times out hanging targets", async () => {
    const dir = await tempProject({ "guard.mjs": `export const createTarget = () => ({ name: "hang", capabilities: {}, propose: () => new Promise(() => {}) });` });
    const factory = await loadModuleTarget(path.join(dir, "guard.mjs"));
    const loaded = policyFromYaml(defaultYaml);
    if (!loaded.ok) throw new Error("policy");
    const set = await builtinSuite();
    const report = await runSuite({
      agentguardVersion: "test", policy: loaded.policy, policyFile: "p", scenarios: set.scenarios, suiteHash: set.suiteHash,
      target: { type: "module", module: "guard.mjs", factory }, filter: { scenarioIds: ["unknown-recipient-blocked"] }, scenarioTimeoutMs: 200,
    });
    expect(report.scenarios[0]?.status).toBe("ERROR");
    expect(report.scenarios[0]?.error?.message).toMatch(/timed out/);
  });
});

describe("reports", () => {
  it("redacts secrets echoed by a target", async () => {
    const dir = await tempProject({
      "guard.mjs": `export const createTarget = () => ({ name: "leaky", capabilities: {}, async propose() { throw new Error("auth failed for ed25519:${"3".repeat(88)} with token sk-abcdefghijklmnopqrstuvwx and MYSECRETVALUE123"); } });`,
    });
    const factory = await loadModuleTarget(path.join(dir, "guard.mjs"));
    const loaded = policyFromYaml(defaultYaml);
    if (!loaded.ok) throw new Error("policy");
    const set = await builtinSuite();
    const report = await runSuite({
      agentguardVersion: "test", policy: loaded.policy, policyFile: "p", scenarios: set.scenarios, suiteHash: set.suiteHash,
      target: { type: "module", module: "guard.mjs", factory }, filter: { scenarioIds: ["unknown-recipient-blocked"] },
      redaction: { secrets: ["MYSECRETVALUE123"] },
    });
    const json = JSON.stringify(report);
    expect(json).not.toContain("3".repeat(88));
    expect(json).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(json).not.toContain("MYSECRETVALUE123");
    expect(json).toContain("[REDACTED]");
  });

  it("renders markdown with findings and a limitations note", async () => {
    const report = await runWithPolicyYaml(defaultYaml.replace('max_daily_spend: "100"', 'max_daily_spend: "1000"'));
    const md = renderMarkdown(report);
    expect(md).toMatch(/^# ❌ AgentGuard CI: FAILED/);
    expect(md).toContain("## Findings");
    expect(md).toContain("daily-spend-would-exceed-limit");
    expect(md).toContain("not proof");
  });

  it("templates directory is where the CLI expects it", () => {
    expect(TEMPLATES).toMatch(/cli[\\/]templates[\\/]$/);
  });
});
