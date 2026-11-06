import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  ApprovalAuthority,
  InMemoryLedger,
  PolicyEngine,
  dailyWindow,
  parseDecimalAmount,
  policyFromObject,
  type Clock,
  type Decision,
  type Ledger,
  type Policy,
  type PolicyDocument,
  type ProposalValidator,
  type Reservation,
} from "@drainproof/core";
import type { Scenario } from "./scenario.js";

export interface TargetProposeResult {
  decision: Decision;
  /** Reason codes, if the target reports them (`capabilities.reasonCodes`). */
  reasonCodes?: readonly string[];
  /** True when the target recognised the request as an idempotent replay. */
  replay?: boolean;
  /** Opaque handle to the reservation, if one exists (used by lifecycle steps). */
  handle?: string;
  /** Digest identifying the exact proposal, if the target binds approvals to one. */
  proposalDigest?: string;
}

export interface LifecycleOutcome {
  ok: boolean;
  reasonCode?: string;
}

export interface LedgerUsage {
  /** Active amount in atomic units for the requested asset (current window). */
  activeAtomic: bigint;
  /** Active reservation count, all assets (current window). */
  activeCount: number;
  /** Reservations created during this scenario (excludes seeded history). */
  created: number;
}

export interface TargetCapabilities {
  reasonCodes: boolean;
  approvals: boolean;
  lifecycle: boolean;
  ledgerInspection: boolean;
  policyReload: boolean;
  failureInjection: boolean;
}

/**
 * A guard under test. The built-in engine target implements everything; a custom
 * target (your own guard, agent wrapper, or framework adapter) implements `propose`
 * and whichever optional capabilities it supports. Scenarios that need a missing
 * capability are reported as SKIPPED, never as PASS.
 */
export interface GuardTarget {
  readonly name: string;
  readonly capabilities: TargetCapabilities;
  propose(proposal: unknown, ctx: { approval?: unknown }): Promise<TargetProposeResult>;
  issueApproval?(input: {
    result: TargetProposeResult;
    approverId: string;
    ttlSeconds: number;
    signingKey: "trusted" | "untrusted";
  }): Promise<unknown>;
  execute?(handle: string | undefined): Promise<LifecycleOutcome>;
  recordOutcome?(handle: string | undefined, outcome: "confirmed" | "failed", transactionReference?: string): Promise<LifecycleOutcome>;
  cancel?(handle: string | undefined): Promise<LifecycleOutcome>;
  reloadPolicy?(set: Record<string, unknown>): Promise<void>;
  ledgerUsage?(assetId: string): Promise<LedgerUsage>;
  /**
   * Optional. Called once per scenario, after the capability check and before any step.
   * Return a reason to report the scenario as SKIPPED (for example because the guard has
   * no equivalent of what the scenario tests), or `undefined` to run it.
   */
  unsupported?(scenario: Scenario): string | undefined | Promise<string | undefined>;
  dispose?(): Promise<void>;
}

export interface TargetContext {
  /** Policy document after any scenario `policy_patch`. */
  policyDocument: PolicyDocument;
  policy: Policy;
  clock: Clock;
  /** Historical reservations the scenario starts with. */
  seed: readonly Reservation[];
  /** The scenario asks for ledger state to be unavailable (fail-closed tests). */
  ledgerUnavailable: boolean;
  validators: readonly ProposalValidator[];
}

export type TargetFactory = (ctx: TargetContext) => GuardTarget | Promise<GuardTarget>;

/** Apply dotted-path assignments (e.g. `assets.0.max_daily_spend`) to a copy of a policy document and revalidate it. */
export function patchPolicy(doc: PolicyDocument, set: Record<string, unknown>, source: string) {
  const copy = structuredClone(doc) as Record<string, unknown>;
  for (const [dotted, value] of Object.entries(set)) {
    const parts = dotted.split(".");
    if (parts.some((p) => p === "" || p === "__proto__" || p === "constructor" || p === "prototype")) {
      throw new Error(`invalid policy patch path "${dotted}"`);
    }
    let node: unknown = copy;
    for (const part of parts.slice(0, -1)) {
      if (typeof node !== "object" || node === null || !Object.hasOwn(node, part)) {
        throw new Error(`policy patch path "${dotted}" does not exist`);
      }
      node = (node as Record<string, unknown>)[part];
    }
    if (typeof node !== "object" || node === null) throw new Error(`policy patch path "${dotted}" does not exist`);
    (node as Record<string, unknown>)[parts.at(-1)!] = value;
  }
  return policyFromObject(copy, source);
}

class UnavailableLedger implements Ledger {
  runExclusive(): Promise<never> {
    return Promise.reject(new Error("ledger unavailable (injected by scenario)"));
  }
  list(): Promise<never> {
    return Promise.reject(new Error("ledger unavailable (injected by scenario)"));
  }
}

/** The built-in target: Drainproof's own engine with an isolated in-memory ledger per scenario. */
export const engineTargetFactory: TargetFactory = (ctx) => {
  const trusted = new ApprovalAuthority(randomBytes(32));
  const untrusted = new ApprovalAuthority(randomBytes(32));
  const ledger = ctx.ledgerUnavailable ? new UnavailableLedger() : new InMemoryLedger();
  if (ledger instanceof InMemoryLedger) ledger.seed(ctx.seed);
  const seededIds = new Set(ctx.seed.map((s) => s.reservationId));
  const make = (policy: Policy) =>
    new PolicyEngine({ policy, ledger, clock: ctx.clock, approvalVerifier: trusted.verifier(), validators: ctx.validators });
  let engine = make(ctx.policy);
  let document = ctx.policyDocument;

  const lifecycle = (r: { ok: boolean; reason?: { code: string } }): LifecycleOutcome =>
    r.ok ? { ok: true } : { ok: false, ...(r.reason ? { reasonCode: r.reason.code } : {}) };

  return {
    name: "drainproof-engine",
    capabilities: {
      reasonCodes: true,
      approvals: true,
      lifecycle: true,
      ledgerInspection: true,
      policyReload: true,
      failureInjection: true,
    },
    async propose(proposal, { approval }) {
      const e = await engine.authorize(proposal, approval === undefined ? {} : { approval });
      return {
        decision: e.decision,
        reasonCodes: e.reasonCodes,
        replay: e.replay,
        ...(e.reservation ? { handle: e.reservation.reservationId } : {}),
        ...(e.proposalDigest ? { proposalDigest: e.proposalDigest } : {}),
      };
    },
    async issueApproval({ result, approverId, ttlSeconds, signingKey }) {
      if (!result.proposalDigest) {
        throw new Error("cannot approve a proposal that failed validation (no proposal digest)");
      }
      const authority = signingKey === "trusted" ? trusted : untrusted;
      return authority.issue({
        proposalDigest: result.proposalDigest,
        policyHash: engine.policy.hash,
        approverId,
        ttlSeconds,
        now: ctx.clock.now(),
      });
    },
    async execute(handle) {
      if (!handle) return { ok: false, reasonCode: "RESERVATION_NOT_FOUND" };
      return lifecycle(await engine.beginExecution(handle));
    },
    async recordOutcome(handle, outcome, transactionReference) {
      if (!handle) return { ok: false, reasonCode: "RESERVATION_NOT_FOUND" };
      return lifecycle(
        await engine.recordOutcome(handle, outcome, transactionReference ? { transactionReference } : {}),
      );
    },
    async cancel(handle) {
      if (!handle) return { ok: false, reasonCode: "RESERVATION_NOT_FOUND" };
      return lifecycle(await engine.cancel(handle));
    },
    async reloadPolicy(set) {
      const r = patchPolicy(document, set, "reload_policy");
      if (!r.ok) throw new Error(`reload_policy produced an invalid policy: ${r.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
      document = r.policy.document;
      engine = make(r.policy);
    },
    async ledgerUsage(assetId) {
      const all = await ledger.list();
      const window = dailyWindow(engine.policy, ctx.clock.now());
      let activeAtomic = 0n;
      let activeCount = 0;
      for (const r of all) {
        const t = Date.parse(r.createdAt);
        if (!["reserved", "submitted", "confirmed"].includes(r.status)) continue;
        if (t < window.start.getTime() || t >= window.end.getTime()) continue;
        activeCount++;
        if (r.assetId === assetId) activeAtomic += r.amountAtomic;
      }
      return { activeAtomic, activeCount, created: all.filter((r) => !seededIds.has(r.reservationId)).length };
    },
  };
};

const DECISIONS = new Set(["ALLOW", "BLOCK", "REQUIRE_APPROVAL"]);

/** Wrap an untrusted custom target so malformed results surface as errors, never as passes. */
export function guardTargetShape(t: unknown, origin: string): GuardTarget {
  if (typeof t !== "object" || t === null) throw new Error(`${origin}: createTarget() must return an object`);
  const target = t as Partial<GuardTarget>;
  if (typeof target.name !== "string" || typeof target.propose !== "function") {
    throw new Error(`${origin}: target must have a string \`name\` and a \`propose\` function`);
  }
  const caps = target.capabilities ?? ({} as Partial<TargetCapabilities>);
  const capabilities: TargetCapabilities = {
    reasonCodes: caps.reasonCodes === true,
    approvals: caps.approvals === true && typeof target.issueApproval === "function",
    lifecycle:
      caps.lifecycle === true &&
      typeof target.execute === "function" &&
      typeof target.recordOutcome === "function" &&
      typeof target.cancel === "function",
    ledgerInspection: caps.ledgerInspection === true && typeof target.ledgerUsage === "function",
    policyReload: caps.policyReload === true && typeof target.reloadPolicy === "function",
    failureInjection: caps.failureInjection === true,
  };
  const propose = target.propose.bind(target);
  const optional = <K extends "issueApproval" | "execute" | "recordOutcome" | "cancel" | "reloadPolicy" | "ledgerUsage" | "unsupported" | "dispose">(
    key: K,
  ): Partial<Pick<GuardTarget, K>> => {
    const fn = target[key];
    return typeof fn === "function" ? ({ [key]: (fn as (...a: unknown[]) => unknown).bind(target) } as Partial<Pick<GuardTarget, K>>) : {};
  };
  return {
    ...optional("issueApproval"),
    ...optional("execute"),
    ...optional("recordOutcome"),
    ...optional("cancel"),
    ...optional("reloadPolicy"),
    ...optional("ledgerUsage"),
    ...optional("unsupported"),
    ...optional("dispose"),
    name: target.name,
    capabilities,
    async propose(proposal, ctx) {
      const r: unknown = await propose(proposal, ctx);
      if (typeof r !== "object" || r === null || !DECISIONS.has((r as TargetProposeResult).decision)) {
        throw new Error(`${origin}: propose() returned an invalid result (expected { decision: "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL" })`);
      }
      const codes = (r as TargetProposeResult).reasonCodes;
      if (codes !== undefined && (!Array.isArray(codes) || codes.some((c) => typeof c !== "string"))) {
        throw new Error(`${origin}: propose() returned non-string reasonCodes`);
      }
      return r as TargetProposeResult;
    },
  };
}

/** Load a custom target module exporting `createTarget` (named or default). */
export async function loadModuleTarget(absPath: string): Promise<TargetFactory> {
  const mod = (await import(pathToFileURL(absPath).href)) as { createTarget?: unknown; default?: unknown };
  const factory = mod.createTarget ?? mod.default;
  if (typeof factory !== "function") {
    throw new Error(`${absPath} must export a createTarget(context) function`);
  }
  return async (ctx) => guardTargetShape(await (factory as TargetFactory)(ctx), absPath);
}

/** Convert a decimal amount for the given asset, throwing on invalid input (used for scenario fixtures). */
export function fixtureAmount(policy: Policy, assetId: string, amount: string, where: string): bigint {
  const asset = policy.assets.get(assetId);
  if (!asset) throw new Error(`${where}: asset "${assetId}" is not configured in the policy`);
  const r = parseDecimalAmount(amount, asset.decimals);
  if (!r.ok) throw new Error(`${where}: ${r.message}`);
  return r.value;
}
