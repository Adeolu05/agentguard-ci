import { parseAtomicAmount, parseDecimalAmount, type AmountErrorCode } from "./amounts.js";
import { canonicalJson, hashCanonical } from "./canonical.js";
import { IDENTIFIER_PATTERN, type Policy } from "./policy.js";
import { reason, type Reason, type ReasonCode } from "./reasons.js";

/**
 * The raw proposal an agent submits. Every field is untrusted. Exactly one of
 * `amount` (decimal string in whole asset units) or `amountAtomic` (integer string
 * in the asset's smallest unit) must be present.
 */
export interface TransactionProposal {
  requestId: string;
  agentId: string;
  assetId: string;
  amount?: string;
  amountAtomic?: string;
  recipientId: string;
  networkId: string;
  idempotencyKey?: string;
  /** Free text carried for audit only. Never interpreted by the engine. */
  memo?: string;
}

export interface NormalizedProposal {
  readonly requestId: string;
  readonly agentId: string;
  readonly assetId: string;
  readonly amountAtomic: bigint;
  readonly recipientId: string;
  readonly networkId: string;
  /** `idempotencyKey` if supplied, otherwise `request:<requestId>`. */
  readonly idempotencyKey: string;
  readonly memo: string | undefined;
  /** Binds approvals and idempotency to the exact material content of the proposal. */
  readonly digest: string;
}

export const ALLOWED_PROPOSAL_FIELDS = new Set([
  "requestId",
  "agentId",
  "assetId",
  "amount",
  "amountAtomic",
  "recipientId",
  "networkId",
  "idempotencyKey",
  "memo",
]);
export const MAX_PROPOSAL_BYTES = 4096;
export const MAX_MEMO_LENGTH = 256;

export type ProposalValidation =
  | { ok: true; proposal: NormalizedProposal }
  | { ok: false; reasons: Reason[] };

const AMOUNT_CODE: Record<AmountErrorCode, ReasonCode> = {
  AMOUNT_NOT_STRING: "AMOUNT_INVALID",
  AMOUNT_EMPTY: "AMOUNT_INVALID",
  AMOUNT_FORMAT: "AMOUNT_INVALID",
  AMOUNT_NEGATIVE: "AMOUNT_NEGATIVE",
  AMOUNT_PRECISION_EXCEEDED: "AMOUNT_PRECISION_EXCEEDED",
  AMOUNT_TOO_LARGE: "AMOUNT_TOO_LARGE",
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Validate an untrusted proposal. Never throws for bad input; all problems are
 * reported as validation reasons. Amount conversion needs the asset's decimals, so
 * an amount in an unconfigured asset is reported via ASSET_NOT_ALLOWED by the engine.
 */
export function validateProposal(input: unknown, policy: Policy): ProposalValidation {
  if (!isPlainObject(input)) {
    return { ok: false, reasons: [reason("PROPOSAL_MALFORMED")] };
  }
  let raw: Record<string, unknown> = input;
  // Work on a JSON snapshot: every field is read exactly once, so getters or proxies
  // cannot present one value to validation and another one later (TOCTOU).
  let size: number;
  try {
    const json = JSON.stringify(raw);
    size = Buffer.byteLength(json, "utf8");
    if (size <= MAX_PROPOSAL_BYTES) raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { ok: false, reasons: [reason("PROPOSAL_MALFORMED", "proposal is not JSON-serialisable")] };
  }
  if (size > MAX_PROPOSAL_BYTES) {
    return {
      ok: false,
      reasons: [reason("PROPOSAL_TOO_LARGE", `proposal is ${size} bytes; the limit is ${MAX_PROPOSAL_BYTES}`)],
    };
  }

  const reasons: Reason[] = [];
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_PROPOSAL_FIELDS.has(key)) {
      reasons.push(
        reason(
          "PROPOSAL_UNKNOWN_FIELD",
          `field "${key.slice(0, 64)}" is not part of the proposal schema; unexpected fields are rejected rather than ignored`,
          key.slice(0, 64),
        ),
      );
    }
  }

  const ident = (field: keyof TransactionProposal, missing: ReasonCode, invalid: ReasonCode, required = true) => {
    const v = raw[field];
    if (v === undefined || v === null) {
      if (required) reasons.push(reason(missing, undefined, field));
      return undefined;
    }
    if (typeof v !== "string" || !IDENTIFIER_PATTERN.test(v)) {
      reasons.push(
        reason(invalid, `${field} must be 1-128 printable ASCII characters without whitespace`, field),
      );
      return undefined;
    }
    return v;
  };

  const requestId = ident("requestId", "REQUEST_ID_MISSING", "REQUEST_ID_INVALID");
  const agentId = ident("agentId", "AGENT_ID_MISSING", "AGENT_ID_INVALID");
  const assetId = ident("assetId", "ASSET_MISSING", "ASSET_INVALID");
  const recipientId = ident("recipientId", "RECIPIENT_MISSING", "RECIPIENT_INVALID");
  const networkId = ident("networkId", "NETWORK_MISSING", "NETWORK_INVALID");
  const idempotencyKey = ident("idempotencyKey", "IDEMPOTENCY_KEY_INVALID", "IDEMPOTENCY_KEY_INVALID", false);

  let memo: string | undefined;
  if (raw.memo !== undefined) {
    if (typeof raw.memo !== "string" || [...raw.memo].length > MAX_MEMO_LENGTH) {
      reasons.push(reason("MEMO_INVALID", undefined, "memo"));
    } else {
      memo = raw.memo;
    }
  }

  let amountAtomic: bigint | undefined;
  const hasDecimal = raw.amount !== undefined;
  const hasAtomic = raw.amountAtomic !== undefined;
  if (hasDecimal && hasAtomic) {
    reasons.push(reason("AMOUNT_AMBIGUOUS", "provide exactly one of amount or amountAtomic", "amount"));
  } else if (!hasDecimal && !hasAtomic) {
    reasons.push(reason("AMOUNT_MISSING", undefined, "amount"));
  } else {
    const field = hasDecimal ? "amount" : "amountAtomic";
    const asset = assetId !== undefined ? policy.assets.get(assetId) : undefined;
    if (hasAtomic || asset) {
      // In this branch either amountAtomic was supplied or the asset (and its decimals) is known.
      const r = hasAtomic ? parseAtomicAmount(raw.amountAtomic) : parseDecimalAmount(raw.amount, asset!.decimals);
      if (r.ok) amountAtomic = r.value;
      else reasons.push(reason(AMOUNT_CODE[r.code], r.message, field));
    } else if (assetId !== undefined) {
      // A decimal amount cannot be interpreted without the asset's precision.
      reasons.push(reason("ASSET_NOT_ALLOWED", `asset "${assetId}" is not configured in the policy`, "assetId"));
    }
  }

  if (
    reasons.length > 0 ||
    requestId === undefined ||
    agentId === undefined ||
    assetId === undefined ||
    recipientId === undefined ||
    networkId === undefined ||
    amountAtomic === undefined
  ) {
    return { ok: false, reasons };
  }

  const effectiveKey = idempotencyKey ?? `request:${requestId}`;
  const material = {
    requestId,
    agentId,
    assetId,
    amountAtomic,
    recipientId,
    networkId,
    idempotencyKey: effectiveKey,
    memo,
  };
  return {
    ok: true,
    proposal: Object.freeze({
      requestId,
      agentId,
      assetId,
      amountAtomic,
      recipientId,
      networkId,
      idempotencyKey: effectiveKey,
      memo,
      digest: hashCanonical(material),
    }),
  };
}

/** Serialise a normalised proposal for reports/approvals (BigInt → string). */
export function proposalToJson(p: NormalizedProposal): Record<string, string> {
  return JSON.parse(
    canonicalJson({ ...p, amountAtomic: p.amountAtomic.toString(), memo: p.memo }),
  ) as Record<string, string>;
}
