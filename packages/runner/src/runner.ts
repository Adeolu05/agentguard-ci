import { performance } from "node:perf_hooks";
import {
  formatAtomic,
  newId,
  type Clock,
  type Decision,
  type Policy,
  type ProposalValidator,
  type Reservation,
} from "@agentguard/core";
import {
  type DecisionExpectation,
  type LoadedScenario,
  type Scenario,
  type ScenarioStep,
  type Severity,
  stepKind,
  SEVERITIES,
} from "./scenario.js";
import {
  engineTargetFactory,
  fixtureAmount,
  patchPolicy,
  type GuardTarget,
  type LifecycleOutcome,
  type TargetCapabilities,
  type TargetFactory,
  type TargetProposeResult,
} from "./target.js";
import { redact, type RedactOptions } from "./redact.js";
import {
  runStatus,
  summarise,
  type Finding,
  type RunReport,
  type ScenarioResult,
  type StepResult,
} from "./report.js";

export interface RunOptions {
  agentguardVersion: string;
  projectName?: string;
  policy: Policy;
  policyFile: string;
  policyWarnings?: readonly string[];
  scenarios: readonly LoadedScenario[];
  suiteHash: string;
  target?: { type: "engine" } | { type: "module"; module: string; factory: TargetFactory };
  validators?: readonly ProposalValidator[];
  integrations?: readonly string[];
  filter?: { scenarioIds?: readonly string[]; categories?: readonly string[] };
  /** Per-scenario timeout. Default 15 s. */
  scenarioTimeoutMs?: number;
  onScenarioComplete?: (result: ScenarioResult) => void;
  redaction?: RedactOptions;
  environment?: Partial<RunReport["environment"]>;
}

class ScenarioClock implements Clock {
  constructor(private t: number) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(seconds: number): void {
    this.t += seconds * 1000;
  }
}

class StepFailure extends Error {
  constructor(
    readonly expected: unknown,
    readonly observed: unknown,
    readonly direction: "permissive" | "restrictive" | "different",
    message: string,
  ) {
    super(message);
  }
}

class SkipScenario extends Error {}

const PERMISSIVENESS: Record<Decision, number> = { BLOCK: 0, REQUIRE_APPROVAL: 1, ALLOW: 2 };

export function selectScenarios(
  all: readonly LoadedScenario[],
  filter: RunOptions["filter"] = {},
): LoadedScenario[] {
  const ids = filter.scenarioIds?.length ? new Set(filter.scenarioIds) : undefined;
  const cats = filter.categories?.length ? new Set(filter.categories) : undefined;
  return all.filter((s) => (!ids || ids.has(s.scenario.id)) && (!cats || cats.has(s.scenario.category)));
}

function requiredCapabilities(s: Scenario): (keyof TargetCapabilities)[] {
  const caps = new Set<keyof TargetCapabilities>();
  if (s.given.ledger_unavailable) caps.add("failureInjection");
  for (const step of s.steps) {
    const kind = stepKind(step);
    if (kind === "approve") caps.add("approvals");
    if (kind === "execute" || kind === "record_outcome" || kind === "cancel") caps.add("lifecycle");
    if (kind === "reload_policy") caps.add("policyReload");
    if (kind === "expect_ledger") caps.add("ledgerInspection");
    // Reason codes are not a hard requirement: targets that do not report them are
    // checked on decisions only, and the step result records that limitation.
  }
  return [...caps];
}

function seedReservations(s: Scenario, policy: Policy): Reservation[] {
  const now = Date.parse(s.given.now);
  const out: Reservation[] = [];
  s.given.ledger.forEach((entry, i) => {
    const amountAtomic = fixtureAmount(policy, entry.asset, entry.amount, `given.ledger.${i}`);
    const at = entry.at ?? new Date(now - 3_600_000).toISOString();
    for (let n = 0; n < entry.repeat; n++) {
      const id = `seed-${i}-${n}`;
      out.push({
        reservationId: id,
        agentId: policy.agentId,
        requestId: id,
        idempotencyKey: id,
        proposalDigest: `seed:${id}`,
        policyHash: "seed",
        assetId: entry.asset,
        networkId: entry.network ?? [...policy.allowedNetworks][0] ?? "seed-network",
        recipientId: entry.recipient ?? [...policy.allowedRecipients][0] ?? "seed-recipient",
        amountAtomic,
        approvalId: undefined,
        createdAt: at,
        status: entry.status,
        transactionReference: undefined,
        history: [{ status: entry.status, at }],
      });
    }
  });
  return out;
}

function checkDecision(expect: DecisionExpectation, observed: TargetProposeResult, reasonCodesSupported: boolean): void {
  const codes = new Set(observed.reasonCodes ?? []);
  const obs = {
    decision: observed.decision,
    ...(reasonCodesSupported ? { reason_codes: [...codes] } : {}),
    ...(observed.replay !== undefined ? { replay: observed.replay } : {}),
  };
  if (observed.decision !== expect.decision) {
    const dir = PERMISSIVENESS[observed.decision] > PERMISSIVENESS[expect.decision] ? "permissive" : "restrictive";
    throw new StepFailure(expect, obs, dir, `expected ${expect.decision}, observed ${observed.decision}`);
  }
  if (!reasonCodesSupported) return;
  const missing = expect.reason_codes.filter((c) => !codes.has(c));
  if (missing.length > 0) {
    throw new StepFailure(expect, obs, "different", `decision matched but expected reason code(s) missing: ${missing.join(", ")}`);
  }
  const present = expect.absent_reason_codes.filter((c) => codes.has(c));
  if (present.length > 0) {
    throw new StepFailure(expect, obs, "different", `unexpected reason code(s) present: ${present.join(", ")}`);
  }
  if (expect.reason_codes_exact) {
    const extra = [...codes].filter((c) => !expect.reason_codes.includes(c as never));
    if (extra.length > 0) throw new StepFailure(expect, obs, "different", `unexpected additional reason code(s): ${extra.join(", ")}`);
  }
  if (expect.replay !== undefined && observed.replay !== expect.replay) {
    throw new StepFailure(
      expect,
      obs,
      expect.replay ? "permissive" : "different",
      `expected replay=${expect.replay}, observed replay=${String(observed.replay)}`,
    );
  }
}

function checkLifecycle(expect: { ok: boolean; reason_code?: string | undefined }, observed: LifecycleOutcome): void {
  if (observed.ok !== expect.ok) {
    throw new StepFailure(
      expect,
      observed,
      observed.ok ? "permissive" : "restrictive",
      `expected ok=${expect.ok}, observed ok=${observed.ok}${observed.reasonCode ? ` (${observed.reasonCode})` : ""}`,
    );
  }
  if (expect.reason_code && observed.reasonCode !== expect.reason_code) {
    throw new StepFailure(expect, observed, "different", `expected reason ${expect.reason_code}, observed ${observed.reasonCode ?? "none"}`);
  }
}

interface ScenarioState {
  results: Map<string, TargetProposeResult>;
  approvals: Map<string, unknown>;
}

async function runStep(
  step: ScenarioStep,
  target: GuardTarget,
  state: ScenarioState,
  clock: ScenarioClock,
  policy: () => Policy,
): Promise<{ expected?: unknown; observed?: unknown; message?: string }> {
  const need = <T>(fn: T | undefined, what: string): T => {
    if (fn === undefined) throw new SkipScenario(`target does not support ${what}`);
    return fn;
  };
  const handleOf = (ref: string) => state.results.get(ref)?.handle;

  if ("propose" in step) {
    const proposal: Record<string, unknown> = { ...step.propose };
    for (const [field, spec] of Object.entries(step.fill ?? {})) proposal[field] = spec.char.repeat(spec.length);
    const approval = step.with_approval ? state.approvals.get(step.with_approval) : undefined;
    const observed = await target.propose(proposal, approval === undefined ? {} : { approval });
    const ref = step.as ?? (typeof step.propose.requestId === "string" ? step.propose.requestId : undefined);
    if (ref) state.results.set(ref, observed);
    checkDecision(step.expect, observed, target.capabilities.reasonCodes);
    const unchecked =
      !target.capabilities.reasonCodes && (step.expect.reason_codes.length > 0 || step.expect.absent_reason_codes.length > 0);
    return {
      expected: step.expect,
      observed: { decision: observed.decision, reason_codes: observed.reasonCodes ?? [], replay: observed.replay },
      ...(unchecked ? { message: "decision checked; reason codes not checked (target does not report them)" } : {}),
    };
  }
  if ("approve" in step) {
    const result = state.results.get(step.approve.proposal);
    if (!result) throw new Error(`proposal "${step.approve.proposal}" has no result yet`);
    const grant = await need(target.issueApproval, "approvals")({
      result,
      approverId: step.approve.approver,
      ttlSeconds: step.approve.ttl_seconds,
      signingKey: step.approve.signing_key,
    });
    state.approvals.set(step.approve.as, grant);
    return { observed: { issued: true, signing_key: step.approve.signing_key } };
  }
  if ("advance_time" in step) {
    clock.advance(step.advance_time.seconds);
    return { observed: { now: clock.now().toISOString() } };
  }
  if ("execute" in step) {
    const observed = await need(target.execute, "lifecycle")(handleOf(step.execute.proposal));
    checkLifecycle(step.expect, observed);
    return { expected: step.expect, observed };
  }
  if ("record_outcome" in step) {
    const s = step.record_outcome;
    const observed = await need(target.recordOutcome, "lifecycle")(handleOf(s.proposal), s.outcome, s.transaction_reference);
    checkLifecycle(step.expect, observed);
    return { expected: step.expect, observed };
  }
  if ("cancel" in step) {
    const observed = await need(target.cancel, "lifecycle")(handleOf(step.cancel.proposal));
    checkLifecycle(step.expect, observed);
    return { expected: step.expect, observed };
  }
  if ("concurrent" in step) {
    const c = step.concurrent;
    const copies = Array.from({ length: c.count }, (_, i) => {
      const p: Record<string, unknown> = { ...c.proposal };
      if (c.unique_request_ids) {
        if (typeof p.requestId === "string") p.requestId = `${p.requestId}-${i + 1}`;
        if (typeof p.idempotencyKey === "string") p.idempotencyKey = `${p.idempotencyKey}-${i + 1}`;
      }
      return p;
    });
    const results = await Promise.all(copies.map((p) => target.propose(p, {})));
    const counts: Record<Decision, number> = { ALLOW: 0, BLOCK: 0, REQUIRE_APPROVAL: 0 };
    for (const r of results) counts[r.decision]++;
    const expected: Record<Decision, number> = { ALLOW: 0, BLOCK: 0, REQUIRE_APPROVAL: 0, ...step.expect.decisions };
    const mismatch = (Object.keys(counts) as (keyof typeof counts)[]).filter((k) => counts[k] !== expected[k]);
    if (mismatch.length > 0) {
      throw new StepFailure(
        expected,
        counts,
        counts.ALLOW > expected.ALLOW ? "permissive" : "restrictive",
        `decision counts differ: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(counts)}`,
      );
    }
    return { expected, observed: counts };
  }
  if ("reload_policy" in step) {
    await need(target.reloadPolicy, "policy reload")(step.reload_policy.set);
    return { observed: { reloaded: Object.keys(step.reload_policy.set) } };
  }
  // expect_ledger
  const e = step.expect_ledger;
  const p = policy();
  const assetId = e.asset ?? [...p.assets.keys()][0]!;
  const usage = await need(target.ledgerUsage, "ledger inspection")(assetId);
  const decimals = p.assets.get(assetId)?.decimals ?? 0;
  const observed = {
    asset: assetId,
    active_amount: formatAtomic(usage.activeAtomic, decimals),
    active_count: usage.activeCount,
    reservations_created: usage.created,
  };
  const problems: string[] = [];
  if (e.active_amount !== undefined && fixtureAmount(p, assetId, e.active_amount, "expect_ledger.active_amount") !== usage.activeAtomic) {
    problems.push(`active_amount ${observed.active_amount} != ${e.active_amount}`);
  }
  if (e.active_count !== undefined && e.active_count !== usage.activeCount) problems.push(`active_count ${usage.activeCount} != ${e.active_count}`);
  if (e.reservations_created !== undefined && e.reservations_created !== usage.created) {
    problems.push(`reservations_created ${usage.created} != ${e.reservations_created}`);
  }
  if (problems.length > 0) throw new StepFailure(e, observed, "permissive", `ledger state differs: ${problems.join("; ")}`);
  return { expected: e, observed };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`scenario timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function lowerOf(a: Severity, b: Severity): Severity {
  return SEVERITIES.indexOf(a) > SEVERITIES.indexOf(b) ? a : b;
}

interface FailureInfo {
  step: number;
  failure: StepFailure;
}

export async function runScenario(
  loaded: LoadedScenario,
  opts: Pick<RunOptions, "policy" | "target" | "validators" | "scenarioTimeoutMs">,
): Promise<{ result: ScenarioResult; failure?: FailureInfo }> {
  const s = loaded.scenario;
  const started = performance.now();
  const base = {
    id: s.id,
    name: s.name,
    category: s.category,
    severity: s.severity,
    description: s.description,
    ...(s.remediation ? { remediation: s.remediation } : {}),
    required: s.required,
    file: loaded.file,
    definitionHash: loaded.hash,
  };
  const elapsed = () => Math.round((performance.now() - started) * 100) / 100;
  if (s.skip) return { result: { ...base, status: "SKIPPED", durationMs: 0, steps: [], skipReason: s.skip } };

  const steps: StepResult[] = [];
  let target: GuardTarget | undefined;
  try {
    let policy = opts.policy;
    if (s.given.policy_patch) {
      const patched = patchPolicy(policy.document, s.given.policy_patch, `${loaded.file}#given.policy_patch`);
      if (!patched.ok) {
        throw new Error(`given.policy_patch produced an invalid policy: ${patched.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
      }
      policy = patched.policy;
    }
    const clock = new ScenarioClock(Date.parse(s.given.now));
    const factory = opts.target?.type === "module" ? opts.target.factory : engineTargetFactory;
    target = await factory({
      policyDocument: policy.document,
      policy,
      clock,
      seed: seedReservations(s, policy),
      ledgerUnavailable: s.given.ledger_unavailable,
      validators: opts.validators ?? [],
    });
    const missing = requiredCapabilities(s).filter((c) => !target!.capabilities[c]);
    if (missing.length > 0) {
      return {
        result: {
          ...base,
          status: "SKIPPED",
          durationMs: elapsed(),
          steps: [],
          skipReason: `target "${target.name}" does not support: ${missing.join(", ")}`,
        },
      };
    }

    const state: ScenarioState = { results: new Map(), approvals: new Map() };
    let currentPolicy = policy;
    const activeTarget = target;
    const runAll = async (): Promise<FailureInfo | undefined> => {
      for (const [index, step] of s.steps.entries()) {
        const kind = stepKind(step);
        try {
          const out = await runStep(step, activeTarget, state, clock, () => currentPolicy);
          if (kind === "reload_policy") {
            const patched = patchPolicy(currentPolicy.document, (step as { reload_policy: { set: Record<string, unknown> } }).reload_policy.set, "reload_policy");
            if (patched.ok) currentPolicy = patched.policy;
          }
          steps.push({ index, kind, status: "passed", ...out });
        } catch (err) {
          if (err instanceof StepFailure) {
            steps.push({ index, kind, status: "failed", expected: err.expected, observed: err.observed, message: err.message });
            return { step: index, failure: err };
          }
          if (err instanceof SkipScenario) throw err;
          steps.push({ index, kind, status: "error", message: (err as Error)?.message ?? String(err) });
          throw err;
        }
      }
      return undefined;
    };
    const failure = await withTimeout(runAll(), opts.scenarioTimeoutMs ?? 15_000);
    if (failure) {
      return {
        result: {
          ...base,
          status: "FAIL",
          durationMs: elapsed(),
          steps,
          failedStep: failure.step,
          expected: JSON.stringify(failure.failure.expected),
          observed: JSON.stringify(failure.failure.observed),
        },
        failure,
      };
    }
    return { result: { ...base, status: "PASS", durationMs: elapsed(), steps } };
  } catch (err) {
    if (err instanceof SkipScenario) {
      return { result: { ...base, status: "SKIPPED", durationMs: elapsed(), steps, skipReason: err.message } };
    }
    const failedStep = steps.findIndex((st) => st.status === "error");
    return {
      result: {
        ...base,
        status: "ERROR",
        durationMs: elapsed(),
        steps,
        ...(failedStep >= 0 ? { failedStep } : {}),
        error: { code: "SCENARIO_EXECUTION_ERROR", message: (err as Error)?.message ?? String(err) },
      },
    };
  } finally {
    try {
      await target?.dispose?.();
    } catch {
      // A dispose failure must not turn a result into a pass or hide the original outcome.
    }
  }
}

function buildFinding(runId: string, loaded: LoadedScenario, result: ScenarioResult, info: FailureInfo): Finding {
  const s = loaded.scenario;
  let severity: Severity;
  let severityRationale: string;
  switch (info.failure.direction) {
    case "permissive":
      severity = s.severity;
      severityRationale = `Observed behaviour was more permissive than expected; severity is the scenario's declared risk (${s.severity}).`;
      break;
    case "restrictive":
      severity = lowerOf(s.severity, "low");
      severityRationale = "Observed behaviour was more restrictive than expected (legitimate activity blocked). This is an availability problem, not a bypass, so severity is capped at low.";
      break;
    default:
      severity = lowerOf(s.severity, "medium");
      severityRationale = "The decision matched but for different reasons, so the intended control may not be the one enforcing it. Severity is capped at medium.";
  }
  const step = s.steps[info.step];
  return {
    id: `${runId}:${s.id}`,
    scenarioId: s.id,
    severity,
    title: `${s.name}: ${info.failure.message}`,
    description: s.description,
    expected: result.expected ?? "",
    observed: result.observed ?? "",
    reproduction: [
      `agentguard test --scenario ${s.id}`,
      `Scenario file: ${loaded.file} (step ${info.step + 1} of ${s.steps.length}: ${step ? stepKind(step) : "unknown"})`,
    ],
    remediation:
      s.remediation ??
      "Review the policy and the guard implementation for the rule this scenario exercises, then re-run the scenario.",
    severityRationale,
    evidence: { file: loaded.file, step: info.step, definitionHash: loaded.hash },
    status: "open",
  };
}

/** Run the selected scenarios sequentially (each in isolation) and build a report. */
export async function runSuite(opts: RunOptions): Promise<RunReport> {
  const runId = newId("run");
  const startedAt = new Date();
  const t0 = performance.now();
  const selected = selectScenarios(opts.scenarios, opts.filter);
  const results: ScenarioResult[] = [];
  const findings: Finding[] = [];
  for (const loaded of selected) {
    const { result, failure } = await runScenario(loaded, opts);
    results.push(result);
    if (failure) findings.push(buildFinding(runId, loaded, result, failure));
    opts.onScenarioComplete?.(redact(result, opts.redaction));
  }
  const summary = summarise(results);
  const { status, exitCode } = runStatus(summary);
  const target = opts.target ?? { type: "engine" as const };
  const report: RunReport = {
    schemaVersion: 1,
    runId,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - t0),
    status,
    exitCode,
    agentguardVersion: opts.agentguardVersion,
    executionMode: opts.policy.executionMode,
    project: opts.projectName ? { name: opts.projectName } : {},
    policy: {
      file: opts.policyFile,
      hash: opts.policy.hash,
      agentId: opts.policy.agentId,
      warnings: [...(opts.policyWarnings ?? [])],
      document: opts.policy.document,
    },
    suite: { hash: opts.suiteHash, scenarioCount: opts.scenarios.length },
    filters: { scenarioIds: [...(opts.filter?.scenarioIds ?? [])], categories: [...(opts.filter?.categories ?? [])] },
    target:
      target.type === "module"
        ? { type: "module", name: target.module, module: target.module, capabilities: {} }
        : {
            type: "engine",
            name: "agentguard-engine",
            capabilities: { reasonCodes: true, approvals: true, lifecycle: true, ledgerInspection: true, policyReload: true, failureInjection: true },
          },
    integrations: [...(opts.integrations ?? [])],
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      ci: process.env.CI === "true" || process.env.CI === "1",
      ...(process.env.GITHUB_SHA ? { gitSha: process.env.GITHUB_SHA } : {}),
      ...(process.env.GITHUB_REF ? { gitRef: process.env.GITHUB_REF } : {}),
      ...opts.environment,
    },
    summary,
    scenarios: results,
    findings,
  };
  return redact(report, opts.redaction);
}
