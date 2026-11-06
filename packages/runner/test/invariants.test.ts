/**
 * Report invariants: no security failure may be counted as a pass, whatever the policy
 * or target. Runs the built-in suite under the default policy, several unsafe policy
 * mutations and a naive custom guard, then checks every report for consistency.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { policyFromYaml } from "@drainproof/core";
import { loadModuleTarget, runSuite, type RunReport, type RunOptions } from "../src/index.js";
import { builtinSuite, DEFAULT_POLICY_PATH, tempProject } from "./helpers.js";

const base = await readFile(DEFAULT_POLICY_PATH, "utf8");
const MUTATIONS: Record<string, (y: string) => string> = {
  default: (y) => y,
  "raised transaction limit": (y) => y.replace('max_transaction_amount: "25"', 'max_transaction_amount: "2500"'),
  "raised daily limit": (y) => y.replace('max_daily_spend: "100"', 'max_daily_spend: "100000"'),
  "attacker allowlisted": (y) => y.replace("    - data-provider-example", "    - data-provider-example\n    - attacker-wallet"),
  "mainnet allowed": (y) => y.replace("    - near-testnet", "    - near-testnet\n    - near-mainnet"),
  "approval threshold removed": (y) => y.replace(/^ {4}approval_required_above: .*\n/m, ""),
  "count limit raised": (y) => y.replace("max_transaction_count_per_day: 20", "max_transaction_count_per_day: 1000"),
  "zero amounts allowed": (y) => y.replace("allow_zero_amount: false", "allow_zero_amount: true"),
};

async function run(yaml: string, extra: Partial<RunOptions> = {}): Promise<RunReport> {
  const loaded = policyFromYaml(yaml);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  const set = await builtinSuite();
  return runSuite({ drainproofVersion: "test", policy: loaded.policy, policyFile: "p.yaml", scenarios: set.scenarios, suiteHash: set.suiteHash, ...extra });
}

async function checkInvariants(report: RunReport) {
  const set = await builtinSuite();
  const stepsOf = new Map(set.scenarios.map((s) => [s.scenario.id, s.scenario.steps.length]));
  const by = (st: string) => report.scenarios.filter((s) => s.status === st);
  expect(report.summary).toMatchObject({ passed: by("PASS").length, failed: by("FAIL").length, errored: by("ERROR").length, skipped: by("SKIPPED").length });
  for (const s of by("PASS")) {
    expect(s.steps.length, `${s.id}: PASS must execute every step`).toBe(stepsOf.get(s.id));
    expect(s.steps.every((st) => st.status === "passed"), `${s.id}: PASS with a non-passing step`).toBe(true);
  }
  for (const s of by("FAIL")) {
    expect(s.steps.some((st) => st.status === "failed"), `${s.id}: FAIL without a failed step`).toBe(true);
    expect(report.findings.some((f) => f.scenarioId === s.id), `${s.id}: FAIL without a finding`).toBe(true);
  }
  expect(report.findings.length).toBe(by("FAIL").length);
  const req = report.scenarios.filter((s) => s.required);
  const expected = req.some((s) => s.status === "FAIL") ? 1 : req.some((s) => s.status === "ERROR") || !req.some((s) => s.status !== "SKIPPED") ? 3 : 0;
  expect(report.exitCode).toBe(expected);
}

describe("report invariants across unsafe policies", () => {
  for (const [name, mutate] of Object.entries(MUTATIONS)) {
    it(`${name}: consistent report${name === "default" ? ", all pass" : ", and the change is detected"}`, async () => {
      const policy = mutate(base);
      if (name !== "default") expect(policy, `mutation "${name}" must change the policy`).not.toBe(base);
      const report = await run(policy);
      await checkInvariants(report);
      if (name === "default") expect(report.exitCode).toBe(0);
      else expect(report.exitCode, `"${name}" must be caught`).toBe(1);
    });
  }

  it("naive custom guard: consistent report with skips and failures", async () => {
    const dir = await tempProject({ "guard.mjs": await readFile(path.resolve(import.meta.dirname, "../../../examples/basic-agent/naive-guard.mjs"), "utf8") });
    const report = await run(base, { target: { type: "module", module: "guard.mjs", factory: await loadModuleTarget(path.join(dir, "guard.mjs")) } });
    await checkInvariants(report);
    expect(report.summary.skipped).toBeGreaterThan(0);
    expect(report.exitCode).toBe(1);
  });
});
