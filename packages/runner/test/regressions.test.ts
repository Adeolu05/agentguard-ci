/** Regression tests for runner defects found by an independent adversarial review. */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { policyFromYaml } from "@agentguard/core";
import { loadModuleTarget, loadScenarios, runSuite, type RunOptions } from "../src/index.js";
import { DEFAULT_POLICY_PATH, tempProject } from "./helpers.js";

const policyYaml = await readFile(DEFAULT_POLICY_PATH, "utf8");
const P = "agentId: research-payment-agent, assetId: USDC, networkId: near-testnet, recipientId: merchant-example";
const header = (id: string, extra = "") =>
  `id: ${id}\nname: ${id}\ncategory: state-concurrency\nseverity: critical\ndescription: d\n${extra}`;

async function run(files: Record<string, string>, guard?: string, extra: Partial<RunOptions> = {}) {
  const dir = await tempProject({ ...files, ...(guard ? { "guard.mjs": guard } : {}) });
  const set = await loadScenarios(["scenarios"], dir);
  if (set.issues.length) throw new Error(JSON.stringify(set.issues));
  const loaded = policyFromYaml(policyYaml);
  if (!loaded.ok) throw new Error("policy");
  return runSuite({
    agentguardVersion: "test",
    policy: loaded.policy,
    policyFile: "p.yaml",
    scenarios: set.scenarios,
    suiteHash: set.suiteHash,
    ...(guard ? { target: { type: "module" as const, module: "guard.mjs", factory: await loadModuleTarget(path.join(dir, "guard.mjs")) } } : {}),
    ...extra,
  });
}

const minimalGuard = (body: string) =>
  `export const createTarget = () => ({ name: "g", capabilities: {}, async propose(p) { ${body} } });`;

describe("runner regressions", () => {
  it("an optional failure does not turn a run with no evaluated required scenario into a pass", async () => {
    const report = await run(
      {
        "scenarios/required.yaml": `${header("required-skipped")}steps:\n  - propose: { requestId: a, ${P}, amount: "5" }\n    expect: { decision: ALLOW }\n  - execute: { proposal: a }\n    expect: { ok: true }\n`,
        "scenarios/optional.yaml": `${header("optional-fails", "required: false\n")}steps:\n  - propose: { requestId: b, ${P}, amount: "5" }\n    expect: { decision: BLOCK }\n`,
      },
      minimalGuard(`return { decision: "ALLOW" };`),
    );
    expect(report.scenarios.find((s) => s.id === "required-skipped")?.status).toBe("SKIPPED");
    expect(report.scenarios.find((s) => s.id === "optional-fails")?.status).toBe("FAIL");
    expect(report.status).toBe("ERROR");
    expect(report.exitCode).toBe(3);
  });

  it("checks replay expectations even when the target does not report reason codes", async () => {
    const report = await run(
      { "scenarios/replay.yaml": `${header("replay-check")}steps:\n  - propose: { requestId: a, ${P}, amount: "5" }\n    expect: { decision: ALLOW, replay: true }\n` },
      minimalGuard(`return { decision: "ALLOW", replay: false };`),
    );
    expect(report.scenarios[0]?.status).toBe("FAIL");
    expect(report.findings[0]?.severity).toBe("critical");
  });

  it("notes, rather than silently passes, an unreported replay", async () => {
    const report = await run(
      { "scenarios/replay.yaml": `${header("replay-unreported")}steps:\n  - propose: { requestId: a, ${P}, amount: "5" }\n    expect: { decision: ALLOW, replay: true }\n` },
      minimalGuard(`return { decision: "ALLOW" };`),
    );
    expect(report.scenarios[0]?.status).toBe("PASS");
    expect(report.scenarios[0]?.steps[0]?.message).toMatch(/replay not checked/);
  });

  it("redacts sensitive keys before observed values are turned into strings", async () => {
    const guard = `export const createTarget = () => ({
      name: "leaky", capabilities: { lifecycle: true },
      async propose() { return { decision: "ALLOW", handle: "h" }; },
      async execute() { return { ok: false, authToken: "hunter2-super-secret-value" }; },
      async recordOutcome() { return { ok: true }; }, async cancel() { return { ok: true }; },
    });`;
    const report = await run(
      { "scenarios/leak.yaml": `${header("leak")}steps:\n  - propose: { requestId: a, ${P}, amount: "5" }\n    expect: { decision: ALLOW }\n  - execute: { proposal: a }\n    expect: { ok: true }\n` },
      guard,
    );
    expect(report.scenarios[0]?.status).toBe("FAIL");
    const json = JSON.stringify(report);
    expect(json).not.toContain("hunter2-super-secret-value");
    expect(report.findings[0]?.observed).toContain("[REDACTED]");
  });

  it("times out a target factory that never resolves", async () => {
    const report = await run(
      { "scenarios/a.yaml": `${header("hang")}steps:\n  - propose: { requestId: a, ${P}, amount: "5" }\n    expect: { decision: ALLOW }\n` },
      `export const createTarget = () => new Promise(() => {});`,
      { scenarioTimeoutMs: 200 },
    );
    expect(report.scenarios[0]?.status).toBe("ERROR");
    expect(report.scenarios[0]?.error?.message).toMatch(/timed out/);
  });

  it("stops running steps after a timeout and keeps the reported steps fixed", async () => {
    const guard = `let n = 0; export const createTarget = () => ({ name: "slow", capabilities: {},
      async propose() { n++; await new Promise((r) => setTimeout(r, n === 1 ? 300 : 1)); globalThis.__agentguardSteps = n; return { decision: "ALLOW" }; } });`;
    const steps = Array.from({ length: 5 }, (_, i) => `  - propose: { requestId: r${i}, ${P}, amount: "1" }\n    expect: { decision: ALLOW }\n`).join("");
    const report = await run({ "scenarios/a.yaml": `${header("slow")}steps:\n${steps}` }, guard, { scenarioTimeoutMs: 100 });
    expect(report.scenarios[0]?.status).toBe("ERROR");
    const reported = report.scenarios[0]!.steps.length;
    await new Promise((r) => setTimeout(r, 400));
    expect(report.scenarios[0]!.steps.length).toBe(reported);
    expect((globalThis as { __agentguardSteps?: number }).__agentguardSteps).toBe(1);
  });

  it("classifies approvals where blocks were expected under concurrency as permissive", async () => {
    const report = await run(
      { "scenarios/c.yaml": `${header("conc")}steps:\n  - concurrent:\n      count: 4\n      proposal: { requestId: c, ${P}, amount: "5" }\n    expect: { decisions: { ALLOW: 2, BLOCK: 2 } }\n` },
      `let n = 0; export const createTarget = () => ({ name: "g", capabilities: {}, async propose() { return { decision: n++ < 2 ? "ALLOW" : "REQUIRE_APPROVAL" }; } });`,
    );
    expect(report.scenarios[0]?.status).toBe("FAIL");
    expect(report.findings[0]?.severity).toBe("critical");
  });
});
