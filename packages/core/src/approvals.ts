import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson, newId } from "./canonical.js";
import type { ReasonCode } from "./reasons.js";

/**
 * An approval grant authorises exactly one proposal (identified by its digest) under
 * exactly one policy version, for a bounded time. It is signed with an HMAC key that
 * belongs to the approval service, not to the agent. An agent that can forge grants
 * has, by definition, compromised the approval boundary.
 *
 * REQUIRE_APPROVAL from the engine is NOT an approval: it only says that a grant is
 * needed before the proposal may be reserved.
 */
export interface ApprovalGrant {
  version: 1;
  approvalId: string;
  proposalDigest: string;
  policyHash: string;
  approverId: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}

const MIN_KEY_BYTES = 32;

function toKey(secret: string | Uint8Array): Buffer {
  const key = typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret);
  if (key.length < MIN_KEY_BYTES) {
    throw new RangeError(`approval signing key must be at least ${MIN_KEY_BYTES} bytes`);
  }
  return key;
}

function sign(key: Buffer, grant: Omit<ApprovalGrant, "signature">): string {
  return createHmac("sha256", key).update(canonicalJson(grant)).digest("base64url");
}

export interface IssueApprovalInput {
  proposalDigest: string;
  policyHash: string;
  approverId: string;
  ttlSeconds: number;
  now: Date;
}

/** Issues approval grants. Hold this on the approval service side only. */
export class ApprovalAuthority {
  private readonly key: Buffer;
  constructor(secret: string | Uint8Array) {
    this.key = toKey(secret);
  }

  issue(input: IssueApprovalInput): ApprovalGrant {
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
      throw new RangeError("ttlSeconds must be a positive integer");
    }
    const unsigned = {
      version: 1 as const,
      approvalId: newId("apr"),
      proposalDigest: input.proposalDigest,
      policyHash: input.policyHash,
      approverId: input.approverId,
      issuedAt: input.now.toISOString(),
      expiresAt: new Date(input.now.getTime() + input.ttlSeconds * 1000).toISOString(),
    };
    return { ...unsigned, signature: sign(this.key, unsigned) };
  }

  verifier(): ApprovalVerifier {
    return new ApprovalVerifier(this.key);
  }
}

export interface VerifyContext {
  proposalDigest: string;
  policyHash: string;
  now: Date;
  maxAgeSeconds: number;
}

export type ApprovalCheck = { ok: true; grant: ApprovalGrant } | { ok: false; code: ReasonCode; message: string };

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export class ApprovalVerifier {
  private readonly key: Buffer;
  constructor(secret: string | Uint8Array) {
    this.key = toKey(secret);
  }

  verify(input: unknown, ctx: VerifyContext): ApprovalCheck {
    const grant = parseGrant(input);
    if (!grant) return { ok: false, code: "APPROVAL_MALFORMED", message: "approval grant is malformed" };

    const { signature, ...unsigned } = grant;
    const expected = Buffer.from(sign(this.key, unsigned));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return { ok: false, code: "APPROVAL_INVALID_SIGNATURE", message: "approval signature does not verify" };
    }
    if (grant.policyHash !== ctx.policyHash) {
      return {
        ok: false,
        code: "APPROVAL_POLICY_MISMATCH",
        message: "approval was issued under a different policy version; re-approve under the current policy",
      };
    }
    if (grant.proposalDigest !== ctx.proposalDigest) {
      return {
        ok: false,
        code: "APPROVAL_PROPOSAL_MISMATCH",
        message: "approval was issued for a different proposal (a material field such as amount, recipient or network changed)",
      };
    }
    const issued = Date.parse(grant.issuedAt);
    const expires = Date.parse(grant.expiresAt);
    const now = ctx.now.getTime();
    if (expires - issued > ctx.maxAgeSeconds * 1000 || expires <= issued) {
      return {
        ok: false,
        code: "APPROVAL_LIFETIME_EXCEEDED",
        message: `approval lifetime exceeds approval.max_age_seconds (${ctx.maxAgeSeconds}s)`,
      };
    }
    if (issued > now) return { ok: false, code: "APPROVAL_NOT_YET_VALID", message: "approval issue time is in the future" };
    if (now >= expires) return { ok: false, code: "APPROVAL_EXPIRED", message: `approval expired at ${grant.expiresAt}` };
    return { ok: true, grant };
  }
}

function parseGrant(input: unknown): ApprovalGrant | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const g = input as Record<string, unknown>;
  const keys = ["version", "approvalId", "proposalDigest", "policyHash", "approverId", "issuedAt", "expiresAt", "signature"];
  if (Object.keys(g).length !== keys.length || !keys.every((k) => Object.hasOwn(g, k))) return undefined;
  if (g.version !== 1) return undefined;
  for (const k of keys.slice(1)) {
    if (typeof g[k] !== "string" || (g[k] as string).length === 0 || (g[k] as string).length > 256) return undefined;
  }
  if (!ISO_RE.test(g.issuedAt as string) || !ISO_RE.test(g.expiresAt as string)) return undefined;
  return g as unknown as ApprovalGrant;
}
