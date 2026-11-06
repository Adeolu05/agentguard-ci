import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { loadProject, runReportSchema, type RunReport } from "@drainproof/runner";

const RUN_ID_RE = /^run_[a-f0-9]{32}$/;
const MAX_REPORT_BYTES = 20 * 1024 * 1024;
const MAX_RUNS = 500;

export interface DataSource {
  mode: "demo" | "project";
  runsDir: string;
  projectFile: string | undefined;
}

/**
 * Where run reports come from. The dashboard is read-only: it never writes files,
 * never runs tests and never executes transactions.
 *
 *  - DRAINPROOF_DEMO=1          bundled demo reports (clearly labelled in the UI)
 *  - DRAINPROOF_RUNS_DIR=<dir>  directory of CLI run reports (default ./.drainproof/runs)
 *  - DRAINPROOF_PROJECT=<file>  drainproof.yaml whose policy is shown on the Policy page
 */
export function dataSource(): DataSource {
  if (process.env.DRAINPROOF_DEMO === "1") {
    return { mode: "demo", runsDir: path.join(/*turbopackIgnore: true*/ process.cwd(), "demo-runs"), projectFile: undefined };
  }
  return {
    mode: "project",
    // Paths are chosen at runtime by the operator; exclude them from build-time tracing.
    runsDir: path.resolve(/*turbopackIgnore: true*/ process.env.DRAINPROOF_RUNS_DIR ?? ".drainproof/runs"),
    projectFile: process.env.DRAINPROOF_PROJECT ? path.resolve(/*turbopackIgnore: true*/ process.env.DRAINPROOF_PROJECT) : undefined,
  };
}

export interface InvalidReport {
  file: string;
  error: string;
}

export interface RunsResult {
  source: DataSource;
  runs: RunReport[];
  invalid: InvalidReport[];
  dirMissing: boolean;
}

async function readReport(file: string): Promise<RunReport> {
  const info = await stat(file);
  if (info.size > MAX_REPORT_BYTES) throw new Error("report file is too large");
  const parsed = runReportSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`not a valid Drainproof report (${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"})`);
  }
  return parsed.data;
}

export async function loadRuns(): Promise<RunsResult> {
  const source = dataSource();
  let names: string[];
  try {
    names = (await readdir(source.runsDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return { source, runs: [], invalid: [], dirMissing: true };
  }
  const runs: RunReport[] = [];
  const invalid: InvalidReport[] = [];
  // Run ids are random, so recency comes from file modification times.
  const dated = await Promise.all(
    names.map(async (name) => ({ name, mtime: await stat(path.join(source.runsDir, name)).then((s) => s.mtimeMs, () => 0) })),
  );
  const newest = dated.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_RUNS).map((d) => d.name);
  for (const name of newest) {
    try {
      const report = await readReport(path.join(source.runsDir, name));
      if (`${report.runId}.json` !== name && RUN_ID_RE.test(name.replace(/\.json$/, ""))) {
        throw new Error("file name does not match the run id inside it");
      }
      runs.push(report);
    } catch (err) {
      invalid.push({ file: name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return { source, runs, invalid, dirMissing: false };
}

export async function loadRun(runId: string): Promise<RunReport | undefined> {
  if (!RUN_ID_RE.test(runId)) return undefined;
  const { runs } = await loadRuns();
  return runs.find((r) => r.runId === runId);
}

export type PolicyStatus =
  | { kind: "not-configured" }
  | { kind: "invalid"; file: string; issues: { location: string; message: string }[] }
  | { kind: "valid"; file: string; policyFile: string; hash: string; document: unknown; warnings: string[] };

/** Validate the configured project's policy now (independently of any stored run). */
export async function loadPolicyStatus(): Promise<PolicyStatus> {
  const source = dataSource();
  if (!source.projectFile) return { kind: "not-configured" };
  const r = await loadProject(source.projectFile);
  if (!r.ok) {
    return {
      kind: "invalid",
      file: source.projectFile,
      issues: r.issues.map((i) => ({ location: `${i.source}${i.line ? `:${i.line}` : ""}${i.path ? ` ${i.path}` : ""}`, message: i.message })),
    };
  }
  return {
    kind: "valid",
    file: source.projectFile,
    policyFile: r.project.policyFile,
    hash: r.project.policy.hash,
    document: r.project.policy.document,
    warnings: r.project.policyWarnings.map((w) => `${w.path}: ${w.message}`),
  };
}

export interface ScenarioHistoryEntry {
  runId: string;
  startedAt: string;
  status: RunReport["scenarios"][number]["status"];
}

export interface ScenarioSummary {
  latest: RunReport["scenarios"][number];
  history: ScenarioHistoryEntry[];
}

/** Scenario library derived from stored runs (newest definition wins). */
export function scenarioLibrary(runs: readonly RunReport[]): Map<string, ScenarioSummary> {
  const lib = new Map<string, ScenarioSummary>();
  for (const run of runs) {
    for (const s of run.scenarios) {
      const entry = lib.get(s.id) ?? { latest: s, history: [] };
      entry.history.push({ runId: run.runId, startedAt: run.startedAt, status: s.status });
      lib.set(s.id, entry);
    }
  }
  return lib;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function shortId(runId: string): string {
  return runId.slice(0, 12);
}
