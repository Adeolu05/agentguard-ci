import { z } from "zod";
import { SCENARIO_CATEGORIES, SEVERITIES } from "./scenario.js";

export const SCENARIO_STATUSES = ["PASS", "FAIL", "ERROR", "SKIPPED"] as const;
export type ScenarioStatus = (typeof SCENARIO_STATUSES)[number];

export const RUN_STATUSES = ["PASSED", "FAILED", "ERROR"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Documented exit codes (see docs/cli.md). */
export const EXIT_CODES = {
  /** All required scenarios passed. */
  PASSED: 0,
  /** At least one required scenario failed (an observed behaviour did not match the expectation). */
  FAILED: 1,
  /** Configuration, scenario validation or usage error; nothing was run. */
  USAGE: 2,
  /** No required scenario failed, but at least one errored, or no required scenario was evaluated at all: the run is incomplete. */
  ERROR: 3,
} as const;

export const stepResultSchema = z.object({
  index: z.int(),
  kind: z.string(),
  status: z.enum(["passed", "failed", "error"]),
  expected: z.unknown().optional(),
  observed: z.unknown().optional(),
  message: z.string().optional(),
});
export type StepResult = z.output<typeof stepResultSchema>;

export const scenarioResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum(SCENARIO_CATEGORIES),
  severity: z.enum(SEVERITIES),
  description: z.string(),
  remediation: z.string().optional(),
  required: z.boolean(),
  file: z.string(),
  definitionHash: z.string(),
  status: z.enum(SCENARIO_STATUSES),
  durationMs: z.number().min(0),
  steps: z.array(stepResultSchema),
  /** Index of the first step that did not pass. */
  failedStep: z.int().optional(),
  expected: z.string().optional(),
  observed: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  skipReason: z.string().optional(),
});
export type ScenarioResult = z.output<typeof scenarioResultSchema>;

export const findingSchema = z.object({
  id: z.string(),
  scenarioId: z.string(),
  severity: z.enum(SEVERITIES),
  title: z.string(),
  description: z.string(),
  expected: z.string(),
  observed: z.string(),
  reproduction: z.array(z.string()),
  remediation: z.string(),
  /** Why the finding has this severity (see docs/findings.md). */
  severityRationale: z.string(),
  evidence: z.object({ file: z.string(), step: z.int().optional(), definitionHash: z.string() }),
  status: z.literal("open"),
});
export type Finding = z.output<typeof findingSchema>;

export const runReportSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number().min(0),
  status: z.enum(RUN_STATUSES),
  exitCode: z.int(),
  drainproofVersion: z.string(),
  /** How proposals were handled during this run. Scenario runs are always "simulation". */
  executionMode: z.enum(["simulation", "testnet"]),
  project: z.object({ name: z.string().optional() }),
  policy: z.object({
    file: z.string(),
    hash: z.string(),
    agentId: z.string(),
    /** `execution.mode` declared in the policy (the run itself is always a simulation). */
    declaredExecutionMode: z.enum(["simulation", "testnet"]),
    warnings: z.array(z.string()),
    /** The validated policy document (no secrets: policies never contain credentials). */
    document: z.unknown().optional(),
  }),
  suite: z.object({ hash: z.string(), scenarioCount: z.int() }),
  filters: z.object({ scenarioIds: z.array(z.string()), categories: z.array(z.string()) }),
  target: z.object({
    type: z.enum(["engine", "module"]),
    name: z.string(),
    module: z.string().optional(),
    capabilities: z.record(z.string(), z.boolean()),
  }),
  integrations: z.array(z.string()),
  environment: z.object({
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
    ci: z.boolean(),
    gitSha: z.string().optional(),
    gitRef: z.string().optional(),
  }),
  summary: z.object({
    total: z.int(),
    passed: z.int(),
    failed: z.int(),
    errored: z.int(),
    skipped: z.int(),
    requiredPassed: z.int(),
    requiredFailed: z.int(),
    requiredErrored: z.int(),
    /** passed / (passed + failed + errored); null when nothing was evaluated or a required scenario errored. */
    passRate: z.number().min(0).max(1).nullable(),
  }),
  scenarios: z.array(scenarioResultSchema),
  findings: z.array(findingSchema),
});
export type RunReport = z.output<typeof runReportSchema>;

export function summarise(results: readonly ScenarioResult[]): RunReport["summary"] {
  const count = (s: ScenarioStatus, requiredOnly = false) =>
    results.filter((r) => r.status === s && (!requiredOnly || r.required)).length;
  const passed = count("PASS");
  const failed = count("FAIL");
  const errored = count("ERROR");
  const requiredErrored = count("ERROR", true);
  const evaluated = passed + failed + errored;
  return {
    total: results.length,
    passed,
    failed,
    errored,
    skipped: count("SKIPPED"),
    requiredPassed: count("PASS", true),
    requiredFailed: count("FAIL", true),
    requiredErrored,
    passRate: evaluated === 0 || requiredErrored > 0 ? null : passed / evaluated,
  };
}

export function runStatus(summary: RunReport["summary"]): { status: RunStatus; exitCode: number } {
  if (summary.requiredFailed > 0) return { status: "FAILED", exitCode: EXIT_CODES.FAILED };
  if (summary.requiredErrored > 0) return { status: "ERROR", exitCode: EXIT_CODES.ERROR };
  // A run in which no *required* scenario was actually evaluated is not a pass, even if
  // optional scenarios ran (they never affect the exit code).
  if (summary.requiredPassed + summary.requiredFailed + summary.requiredErrored === 0) {
    return { status: "ERROR", exitCode: EXIT_CODES.ERROR };
  }
  return { status: "PASSED", exitCode: EXIT_CODES.PASSED };
}
