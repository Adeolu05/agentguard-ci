import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hashCanonical, isReasonCode, parseYamlWithSchema, type ConfigIssue } from "@agentguard/core";

export const SCENARIO_CATEGORIES = [
  "transaction-limits",
  "recipient-security",
  "network-asset",
  "approval-workflow",
  "state-concurrency",
  "adversarial-input",
  "integration",
] as const;
export type ScenarioCategory = (typeof SCENARIO_CATEGORIES)[number];

export const SEVERITIES = ["critical", "high", "medium", "low", "informational"] as const;
export type Severity = (typeof SEVERITIES)[number];

const decisionSchema = z.enum(["ALLOW", "BLOCK", "REQUIRE_APPROVAL"]);
const refSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, "must be 1-64 characters [A-Za-z0-9_.-]");
const reasonCodeSchema = z.string().refine(isReasonCode, { message: "is not a known AgentGuard reason code" });
const amountString = z.string({ error: "must be a quoted decimal string" });
const isoTime = z.iso.datetime({ offset: false, message: "must be an ISO-8601 UTC timestamp ending in Z" });

/**
 * The proposal under test is passed to the target *verbatim* (it is the untrusted
 * input). It must be a mapping, but its fields are deliberately not validated here.
 */
const rawProposalSchema = z.record(z.string(), z.unknown());

const decisionExpectation = z.strictObject({
  decision: decisionSchema,
  /** Reason codes that must all be present (order-insensitive). */
  reason_codes: z.array(reasonCodeSchema).default([]),
  /** If true, the observed reason codes must equal `reason_codes` exactly (as a set). */
  reason_codes_exact: z.boolean().default(false),
  /** Reason codes that must NOT be present. */
  absent_reason_codes: z.array(reasonCodeSchema).default([]),
  /** Whether the step must have created a new reservation (ALLOW without replay). */
  replay: z.boolean().optional(),
});
export type DecisionExpectation = z.output<typeof decisionExpectation>;

const lifecycleExpectation = z.strictObject({
  ok: z.boolean(),
  reason_code: reasonCodeSchema.optional(),
});

const fillSchema = z
  .record(z.string(), z.strictObject({ char: z.string().length(1), length: z.int().min(1).max(1_000_000) }))
  .optional();

const proposeStep = z.strictObject({
  propose: rawProposalSchema,
  /** Name used by later steps to refer to this proposal. Defaults to the proposal's requestId. */
  as: refSchema.optional(),
  /** Present the approval grant created by an earlier `approve` step. */
  with_approval: refSchema.optional(),
  /** Test helper: replace these proposal fields with generated strings (for oversized-input tests). */
  fill: fillSchema,
  expect: decisionExpectation,
});

const approveStep = z.strictObject({
  approve: z.strictObject({
    proposal: refSchema,
    as: refSchema,
    approver: z.string().min(1).max(64).default("scenario-approver"),
    ttl_seconds: z.int().min(1).max(30 * 24 * 3600).default(300),
    /** `untrusted` signs with a key the target does not trust (simulates a forged approval). */
    signing_key: z.enum(["trusted", "untrusted"]).default("trusted"),
  }),
});

const advanceTimeStep = z.strictObject({
  advance_time: z.strictObject({ seconds: z.int().min(1).max(366 * 24 * 3600) }),
});

const executeStep = z.strictObject({
  execute: z.strictObject({ proposal: refSchema }),
  expect: lifecycleExpectation,
});
const outcomeStep = z.strictObject({
  record_outcome: z.strictObject({
    proposal: refSchema,
    outcome: z.enum(["confirmed", "failed"]),
    transaction_reference: z.string().min(1).max(128).optional(),
  }),
  expect: lifecycleExpectation,
});
const cancelStep = z.strictObject({
  cancel: z.strictObject({ proposal: refSchema }),
  expect: lifecycleExpectation,
});

const concurrentStep = z.strictObject({
  concurrent: z.strictObject({
    /** The proposal is submitted `count` times simultaneously. */
    proposal: rawProposalSchema,
    count: z.int().min(2).max(500),
    /** Append `-<n>` to requestId (and idempotencyKey if present) so each copy is distinct. Set false to test duplicates. */
    unique_request_ids: z.boolean().default(true),
  }),
  expect: z.strictObject({
    decisions: z.partialRecord(decisionSchema, z.int().min(0)),
  }),
});

const reloadPolicyStep = z.strictObject({
  reload_policy: z.strictObject({
    /** Dotted-path assignments applied to the policy document, e.g. `limits.max_transaction_count_per_day: 21`. */
    set: z.record(z.string(), z.unknown()),
  }),
});

const expectLedgerStep = z.strictObject({
  expect_ledger: z.strictObject({
    asset: z.string().optional(),
    /** Sum of active (reserved/submitted/confirmed) amounts in the current window, decimal units. */
    active_amount: amountString.optional(),
    /** Number of active reservations in the current window (all assets). */
    active_count: z.int().min(0).optional(),
    /** Total number of reservations recorded by this scenario (excluding seeded history). */
    reservations_created: z.int().min(0).optional(),
  }),
});

const STEP_SCHEMAS = {
  propose: proposeStep,
  approve: approveStep,
  advance_time: advanceTimeStep,
  execute: executeStep,
  record_outcome: outcomeStep,
  cancel: cancelStep,
  concurrent: concurrentStep,
  reload_policy: reloadPolicyStep,
  expect_ledger: expectLedgerStep,
} as const;

export type ScenarioStep = { [K in keyof typeof STEP_SCHEMAS]: z.output<(typeof STEP_SCHEMAS)[K]> }[keyof typeof STEP_SCHEMAS];

/** Dispatch on the step's action key so validation errors point at the right fields. */
export const stepSchema = z.unknown().transform((input, ctx): ScenarioStep => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    ctx.addIssue({ code: "custom", message: "each step must be a mapping" });
    return z.NEVER;
  }
  const actions = Object.keys(input).filter((k): k is keyof typeof STEP_SCHEMAS => Object.hasOwn(STEP_SCHEMAS, k));
  if (actions.length !== 1) {
    ctx.addIssue({
      code: "custom",
      message: `each step must contain exactly one action: ${Object.keys(STEP_SCHEMAS).join(", ")}`,
    });
    return z.NEVER;
  }
  const r = STEP_SCHEMAS[actions[0]!].safeParse(input);
  if (r.success) return r.data;
  for (const issue of r.error.issues) {
    const p = issue.path.filter((x): x is string | number => typeof x !== "symbol");
    if (issue.code === "unrecognized_keys") {
      for (const k of issue.keys) ctx.addIssue({ code: "custom", path: [...p, k], message: `unknown field "${k}" is not supported` });
    } else {
      ctx.addIssue({ code: "custom", path: p, message: issue.message });
    }
  }
  return z.NEVER;
});

const seedEntrySchema = z.strictObject({
  amount: amountString,
  asset: z.string(),
  status: z.enum(["reserved", "submitted", "confirmed", "failed", "cancelled"]).default("confirmed"),
  /** Defaults to one hour before `given.now`. */
  at: isoTime.optional(),
  recipient: z.string().optional(),
  network: z.string().optional(),
  repeat: z.int().min(1).max(10_000).default(1),
});
export type SeedEntry = z.output<typeof seedEntrySchema>;

export const DEFAULT_SCENARIO_NOW = "2026-01-15T12:00:00.000Z";

export const scenarioSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/, "must be lowercase kebab-case, 2-80 characters"),
  name: z.string().min(1).max(160),
  category: z.enum(SCENARIO_CATEGORIES),
  severity: z.enum(SEVERITIES),
  description: z.string().min(1).max(2000),
  remediation: z.string().max(2000).optional(),
  /** Non-required scenarios are reported but do not fail the run. */
  required: z.boolean().default(true),
  /** If set, the scenario is reported as SKIPPED with this reason. */
  skip: z.string().min(1).max(500).optional(),
  given: z
    .strictObject({
      now: isoTime.default(DEFAULT_SCENARIO_NOW),
      ledger: z.array(seedEntrySchema).default([]),
      ledger_unavailable: z.boolean().default(false),
      policy_patch: z.record(z.string(), z.unknown()).optional(),
    })
    .default({ now: DEFAULT_SCENARIO_NOW, ledger: [], ledger_unavailable: false }),
  steps: z.array(stepSchema).min(1, "a scenario needs at least one step").max(200),
});

export type Scenario = z.output<typeof scenarioSchema>;

export interface LoadedScenario {
  scenario: Scenario;
  /** Path relative to the project root, using forward slashes. */
  file: string;
  /** Hash of the validated definition, for reproducibility. */
  hash: string;
}

export type StepKind =
  | "propose"
  | "approve"
  | "advance_time"
  | "execute"
  | "record_outcome"
  | "cancel"
  | "concurrent"
  | "reload_policy"
  | "expect_ledger";

export function stepKind(step: ScenarioStep): StepKind {
  if ("propose" in step) return "propose";
  if ("approve" in step) return "approve";
  if ("advance_time" in step) return "advance_time";
  if ("execute" in step) return "execute";
  if ("record_outcome" in step) return "record_outcome";
  if ("cancel" in step) return "cancel";
  if ("concurrent" in step) return "concurrent";
  if ("reload_policy" in step) return "reload_policy";
  return "expect_ledger";
}

/** Static checks a schema cannot express: references must point at earlier steps. */
function checkReferences(s: Scenario, source: string): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const proposals = new Set<string>();
  const approvals = new Set<string>();
  s.steps.forEach((step, i) => {
    const at = (p: string) => ({ path: `steps.${i}.${p}`, source });
    const needProposal = (ref: string, p: string) => {
      if (!proposals.has(ref)) issues.push({ ...at(p), message: `refers to unknown or later proposal "${ref}"` });
    };
    if ("propose" in step) {
      if (step.with_approval && !approvals.has(step.with_approval)) {
        issues.push({ ...at("with_approval"), message: `refers to unknown or later approval "${step.with_approval}"` });
      }
      const ref = step.as ?? (typeof step.propose.requestId === "string" ? step.propose.requestId : undefined);
      if (ref) proposals.add(ref);
    } else if ("approve" in step) {
      needProposal(step.approve.proposal, "approve.proposal");
      approvals.add(step.approve.as);
    } else if ("execute" in step) needProposal(step.execute.proposal, "execute.proposal");
    else if ("record_outcome" in step) needProposal(step.record_outcome.proposal, "record_outcome.proposal");
    else if ("cancel" in step) needProposal(step.cancel.proposal, "cancel.proposal");
  });
  return issues;
}

export async function loadScenarioFile(absPath: string, projectRoot: string): Promise<
  { ok: true; value: LoadedScenario } | { ok: false; issues: ConfigIssue[] }
> {
  const rel = path.relative(projectRoot, absPath).split(path.sep).join("/");
  let text: string;
  try {
    text = await readFile(absPath, "utf8");
  } catch (err) {
    return { ok: false, issues: [{ path: "", message: `cannot read file: ${(err as Error).message}`, source: rel }] };
  }
  const parsed = parseYamlWithSchema(text, scenarioSchema, rel);
  if (!parsed.ok) return parsed;
  const refIssues = checkReferences(parsed.value, rel);
  if (refIssues.length > 0) return { ok: false, issues: refIssues };
  return { ok: true, value: { scenario: parsed.value, file: rel, hash: hashCanonical(parsed.value) } };
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.isFile() && /\.ya?ml$/i.test(e.name)) out.push(full);
  }
  return out;
}

export interface ScenarioSet {
  scenarios: LoadedScenario[];
  issues: ConfigIssue[];
  /** Hash over every scenario definition, identifying the exact suite that ran. */
  suiteHash: string;
}

/** Discover and validate all `*.yaml` / `*.yml` files under the given directories. */
export async function loadScenarios(dirs: readonly string[], projectRoot: string): Promise<ScenarioSet> {
  const issues: ConfigIssue[] = [];
  const scenarios: LoadedScenario[] = [];
  for (const dir of dirs) {
    const abs = path.resolve(projectRoot, dir);
    let files: string[];
    try {
      files = await walk(abs);
    } catch (err) {
      issues.push({ path: "", message: `cannot read scenario directory: ${(err as Error).message}`, source: dir });
      continue;
    }
    if (files.length === 0) issues.push({ path: "", message: "no scenario files found", source: dir });
    for (const f of files) {
      const r = await loadScenarioFile(f, projectRoot);
      if (r.ok) scenarios.push(r.value);
      else issues.push(...r.issues);
    }
  }
  const seen = new Map<string, string>();
  for (const s of scenarios) {
    const prev = seen.get(s.scenario.id);
    if (prev) issues.push({ path: "id", message: `duplicate scenario id "${s.scenario.id}" (also in ${prev})`, source: s.file });
    seen.set(s.scenario.id, s.file);
  }
  scenarios.sort((a, b) => a.scenario.id.localeCompare(b.scenario.id));
  return { scenarios, issues, suiteHash: hashCanonical(scenarios.map((s) => [s.scenario.id, s.hash])) };
}
