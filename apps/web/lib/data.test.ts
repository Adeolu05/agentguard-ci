import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { policyFromYaml } from "@agentguard/core";
import { loadScenarios, runSuite } from "@agentguard/runner";
import { loadPolicyStatus, loadRun, loadRuns, scenarioLibrary } from "./data";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const env = { ...process.env };
let dir: string;

async function realReport(policyText: string) {
  const loaded = policyFromYaml(policyText);
  if (!loaded.ok) throw new Error("policy");
  const set = await loadScenarios(["packages/cli/templates/scenarios"], ROOT);
  return runSuite({
    agentguardVersion: "test",
    policy: loaded.policy,
    policyFile: "policy.yaml",
    scenarios: set.scenarios,
    suiteHash: set.suiteHash,
    filter: { categories: ["recipient-security"] },
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "agentguard-web-"));
  process.env.AGENTGUARD_RUNS_DIR = dir;
  delete process.env.AGENTGUARD_DEMO;
  delete process.env.AGENTGUARD_PROJECT;
});
afterEach(() => {
  process.env = { ...env };
});

describe("dashboard data layer", () => {
  it("reports a missing directory as empty, not as an error or a pass", async () => {
    process.env.AGENTGUARD_RUNS_DIR = path.join(dir, "missing");
    const r = await loadRuns();
    expect(r.runs).toEqual([]);
    expect(r.dirMissing).toBe(true);
  });

  it("loads real CLI reports newest first and rejects invalid or mislabelled files", async () => {
    const policy = await readFile(path.join(ROOT, "examples/payment-policy/policy.yaml"), "utf8");
    const passed = await realReport(policy);
    const failed = await realReport(policy.replace("    - merchant-example\n", "    - merchant-example\n    - unknown-merchant\n"));
    await writeFile(path.join(dir, `${passed.runId}.json`), JSON.stringify(passed));
    await writeFile(path.join(dir, `${failed.runId}.json`), JSON.stringify(failed));
    await writeFile(path.join(dir, "garbage.json"), "{not json");
    await writeFile(path.join(dir, "run_00000000000000000000000000000000.json"), JSON.stringify({ ...passed, status: "WINNING" }));
    await writeFile(path.join(dir, "run_11111111111111111111111111111111.json"), JSON.stringify(passed)); // id/name mismatch

    const r = await loadRuns();
    expect(r.runs.map((x) => x.runId).sort()).toEqual([passed.runId, failed.runId].sort());
    expect(r.invalid.map((i) => i.file).sort()).toEqual([
      "garbage.json",
      "run_00000000000000000000000000000000.json",
      "run_11111111111111111111111111111111.json",
    ]);
    expect(failed.status).toBe("FAILED");
    expect((await loadRun(failed.runId))?.findings[0]?.scenarioId).toBe("unknown-recipient-blocked");
    expect(await loadRun("../../etc/passwd")).toBeUndefined();

    const lib = scenarioLibrary(r.runs);
    const entry = lib.get("unknown-recipient-blocked")!;
    expect(entry.history.map((h) => h.status).sort()).toEqual(["FAIL", "PASS"]);
  });

  it("validates the configured project policy live", async () => {
    process.env.AGENTGUARD_PROJECT = path.join(ROOT, "examples/payment-policy/agentguard.yaml");
    const ok = await loadPolicyStatus();
    expect(ok.kind).toBe("valid");
    process.env.AGENTGUARD_PROJECT = path.join(dir, "nope.yaml");
    expect((await loadPolicyStatus()).kind).toBe("invalid");
  });

  it("serves bundled demo reports only in demo mode, and they are genuine reports", async () => {
    process.env.AGENTGUARD_DEMO = "1";
    const cwd = process.cwd();
    process.chdir(path.join(ROOT, "apps/web"));
    try {
      const r = await loadRuns();
      expect(r.source.mode).toBe("demo");
      expect(r.invalid).toEqual([]);
      expect(r.runs.length).toBeGreaterThanOrEqual(3);
      expect(r.runs.some((x) => x.status === "FAILED")).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });
});
