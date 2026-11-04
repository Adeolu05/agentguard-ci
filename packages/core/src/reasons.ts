/**
 * Stable reason codes. These are part of the public contract: scenarios, CI
 * automation and dashboards match on them. Never rename a code; add new ones.
 */
export const REASONS = {
  // ── validation: the proposal itself is malformed ──────────────────────────
  PROPOSAL_MALFORMED: { category: "validation", blocking: true, summary: "Proposal is not a plain JSON object" },
  PROPOSAL_TOO_LARGE: { category: "validation", blocking: true, summary: "Proposal exceeds the maximum serialised size" },
  PROPOSAL_UNKNOWN_FIELD: { category: "validation", blocking: true, summary: "Proposal contains an unsupported field" },
  REQUEST_ID_MISSING: { category: "validation", blocking: true, summary: "requestId is missing" },
  REQUEST_ID_INVALID: { category: "validation", blocking: true, summary: "requestId is not a valid identifier" },
  AGENT_ID_MISSING: { category: "validation", blocking: true, summary: "agentId is missing" },
  AGENT_ID_INVALID: { category: "validation", blocking: true, summary: "agentId is not a valid identifier" },
  ASSET_MISSING: { category: "validation", blocking: true, summary: "assetId is missing" },
  ASSET_INVALID: { category: "validation", blocking: true, summary: "assetId is not a valid identifier" },
  RECIPIENT_MISSING: { category: "validation", blocking: true, summary: "recipientId is missing" },
  RECIPIENT_INVALID: { category: "validation", blocking: true, summary: "recipientId is not a valid identifier" },
  NETWORK_MISSING: { category: "validation", blocking: true, summary: "networkId is missing" },
  NETWORK_INVALID: { category: "validation", blocking: true, summary: "networkId is not a valid identifier" },
  AMOUNT_MISSING: { category: "validation", blocking: true, summary: "Neither amount nor amountAtomic was provided" },
  AMOUNT_AMBIGUOUS: { category: "validation", blocking: true, summary: "Both amount and amountAtomic were provided" },
  AMOUNT_INVALID: { category: "validation", blocking: true, summary: "Amount is not a valid non-negative decimal string" },
  AMOUNT_NEGATIVE: { category: "validation", blocking: true, summary: "Amount is negative" },
  AMOUNT_PRECISION_EXCEEDED: { category: "validation", blocking: true, summary: "Amount has more decimal places than the asset supports" },
  AMOUNT_TOO_LARGE: { category: "validation", blocking: true, summary: "Amount exceeds the supported magnitude" },
  AMOUNT_ZERO: { category: "validation", blocking: true, summary: "Zero-amount transactions are not permitted by policy" },
  IDEMPOTENCY_KEY_INVALID: { category: "validation", blocking: true, summary: "idempotencyKey is not a valid identifier" },
  MEMO_INVALID: { category: "validation", blocking: true, summary: "memo must be a string of at most 256 characters" },
  ADAPTER_VALIDATION_FAILED: { category: "validation", blocking: true, summary: "An integration adapter rejected the proposal" },

  // ── policy: the proposal is well-formed but violates a rule ───────────────
  AGENT_NOT_RECOGNISED: { category: "policy", blocking: true, summary: "agentId does not match the policy's agent" },
  ASSET_NOT_ALLOWED: { category: "policy", blocking: true, summary: "Asset is not configured in the policy" },
  NETWORK_NOT_ALLOWED: { category: "policy", blocking: true, summary: "Network is not on the allowlist" },
  RECIPIENT_NOT_ALLOWED: { category: "policy", blocking: true, summary: "Recipient is not on the allowlist" },
  AMOUNT_EXCEEDS_TRANSACTION_LIMIT: { category: "policy", blocking: true, summary: "Amount exceeds max_transaction_amount" },
  DAILY_SPEND_LIMIT_EXCEEDED: { category: "policy", blocking: true, summary: "Transaction would exceed max_daily_spend" },
  DAILY_COUNT_LIMIT_EXCEEDED: { category: "policy", blocking: true, summary: "Transaction would exceed max_transaction_count_per_day" },

  // ── approval ──────────────────────────────────────────────────────────────
  APPROVAL_REQUIRED_AMOUNT: { category: "approval", blocking: false, summary: "Amount is above the human-approval threshold" },
  APPROVAL_REQUIRED_UNKNOWN_RECIPIENT: { category: "approval", blocking: false, summary: "Recipient is not on the allowlist and requires approval" },
  APPROVAL_VERIFIED: { category: "approval", blocking: false, summary: "A valid approval bound to this exact proposal was presented" },
  APPROVAL_MALFORMED: { category: "approval", blocking: true, summary: "Approval grant is malformed" },
  APPROVAL_INVALID_SIGNATURE: { category: "approval", blocking: true, summary: "Approval signature does not verify" },
  APPROVAL_PROPOSAL_MISMATCH: { category: "approval", blocking: true, summary: "Approval was issued for a different proposal" },
  APPROVAL_POLICY_MISMATCH: { category: "approval", blocking: true, summary: "Approval was issued under a different policy version" },
  APPROVAL_EXPIRED: { category: "approval", blocking: true, summary: "Approval has expired" },
  APPROVAL_NOT_YET_VALID: { category: "approval", blocking: true, summary: "Approval issue time is in the future" },
  APPROVAL_LIFETIME_EXCEEDED: { category: "approval", blocking: true, summary: "Approval lifetime exceeds approval.max_age_seconds" },
  APPROVAL_ALREADY_USED: { category: "approval", blocking: true, summary: "Approval has already been consumed" },
  APPROVAL_VERIFICATION_UNAVAILABLE: { category: "infrastructure", blocking: true, summary: "No approval verification key is configured" },

  // ── state ─────────────────────────────────────────────────────────────────
  IDEMPOTENT_REPLAY: { category: "state", blocking: false, summary: "Duplicate request: the existing reservation was returned and nothing new was recorded" },
  IDEMPOTENCY_KEY_CONFLICT: { category: "state", blocking: true, summary: "Idempotency key was already used for a different proposal" },
  IDEMPOTENCY_KEY_FINALISED: { category: "state", blocking: true, summary: "Idempotency key belongs to a failed or cancelled reservation; use a new key" },
  STALE_POLICY_VERSION: { category: "state", blocking: true, summary: "Reservation was authorised under a different policy version" },
  RESERVATION_NOT_FOUND: { category: "state", blocking: true, summary: "Reservation does not exist" },
  INVALID_STATE_TRANSITION: { category: "state", blocking: true, summary: "Requested lifecycle transition is not permitted" },

  // ── infrastructure: evaluation could not complete safely (fail closed) ────
  LEDGER_UNAVAILABLE: { category: "infrastructure", blocking: true, summary: "Ledger state could not be read; failing closed" },
  EVALUATION_ERROR: { category: "infrastructure", blocking: true, summary: "Unexpected evaluation error; failing closed" },
} as const satisfies Record<string, { category: ReasonCategory; blocking: boolean; summary: string }>;

export type ReasonCategory = "validation" | "policy" | "approval" | "state" | "infrastructure";
export type ReasonCode = keyof typeof REASONS;

export interface Reason {
  code: ReasonCode;
  category: ReasonCategory;
  /** Whether this reason on its own forces a BLOCK decision. */
  blocking: boolean;
  message: string;
  field?: string;
}

export function reason(code: ReasonCode, message?: string, field?: string): Reason {
  const def = REASONS[code];
  return {
    code,
    category: def.category,
    blocking: def.blocking,
    message: message ?? def.summary,
    ...(field !== undefined ? { field } : {}),
  };
}

export function isReasonCode(value: string): value is ReasonCode {
  return Object.hasOwn(REASONS, value);
}
