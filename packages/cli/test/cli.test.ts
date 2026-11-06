import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runReportSchema } from "@drainproof/runner";
import { main, type CliIO } from "../src/main.js";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

async function tmp(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "drainproof-cli-"));
}

async function run(cwd: string, ...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const io: CliIO = { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), cwd, env: {}, color: false };
  const code = await main(argv, io);
  return { code, stdout, stderr };
}

async function initProject(): Promise<string> {
  const dir = await tmp();
  const r = await run(dir, "init");
  expect(r.code).toBe(0);
  return dir;
}

describe("drainproof init / validate", () => {
  it("creates a runnable project and refuses to overwrite it", async () => {
    const dir = await initProject();
    expect(existsSync(path.join(dir, "drainproof.yaml"))).toBe(true);
    expect(existsSync(path.join(dir, "policies/default.yaml"))).toBe(true);
    expect((await readdir(path.join(dir, "scenarios"))).length).toBeGreaterThan(3);
    expect(existsSync(path.join(dir, "github"))).toBe(false);
    const again = await run(dir, "init");
    expect(again.code).toBe(2);
    expect(again.stderr).toMatch(/Refusing to overwrite/);
  });

  it("optionally adds a GitHub Actions workflow", async () => {
    const dir = await tmp();
    expect((await run(dir, "init", "--github-actions")).code).toBe(0);
    const wf = await readFile(path.join(dir, ".github/workflows/drainproof.yml"), "utf8");
    expect(wf).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(wf).toMatch(/permissions:\n {2}contents: read/);
  });

  it("validates the default policy and scenarios", async () => {
    const dir = await initProject();
    const p = await run(dir, "policy", "validate");
    expect(p.code).toBe(0);
    expect(p.stdout).toMatch(/policies\/default.yaml is valid/);
    expect(p.stdout).toMatch(/hash:\s+sha256:/);
    const s = await run(dir, "scenarios", "validate");
    expect(s.code).toBe(0);
    expect(s.stdout).toMatch(/\d+ scenarios are valid/);
  });

  it("reports policy errors with file, line and field, exiting 2", async () => {
    const dir = await initProject();
    const file = path.join(dir, "policies/default.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace("max_transaction_count_per_day: 20", "max_transaction_count_per_day: 20\n  max_spend_typo: 5"));
    const r = await run(dir, "policy", "validate");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/policies\/default.yaml:\d+:\d+ limits.max_spend_typo: unknown field/);
    // `test` refuses to run against an invalid policy.
    expect((await run(dir, "test")).code).toBe(2);
  });

  it("rejects an invalid scenario before running anything", async () => {
    const dir = await initProject();
    await writeFile(path.join(dir, "scenarios/broken.yaml"), "id: broken\nname: b\ncategory: transaction-limits\nseverity: high\ndescription: d\nsteps:\n  - propose: { requestId: x }\n");
    const r = await run(dir, "test");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/scenarios\/broken.yaml.*expect/);
    expect(r.stdout).not.toMatch(/Running/);
  });

  it("explains a missing project file", async () => {
    const r = await run(await tmp(), "test");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/drainproof init/);
  });
});

describe("drainproof test", () => {
  it("passes the default suite, writes a valid report and exits 0", async () => {
    const dir = await initProject();
    const r = await run(dir, "test", "--json", "out/report.json", "--markdown", "out/report.md");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Result: PASSED/);
    const report = runReportSchema.parse(JSON.parse(await readFile(path.join(dir, "out/report.json"), "utf8")));
    expect(report.summary.failed).toBe(0);
    expect(report.summary.total).toBeGreaterThanOrEqual(30);
    expect(await readFile(path.join(dir, "out/report.md"), "utf8")).toMatch(/Drainproof: PASSED/);
    const runs = (await readdir(path.join(dir, ".drainproof/runs"))).filter((f) => f.endsWith(".json"));
    expect(runs).toEqual([`${report.runId}.json`]);
  });

  it("an intentional policy violation fails with exit 1 and names the scenario", async () => {
    const dir = await initProject();
    const file = path.join(dir, "policies/default.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace("    - data-provider-example", "    - data-provider-example\n    - unknown-merchant"));
    const r = await run(dir, "test");
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/FAIL\s+unknown-recipient-blocked/);
    expect(r.stdout).toMatch(/expected BLOCK, observed ALLOW/);
    expect(r.stdout).toMatch(/\[CRITICAL\]/);
    expect(r.stdout).toMatch(/Result: FAILED/);
  });

  it("filters by scenario and category and rejects unknown filters", async () => {
    const dir = await initProject();
    const one = await run(dir, "test", "--scenario", "unknown-recipient-blocked", "--no-save");
    expect(one.code).toBe(0);
    expect(one.stdout).toMatch(/Running 1 scenario\n/);
    const cat = await run(dir, "test", "--category", "approval-workflow", "--no-save", "--quiet");
    expect(cat.code).toBe(0);
    expect(cat.stdout).not.toMatch(/PASS /);
    expect((await run(dir, "test", "--scenario", "does-not-exist")).code).toBe(2);
    expect((await run(dir, "test", "--category", "nope")).code).toBe(2);
    expect((await run(dir, "test", "--bogus-flag")).code).toBe(2);
  });

  it("report renders the latest stored run", async () => {
    const dir = await initProject();
    await run(dir, "test", "--scenario", "negative-amount");
    const md = await run(dir, "report");
    expect(md.code).toBe(0);
    expect(md.stdout).toMatch(/negative-amount/);
    const json = await run(dir, "report", "--format", "json");
    expect(runReportSchema.safeParse(JSON.parse(json.stdout)).success).toBe(true);
    expect((await run(dir, "report", "--format", "pdf")).code).toBe(2);
    expect((await run(dir, "report", "--run", "../../etc/passwd")).code).toBe(2);
  });

  it("tests a custom guard module and loads integration validators", async () => {
    const dir = await initProject();
    await writeFile(path.join(dir, "guard.mjs"), `export function createTarget() {
      return { name: "always-allow", capabilities: {}, async propose() { return { decision: "ALLOW" }; } };
    }`);
    const cfg = path.join(dir, "drainproof.yaml");
    await writeFile(cfg, (await readFile(cfg, "utf8")).replace("  type: engine", "  type: module\n  module: ./guard.mjs"));
    const r = await run(dir, "test", "--no-save");
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/FAIL\s+unknown-recipient-blocked/);
    expect(r.stdout).toMatch(/SKIPPED/);
  });
});

describe("the built binary", () => {
  const exec = promisify(execFile);
  it.runIf(existsSync(BIN))("returns documented process exit codes", async () => {
    const dir = await tmp();
    await exec(process.execPath, [BIN, "init"], { cwd: dir });
    const ok = await exec(process.execPath, [BIN, "test", "--no-save"], { cwd: dir });
    expect(ok.stdout).toMatch(/Result: PASSED/);
    const file = path.join(dir, "policies/default.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace('max_daily_spend: "100"', 'max_daily_spend: "100000"'));
    const failed = await exec(process.execPath, [BIN, "test", "--no-save"], { cwd: dir }).catch((e: { code: number; stdout: string }) => e);
    expect((failed as { code: number }).code).toBe(1);
    const usage = await exec(process.execPath, [BIN, "frobnicate"], { cwd: dir }).catch((e: { code: number }) => e);
    expect((usage as { code: number }).code).toBe(2);
  });
  it("is built before running the binary test", () => {
    expect(existsSync(BIN), "run `pnpm build` before `pnpm test`").toBe(true);
  });
});
