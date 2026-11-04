import { ApprovalVerifier, type ApprovalCheck } from "./approvals.js";
import { formatAtomic } from "./amounts.js";
import { newId } from "./canonical.js";
import {
  ACTIVE_STATUSES,
  canTransition,
  freezeReservation,
  type Ledger,
  type LedgerSession,
  type LifecycleStatus,
  type Reservation,
} from "./ledger.js";
import { dailyWindow, type Policy } from "./policy.js";
import { validateProposal, proposalToJson, type NormalizedProposal } from "./proposal.js";
import { reason, type Reason, type ReasonCode } from "./reasons.js";

export type Decision = "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL";

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/**
 * Extra validation supplied by an integration (e.g. NEAR account-ID syntax).
 * Validators can only add reasons; they cannot remove or override engine reasons.
 */
export interface ProposalValidator {
  readonly name: string;
  validate(proposal: NormalizedProposal, policy: Policy): Reason[] | Promise<Reason[]>;
}

export interface PolicyEngineOptions {
  policy: Policy;
  ledger: Ledger;
  clock?: Clock;
  /** Required to accept approval grants. Without it, approvals can never be satisfied. */
  approvalVerifier?: ApprovalVerifier;
  validators?: readonly ProposalValidator[];
}

export interface EvaluateOptions {
  /** An approval grant obtained from the approval service, if any. */
  approval?: unknown;
}

export interface PolicyEvaluation {
  readonly evaluationId: string;
  readonly decision: Decision;
  readonly reasonCodes: readonly ReasonCode[];
  readonly reasons: readonly Reason[];
  readonly policyVersion: 1;
  readonly policyHash: string;
  readonly evaluatedAt: string;
  /** Digest of the normalised proposal; present when the proposal was well-formed. Approvals bind to it. */
  readonly proposalDigest: string | undefined;
  readonly proposal: NormalizedProposal | undefined;
  /** Set by `authorize()` when a reservation was created, or when an idempotent replay returned one. */
  readonly reservation: Reservation | undefined;
  readonly replay: boolean;
}

export type LifecycleResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; reason: Reason; reservation: Reservation | undefined };

/**
 * Deterministic policy engine. Given the same policy, ledger state, clock and input,
 * it produces the same decision and reason codes. It never signs, submits or
 * executes a transaction: ALLOW only means the proposal may proceed to the next,
 * separately authorised execution stage.
 */
export class PolicyEngine {
  readonly policy: Policy;
  private readonly ledger: Ledger;
  private readonly clock: Clock;
  private readonly verifier: ApprovalVerifier | undefined;
  private readonly validators: readonly ProposalValidator[];

  constructor(options: PolicyEngineOptions) {
    if (!options.policy || !options.ledger) {
      throw new TypeError("PolicyEngine requires a policy and a ledger");
    }
    this.policy = options.policy;
    this.ledger = options.ledger;
    this.clock = options.clock ?? systemClock;
    this.verifier = options.approvalVerifier;
    this.validators = options.validators ?? [];
  }

  /** Evaluate without recording anything (a dry run). */
  evaluate(raw: unknown, options: EvaluateOptions = {}): Promise<PolicyEvaluation> {
    return this.run(raw, options, false);
  }

  /**
   * Evaluate and, if the decision is ALLOW, atomically reserve the amount in the
   * ledger. Concurrent calls for the same agent are serialised by the ledger, so
   * aggregate limits cannot be bypassed by racing requests.
   */
  authorize(raw: unknown, options: EvaluateOptions = {}): Promise<PolicyEvaluation> {
    return this.run(raw, options, true);
  }

  /**
   * The execution gate. An adapter must call this immediately before broadcasting.
   * It succeeds only for a `reserved` reservation created under the *current* policy
   * version, and moves it to `submitted` atomically so it cannot be executed twice.
   */
  async beginExecution(reservationId: string): Promise<LifecycleResult> {
    return this.mutate(reservationId, (r) => {
      if (r.status !== "reserved") {
        return reason(
          "INVALID_STATE_TRANSITION",
          `reservation is ${r.status}; only reserved reservations can be executed`,
        );
      }
      if (r.policyHash !== this.policy.hash) {
        return reason(
          "STALE_POLICY_VERSION",
          `reservation was authorised under ${r.policyHash} but the active policy is ${this.policy.hash}; cancel and re-authorise`,
        );
      }
      return undefined;
    }, "submitted");
  }

  /** Read a reservation (for adapters that must inspect it before passing the execution gate). */
  async getReservation(reservationId: string): Promise<Reservation | undefined> {
    const r = (await this.ledger.list()).find((x) => x.reservationId === reservationId);
    return r ? freezeReservation(r) : undefined;
  }

  /**
   * Attach the network's transaction reference to a submitted reservation whose outcome
   * is not yet known, so later reconciliation can be checked against it. A reference,
   * once set, cannot be replaced by a different one.
   */
  recordTransactionReference(reservationId: string, transactionReference: string): Promise<LifecycleResult> {
    return this.mutate(
      reservationId,
      (r) => {
        if (r.status !== "submitted") {
          return reason("INVALID_STATE_TRANSITION", `reservation is ${r.status}; references are attached while submitted`);
        }
        if (r.transactionReference !== undefined && r.transactionReference !== transactionReference) {
          return reason("INVALID_STATE_TRANSITION", "reservation already has a different transaction reference");
        }
        return undefined;
      },
      "submitted",
      { transactionReference, note: "transaction reference recorded" },
    );
  }

  /** Record the definitive outcome of a submitted transaction. */
  recordOutcome(
    reservationId: string,
    outcome: "confirmed" | "failed",
    details: { transactionReference?: string; note?: string } = {},
  ): Promise<LifecycleResult> {
    return this.mutate(reservationId, () => undefined, outcome, details);
  }

  /** Release a reservation that was never submitted. */
  cancel(reservationId: string, note?: string): Promise<LifecycleResult> {
    return this.mutate(reservationId, () => undefined, "cancelled", note === undefined ? {} : { note });
  }

  private async mutate(
    reservationId: string,
    guard: (r: Reservation) => Reason | undefined,
    to: LifecycleStatus,
    details: { transactionReference?: string; note?: string } = {},
  ): Promise<LifecycleResult> {
    let agentId: string | undefined;
    try {
      const snapshot = (await this.ledger.list()).find((r) => r.reservationId === reservationId);
      agentId = snapshot?.agentId;
    } catch {
      return { ok: false, reason: reason("LEDGER_UNAVAILABLE"), reservation: undefined };
    }
    if (agentId === undefined) {
      return { ok: false, reason: reason("RESERVATION_NOT_FOUND"), reservation: undefined };
    }
    try {
      return await this.ledger.runExclusive(agentId, async (session) => {
        const current = await session.get(reservationId);
        if (!current) return { ok: false, reason: reason("RESERVATION_NOT_FOUND"), reservation: undefined };
        const blocked = guard(current);
        if (blocked) return { ok: false, reason: blocked, reservation: freezeReservation(current) };
        const sameStatusUpdate = current.status === to && to === "submitted" && details.transactionReference !== undefined;
        if (!sameStatusUpdate && !canTransition(current.status, to)) {
          return {
            ok: false,
            reason: reason("INVALID_STATE_TRANSITION", `cannot move a ${current.status} reservation to ${to}`),
            reservation: freezeReservation(current),
          };
        }
        const at = this.clock.now().toISOString();
        const next: Reservation = {
          ...current,
          status: to,
          transactionReference: details.transactionReference ?? current.transactionReference,
          history: [...current.history, { status: to, at, ...(details.note ? { note: details.note } : {}) }],
        };
        await session.replace(next);
        return { ok: true, reservation: freezeReservation(next) };
      });
    } catch {
      return { ok: false, reason: reason("LEDGER_UNAVAILABLE"), reservation: undefined };
    }
  }

  private async run(raw: unknown, options: EvaluateOptions, reserve: boolean): Promise<PolicyEvaluation> {
    const now = this.clock.now();
    const evaluationId = newId("eval");
    const result = (
      decision: Decision,
      reasons: Reason[],
      proposal?: NormalizedProposal,
      reservation?: Reservation,
      replay = false,
    ): PolicyEvaluation =>
      Object.freeze({
        evaluationId,
        decision,
        reasonCodes: reasons.map((r) => r.code),
        reasons,
        policyVersion: 1,
        policyHash: this.policy.hash,
        evaluatedAt: now.toISOString(),
        proposalDigest: proposal?.digest,
        proposal,
        reservation: reservation ? freezeReservation(reservation) : undefined,
        replay,
      });

    try {
      const validation = validateProposal(raw, this.policy);
      if (!validation.ok) return result("BLOCK", validation.reasons);
      const p = validation.proposal;

      const reasons: Reason[] = [];
      for (const v of this.validators) {
        reasons.push(...(await v.validate(p, this.policy)));
      }
      const approvalNeeds = this.staticChecks(p, reasons);

      let approval: ApprovalCheck | undefined;
      if (options.approval !== undefined) {
        if (!this.verifier) {
          reasons.push(reason("APPROVAL_VERIFICATION_UNAVAILABLE"));
        } else {
          approval = this.verifier.verify(options.approval, {
            proposalDigest: p.digest,
            policyHash: this.policy.hash,
            now,
            maxAgeSeconds: this.policy.approvalMaxAgeSeconds,
          });
          if (!approval.ok) reasons.push(reason(approval.code, approval.message, "approval"));
        }
      }

      let outcome: PolicyEvaluation;
      try {
        outcome = await this.ledger.runExclusive(p.agentId, (session) =>
          this.ledgerStage(session, p, reasons, approvalNeeds, approval, now, reserve, result),
        );
      } catch {
        return result("BLOCK", [...reasons, reason("LEDGER_UNAVAILABLE")], p);
      }
      return outcome;
    } catch (err) {
      return result("BLOCK", [
        reason("EVALUATION_ERROR", `evaluation failed: ${(err as Error)?.message ?? "unknown error"}`),
      ]);
    }
  }

  /** Rules that depend only on the proposal and policy. Returns approval requirements. */
  private staticChecks(p: NormalizedProposal, reasons: Reason[]): Reason[] {
    const policy = this.policy;
    const approvalNeeds: Reason[] = [];
    if (p.agentId !== policy.agentId) {
      reasons.push(reason("AGENT_NOT_RECOGNISED", `agent "${p.agentId}" is not governed by this policy`, "agentId"));
    }
    const asset = policy.assets.get(p.assetId);
    if (!asset) {
      reasons.push(reason("ASSET_NOT_ALLOWED", `asset "${p.assetId}" is not configured in the policy`, "assetId"));
    }
    if (!policy.allowedNetworks.has(p.networkId)) {
      reasons.push(reason("NETWORK_NOT_ALLOWED", `network "${p.networkId}" is not on the allowlist`, "networkId"));
    }
    if (!policy.allowedRecipients.has(p.recipientId)) {
      if (policy.recipientMode === "allowlist") {
        reasons.push(reason("RECIPIENT_NOT_ALLOWED", `recipient "${p.recipientId}" is not on the allowlist`, "recipientId"));
      } else {
        approvalNeeds.push(
          reason("APPROVAL_REQUIRED_UNKNOWN_RECIPIENT", `recipient "${p.recipientId}" is not on the allowlist`, "recipientId"),
        );
      }
    }
    if (p.amountAtomic === 0n && !policy.allowZeroAmount) {
      reasons.push(reason("AMOUNT_ZERO", undefined, "amount"));
    }
    if (asset) {
      if (p.amountAtomic > asset.maxTransactionAtomic) {
        reasons.push(
          reason(
            "AMOUNT_EXCEEDS_TRANSACTION_LIMIT",
            `amount ${formatAtomic(p.amountAtomic, asset.decimals)} ${asset.id} exceeds max_transaction_amount ${formatAtomic(asset.maxTransactionAtomic, asset.decimals)}`,
            "amount",
          ),
        );
      }
      if (asset.approvalRequiredAboveAtomic !== null && p.amountAtomic > asset.approvalRequiredAboveAtomic) {
        approvalNeeds.push(
          reason(
            "APPROVAL_REQUIRED_AMOUNT",
            `amount ${formatAtomic(p.amountAtomic, asset.decimals)} ${asset.id} is above the approval threshold ${formatAtomic(asset.approvalRequiredAboveAtomic, asset.decimals)}`,
            "amount",
          ),
        );
      }
    }
    return approvalNeeds;
  }

  private async ledgerStage(
    session: LedgerSession,
    p: NormalizedProposal,
    reasons: Reason[],
    approvalNeeds: Reason[],
    approval: ApprovalCheck | undefined,
    now: Date,
    reserve: boolean,
    result: (d: Decision, r: Reason[], p?: NormalizedProposal, res?: Reservation, replay?: boolean) => PolicyEvaluation,
  ): Promise<PolicyEvaluation> {
    const policy = this.policy;
    const existing = await session.findByIdempotencyKey(p.agentId, p.idempotencyKey);
    if (existing) {
      if (existing.proposalDigest !== p.digest) {
        return result("BLOCK", [reason("IDEMPOTENCY_KEY_CONFLICT", undefined, "idempotencyKey")], p, existing);
      }
      if (!ACTIVE_STATUSES.has(existing.status)) {
        return result("BLOCK", [reason("IDEMPOTENCY_KEY_FINALISED", `reservation is ${existing.status}`)], p, existing);
      }
      if (existing.status === "reserved" && existing.policyHash !== policy.hash) {
        return result("BLOCK", [reason("STALE_POLICY_VERSION")], p, existing);
      }
      // Same proposal, same key: return the existing reservation and record nothing new.
      // Blocking reasons found earlier (e.g. a forged approval, or a rule the current
      // policy now fails) still apply: the replay is then reported as BLOCK.
      if (reasons.some((r) => r.blocking)) {
        return result("BLOCK", [...reasons, reason("IDEMPOTENT_REPLAY")], p, existing, true);
      }
      return result("ALLOW", [reason("IDEMPOTENT_REPLAY")], p, existing, true);
    }

    const window = dailyWindow(policy, now);
    const usage = await session.windowUsage(p.agentId, window.start, window.end);
    assertValidUsage(usage);
    const asset = policy.assets.get(p.assetId);
    if (asset) {
      const spent = usage.spentByAsset.get(asset.id) ?? 0n;
      if (spent + p.amountAtomic > asset.maxDailySpendAtomic) {
        reasons.push(
          reason(
            "DAILY_SPEND_LIMIT_EXCEEDED",
            `already reserved ${formatAtomic(spent, asset.decimals)} ${asset.id} today; ${formatAtomic(p.amountAtomic, asset.decimals)} more would exceed max_daily_spend ${formatAtomic(asset.maxDailySpendAtomic, asset.decimals)}`,
            "amount",
          ),
        );
      }
    }
    if (usage.count + 1 > policy.maxTransactionCountPerDay) {
      reasons.push(
        reason(
          "DAILY_COUNT_LIMIT_EXCEEDED",
          `${usage.count} transactions already reserved today; the limit is ${policy.maxTransactionCountPerDay}`,
        ),
      );
    }
    if (approval?.ok && (await session.isApprovalConsumed(approval.grant.approvalId))) {
      reasons.push(reason("APPROVAL_ALREADY_USED", undefined, "approval"));
    }

    if (reasons.some((r) => r.blocking)) {
      return result("BLOCK", [...reasons, ...approvalNeeds], p);
    }
    const approved = approval?.ok === true && !reasons.some((r) => r.code === "APPROVAL_ALREADY_USED");
    if (approvalNeeds.length > 0 && !approved) {
      return result("REQUIRE_APPROVAL", [...reasons, ...approvalNeeds], p);
    }
    const finalReasons = approved ? [...reasons, ...approvalNeeds, reason("APPROVAL_VERIFIED")] : reasons;
    if (!reserve) return result("ALLOW", finalReasons, p);

    const at = now.toISOString();
    const reservation: Reservation = {
      reservationId: newId("res"),
      agentId: p.agentId,
      requestId: p.requestId,
      idempotencyKey: p.idempotencyKey,
      proposalDigest: p.digest,
      policyHash: policy.hash,
      assetId: p.assetId,
      networkId: p.networkId,
      recipientId: p.recipientId,
      amountAtomic: p.amountAtomic,
      approvalId: approved && approval?.ok ? approval.grant.approvalId : undefined,
      createdAt: at,
      status: "reserved",
      transactionReference: undefined,
      history: [{ status: "reserved", at }],
    };
    await session.insert(reservation);
    return result("ALLOW", finalReasons, p, reservation);
  }
}

/** Fail closed on a ledger that returns malformed usage (e.g. a missing count would compare as NaN). */
function assertValidUsage(usage: unknown): void {
  const u = usage as { count?: unknown; spentByAsset?: unknown } | null;
  if (!u || !Number.isSafeInteger(u.count) || (u.count as number) < 0 || !(u.spentByAsset instanceof Map)) {
    throw new Error("ledger returned malformed window usage");
  }
  for (const v of u.spentByAsset.values()) {
    if (typeof v !== "bigint" || v < 0n) throw new Error("ledger returned malformed window usage");
  }
}

/** JSON-safe projection of an evaluation (BigInt → string), for reports and logs. */
export function evaluationToJson(e: PolicyEvaluation): Record<string, unknown> {
  return {
    evaluationId: e.evaluationId,
    decision: e.decision,
    reasonCodes: [...e.reasonCodes],
    reasons: e.reasons.map((r) => ({ ...r })),
    policyVersion: e.policyVersion,
    policyHash: e.policyHash,
    evaluatedAt: e.evaluatedAt,
    proposalDigest: e.proposalDigest,
    proposal: e.proposal ? proposalToJson(e.proposal) : undefined,
    reservation: e.reservation ? reservationToJson(e.reservation) : undefined,
    replay: e.replay,
  };
}

export function reservationToJson(r: Reservation): Record<string, unknown> {
  return { ...r, amountAtomic: r.amountAtomic.toString(), history: r.history.map((h) => ({ ...h })) };
}
