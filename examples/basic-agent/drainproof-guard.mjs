// The same guard built on @drainproof/core. This is how an agent runtime would use the
// engine in production: authorize() before every payment, beginExecution() right before
// broadcasting, recordOutcome() afterwards. It exposes every capability, so the full
// scenario suite runs against it.
import { randomBytes } from "node:crypto";
import { ApprovalAuthority, InMemoryLedger, PolicyEngine, dailyWindow, policyFromObject } from "@drainproof/core";

export function createTarget({ policyDocument, clock, seed, ledgerUnavailable }) {
  const authority = new ApprovalAuthority(randomBytes(32)); // stands in for your approval service
  const untrusted = new ApprovalAuthority(randomBytes(32));
  const ledger = ledgerUnavailable
    ? { runExclusive: () => Promise.reject(new Error("ledger down")), list: () => Promise.reject(new Error("ledger down")) }
    : new InMemoryLedger();
  if (!ledgerUnavailable) ledger.seed(seed);
  const build = (doc) => {
    const loaded = policyFromObject(doc);
    if (!loaded.ok) throw new Error(loaded.issues.map((i) => i.message).join("; "));
    return new PolicyEngine({ policy: loaded.policy, ledger, clock, approvalVerifier: authority.verifier() });
  };
  let doc = policyDocument;
  let engine = build(doc);
  const lifecycle = (r) => (r.ok ? { ok: true } : { ok: false, reasonCode: r.reason.code });
  const seeded = new Set(seed.map((s) => s.reservationId));

  return {
    name: "guard-built-on-drainproof-core",
    capabilities: { reasonCodes: true, approvals: true, lifecycle: true, ledgerInspection: true, policyReload: true, failureInjection: true },
    async propose(proposal, { approval }) {
      const e = await engine.authorize(proposal, approval === undefined ? {} : { approval });
      return { decision: e.decision, reasonCodes: e.reasonCodes, replay: e.replay, handle: e.reservation?.reservationId, proposalDigest: e.proposalDigest };
    },
    async issueApproval({ result, approverId, ttlSeconds, signingKey }) {
      if (!result.proposalDigest) throw new Error("cannot approve an invalid proposal");
      return (signingKey === "trusted" ? authority : untrusted).issue({
        proposalDigest: result.proposalDigest, policyHash: engine.policy.hash, approverId, ttlSeconds, now: clock.now(),
      });
    },
    execute: async (h) => (h ? lifecycle(await engine.beginExecution(h)) : { ok: false, reasonCode: "RESERVATION_NOT_FOUND" }),
    recordOutcome: async (h, outcome, ref) =>
      h ? lifecycle(await engine.recordOutcome(h, outcome, ref ? { transactionReference: ref } : {})) : { ok: false, reasonCode: "RESERVATION_NOT_FOUND" },
    cancel: async (h) => (h ? lifecycle(await engine.cancel(h)) : { ok: false, reasonCode: "RESERVATION_NOT_FOUND" }),
    async reloadPolicy(set) {
      const next = structuredClone(doc);
      for (const [path, value] of Object.entries(set)) {
        const parts = path.split(".");
        let node = next;
        for (const p of parts.slice(0, -1)) node = node[p];
        node[parts.at(-1)] = value;
      }
      engine = build(next);
      doc = next;
    },
    async ledgerUsage(assetId) {
      const all = await ledger.list();
      const w = dailyWindow(engine.policy, clock.now());
      const active = all.filter((r) => ["reserved", "submitted", "confirmed"].includes(r.status) && Date.parse(r.createdAt) >= w.start.getTime() && Date.parse(r.createdAt) < w.end.getTime());
      return {
        activeAtomic: active.filter((r) => r.assetId === assetId).reduce((s, r) => s + r.amountAtomic, 0n),
        activeCount: active.length,
        created: all.filter((r) => !seeded.has(r.reservationId)).length,
      };
    },
  };
}
