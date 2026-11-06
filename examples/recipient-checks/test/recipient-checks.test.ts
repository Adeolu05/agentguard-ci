/**
 * The recipient-checks pack (examples/recipient-checks) must pass against the policy engine,
 * and must catch each deliberately loose recipient matcher in loose-matchers.mjs: every
 * matcher fails exactly the scenarios listed below, and the exact matcher fails none.
 * Runs the real CLI (needs `pnpm build`). The vault run is in the README (local NEAR node).
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK = path.resolve(HERE, "..");
const ROOT = path.resolve(PACK, "../..");
const CLI = path.join(ROOT, "packages/cli/dist/bin.js");
const POLICY = path.join(ROOT, "examples/payment-policy/policy.yaml");

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "drainproof-recipient-checks-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function runPack(name: string, target: object) {
  const config = path.join(dir, `${name}.json`);
  const report = path.join(dir, `${name}.report.json`);
  // JSON is valid YAML.
  await writeFile(config, JSON.stringify({ version: 1, name, policy: POLICY, scenarios: [path.join(PACK, "scenarios")], target, reports: { dir: path.join(dir, "runs") } }));
  const exitCode = await run(process.execPath, [CLI, "test", "--config", config, "--no-save", "--quiet", "--no-color", "--json", report]).then(
    () => 0,
    (err: { code: number }) => err.code,
  );
  const r = JSON.parse(await readFile(report, "utf8"));
  const failed = r.scenarios.filter((s: { status: string }) => s.status !== "PASS").map((s: { id: string; status: string }) => `${s.id}:${s.status}`);
  return { exitCode, failed: failed.sort() };
}

async function guard(kind: string) {
  const module = path.join(dir, `${kind}.mjs`);
  await writeFile(module, `import { makeGuard } from ${JSON.stringify(pathToFileURL(path.join(HERE, "loose-matchers.mjs")).href)};\nexport const createTarget = makeGuard(${JSON.stringify(kind)});\n`);
  return runPack(kind, { type: "module", module });
}

describe("recipient-checks pack", () => {
  it("passes all 8 scenarios against the policy engine", async () => {
    expect(await runPack("engine", { type: "engine" })).toEqual({ exitCode: 0, failed: [] });
  });

  const expected: Record<string, string[]> = {
    exact: [],
    includes: ["lookalike-network-suffix", "lookalike-small-edits", "not-allowlisted-partial-match"],
    prefix: ["lookalike-network-suffix", "lookalike-small-edits", "not-allowlisted-partial-match"],
    suffix: ["not-allowlisted-partial-match"],
    "edit-distance-1": ["lookalike-one-for-l", "lookalike-small-edits", "lookalike-unicode-homoglyph", "lookalike-zero-for-o"],
    "look-alike-folding": ["lookalike-one-for-l", "lookalike-rn-for-m", "lookalike-unicode-homoglyph", "lookalike-zero-for-o"],
    "strip-network-suffix": ["lookalike-network-suffix"],
    "separator-insensitive": ["lookalike-small-edits"],
  };
  for (const [kind, ids] of Object.entries(expected)) {
    it(`${kind} matcher: ${ids.length === 0 ? "passes every scenario" : `fails ${ids.join(", ")}`}`, async () => {
      expect(await guard(kind)).toEqual({ exitCode: ids.length === 0 ? 0 : 1, failed: ids.map((id) => `${id}:FAIL`).sort() });
    });
  }
});
