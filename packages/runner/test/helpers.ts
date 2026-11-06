import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { policyFromYaml } from "@drainproof/core";
import { loadScenarios, runSuite, type RunOptions } from "../src/index.js";

export const TEMPLATES = fileURLToPath(new URL("../../cli/templates/", import.meta.url));
export const DEFAULT_POLICY_PATH = path.join(TEMPLATES, "policies/default.yaml");

export async function builtinSuite() {
  const set = await loadScenarios(["scenarios"], TEMPLATES);
  if (set.issues.length) throw new Error(JSON.stringify(set.issues, null, 2));
  return set;
}

export async function runWithPolicyYaml(yaml: string, extra: Partial<RunOptions> = {}) {
  const loaded = policyFromYaml(yaml, "policy.yaml");
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  const set = await builtinSuite();
  return runSuite({
    drainproofVersion: "test",
    policy: loaded.policy,
    policyFile: "policies/default.yaml",
    scenarios: set.scenarios,
    suiteHash: set.suiteHash,
    ...extra,
  });
}

export async function tempProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drainproof-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}
