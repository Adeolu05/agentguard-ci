/**
 * Regression tests for defects found by an independent adversarial review.
 * Each test reproduces the original attack and asserts it now fails closed.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, InMemoryLedger, type Ledger, type LedgerSession } from "../src/index.js";
import { APPROVAL_SECRET, BASE_POLICY_YAML, proposal, setup } from "./fixtures.js";

const NO_APPROVAL_YAML = BASE_POLICY_YAML.replace('    approval_required_above: "10"\n', "");

describe("approval grants are read exactly once (TOCTOU)", () => {
  it("a getter cannot redirect a grant for proposal A to proposal B", async () => {
    const { engine, authority, policy, clock } = setup();
    const a = proposal({ amount: "11" });
    const b = proposal({ amount: "25" });
    const evA = await engine.authorize(a);
    const evB = await engine.authorize(b);
    const grantA = authority.issue({ proposalDigest: evA.proposalDigest!, policyHash: policy.hash, approverId: "x", ttlSeconds: 60, now: clock.now() });
    const tricky: Record<string, unknown> = { ...grantA };
    let reads = 0;
    Object.defineProperty(tricky, "proposalDigest", {
      enumerable: true,
      get: () => (++reads <= 1 ? grantA.proposalDigest : evB.proposalDigest),
    });
    const e = await engine.authorize(b, { approval: tricky });
    expect(e.decision).toBe("BLOCK");
    expect(e.reasonCodes).toContain("APPROVAL_PROPOSAL_MISMATCH");
  });

  it("a getter cannot turn an expired grant into a valid one", async () => {
    const { engine, authority, policy, clock } = setup();
    const p = proposal({ amount: "11" });
    const ev = await engine.authorize(p);
    const grant = authority.issue({ proposalDigest: ev.proposalDigest!, policyHash: policy.hash, approverId: "x", ttlSeconds: 60, now: clock.now() });
    clock.advance(120); // the grant is now expired
    const freshIssued = clock.now().toISOString();
    const freshExpires = new Date(clock.now().getTime() + 60_000).toISOString();
    const tricky: Record<string, unknown> = { ...grant };
    // The original exploit served the real values to validation and the signature check
    // (5 reads each), then a fresh, valid-looking window to the time comparisons.
    const swap = (field: "issuedAt" | "expiresAt", later: string) => {
      let reads = 0;
      Object.defineProperty(tricky, field, { enumerable: true, get: () => (++reads <= 5 ? grant[field] : later) });
    };
    swap("issuedAt", freshIssued);
    swap("expiresAt", freshExpires);
    const e = await engine.authorize(p, { approval: tricky });
    expect(e.decision).toBe("BLOCK");
    expect(e.reasonCodes).toContain("APPROVAL_EXPIRED");
  });

  it("rejects signed grants whose timestamps are not real instants", async () => {
    const { engine, policy, clock } = setup();
    const p = proposal({ amount: "11" });
    const ev = await engine.authorize(p);
    for (const expiresAt of ["2026-11-04T25:00:00Z", "2026-02-30T12:00:00Z"]) {
      const unsigned = {
        version: 1 as const, approvalId: "apr_x", proposalDigest: ev.proposalDigest!, policyHash: policy.hash,
        approverId: "x", issuedAt: clock.now().toISOString(), expiresAt,
      };
      const signature = createHmac("sha256", Buffer.from(APPROVAL_SECRET)).update(canonicalJson(unsigned)).digest("base64url");
      const e = await engine.authorize(p, { approval: { ...unsigned, signature } });
      expect(e.decision, expiresAt).toBe("BLOCK");
      expect(e.reasonCodes).toContain("APPROVAL_MALFORMED");
    }
  });
});

describe("callers cannot mutate ledger state through returned objects", () => {
  it("evaluation reservations are frozen copies", async () => {
    const { engine, ledger } = setup({ yaml: NO_APPROVAL_YAML });
    const e = await engine.authorize(proposal({ amount: "25" }));
    const r = e.reservation as unknown as Record<string, unknown>;
    expect(Object.isFrozen(r)).toBe(true);
    expect(() => { r.amountAtomic = 0n; }).toThrow(TypeError);
    expect(() => { r.recipientId = "attacker"; }).toThrow(TypeError);
    // Accounting is intact: three more 25 USDC payments fit, a fourth does not.
    for (let i = 0; i < 3; i++) expect((await engine.authorize(proposal({ amount: "25" }))).decision).toBe("ALLOW");
    expect((await engine.authorize(proposal({ amount: "25" }))).reasonCodes).toEqual(["DAILY_SPEND_LIMIT_EXCEEDED"]);
    const gate = await engine.beginExecution(e.reservation!.reservationId);
    expect(gate.ok && gate.reservation.recipientId).toBe("merchant-example");
    for (const x of await ledger.list()) expect(Object.isFrozen(x)).toBe(true);
  });

  it("getReservation and seeded entries are frozen too", async () => {
    const { engine } = setup({ yaml: NO_APPROVAL_YAML });
    const e = await engine.authorize(proposal());
    const got = await engine.getReservation(e.reservation!.reservationId);
    expect(Object.isFrozen(got)).toBe(true);
    expect(Object.isFrozen(got!.history)).toBe(true);
  });

  it("the policy document and asset limits are immutable", () => {
    const { policy } = setup();
    expect(Object.isFrozen(policy.document)).toBe(true);
    expect(Object.isFrozen(policy.document.assets[0])).toBe(true);
    expect(Object.isFrozen(policy.assets.get("USDC"))).toBe(true);
  });
});

describe("idempotent replays still honour blocking reasons", () => {
  it("a replay presented with a forged approval is blocked", async () => {
    const { engine, ledger } = setup({ yaml: NO_APPROVAL_YAML });
    const p = proposal({ amount: "5", idempotencyKey: "k-replay" });
    await engine.authorize(p);
    const e = await engine.authorize(p, { approval: { forged: true } });
    expect(e.decision).toBe("BLOCK");
    expect(e.reasonCodes).toEqual(expect.arrayContaining(["APPROVAL_MALFORMED", "IDEMPOTENT_REPLAY"]));
    expect(e.replay).toBe(true);
    expect(await ledger.list()).toHaveLength(1);
  });
});

describe("malformed ledger and proposal inputs fail closed", () => {
  it("a ledger returning malformed usage blocks instead of allowing", async () => {
    class Broken extends InMemoryLedger {
      protected override session(): LedgerSession {
        const s = super.session();
        return { ...s, windowUsage: async () => ({ spentByAsset: new Map() }) as never };
      }
    }
    const { engine } = setup({ yaml: NO_APPROVAL_YAML.replace("max_transaction_count_per_day: 20", "max_transaction_count_per_day: 0"), ledger: new Broken() as Ledger });
    const e = await engine.authorize(proposal());
    expect(e.decision).toBe("BLOCK");
    expect(e.reasonCodes).toContain("LEDGER_UNAVAILABLE");
  });

  it("a toJSON that returns a non-object is a malformed proposal", async () => {
    const { engine } = setup();
    for (const replacement of [null, "x", [1]]) {
      const p = { ...proposal(), toJSON: () => replacement };
      const e = await engine.authorize(p);
      expect(e.reasonCodes).toEqual(["PROPOSAL_MALFORMED"]);
    }
  });
});

describe("transaction references", () => {
  it("can be attached once to a submitted reservation and not replaced", async () => {
    const { engine } = setup({ yaml: NO_APPROVAL_YAML });
    const id = (await engine.authorize(proposal())).reservation!.reservationId;
    expect((await engine.recordTransactionReference(id, "tx-1")).ok).toBe(false); // still reserved
    await engine.beginExecution(id);
    const r1 = await engine.recordTransactionReference(id, "tx-1");
    expect(r1.ok && r1.reservation.transactionReference).toBe("tx-1");
    expect((await engine.recordTransactionReference(id, "tx-1")).ok).toBe(true); // idempotent
    expect((await engine.recordTransactionReference(id, "tx-2")).ok).toBe(false);
    expect((await engine.getReservation(id))?.status).toBe("submitted");
  });
});

