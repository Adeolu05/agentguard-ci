import { z } from "zod";
import { parseDecimalAmount, formatAtomic } from "./amounts.js";
import { hashCanonical } from "./canonical.js";
import { parseYamlWithSchema, type ConfigIssue, type ParseResult } from "./yaml-schema.js";

/**
 * Identifiers (agent, asset, recipient, network) are compared byte-for-byte.
 * They must be 1..128 printable ASCII characters with no whitespace. This rejects
 * zero-width characters, homoglyph Unicode and leading/trailing whitespace instead
 * of "normalising" them, which could equate two distinct identities.
 */
export const IDENTIFIER_PATTERN = /^[\x21-\x7e]{1,128}$/;

export const identifierSchema = z
  .string({ error: (iss) => (iss.input === undefined ? "is required" : "must be a string") })
  .regex(IDENTIFIER_PATTERN, "must be 1-128 printable ASCII characters without whitespace");

const amountString = z.string({
  error: (iss) =>
    iss.input === undefined
      ? "is required"
      : `must be a quoted decimal string (e.g. "25"), got ${typeof iss.input}; unquoted numbers are rejected to avoid floating-point ambiguity`,
});

const assetSchema = z.strictObject({
  id: identifierSchema,
  decimals: z.int().min(0).max(30),
  max_transaction_amount: amountString,
  max_daily_spend: amountString,
  /** Transactions strictly greater than this amount require human approval. Omit to disable. */
  approval_required_above: amountString.optional(),
});

const UTC_OFFSET_RE = /^[+-](?:0\d|1[0-4]):[0-5]\d$/;

export const policyDocumentSchema = z.strictObject({
  version: z.literal(1, { error: "only policy schema version 1 is supported" }),
  agent: z.strictObject({
    id: identifierSchema,
    name: z.string().min(1).max(200).optional(),
  }),
  execution: z
    .strictObject({
      mode: z.enum(["simulation", "testnet"]).default("simulation"),
      fail_closed: z
        .literal(true, { error: "fail_closed cannot be disabled; AgentGuard always fails closed" })
        .default(true),
    })
    .default({ mode: "simulation", fail_closed: true }),
  assets: z.array(assetSchema).min(1, "at least one asset must be configured"),
  limits: z.strictObject({
    max_transaction_count_per_day: z.int().min(0).max(1_000_000),
    daily_window_utc_offset: z
      .string()
      .regex(UTC_OFFSET_RE, 'must be a fixed UTC offset such as "+00:00" or "-05:00"')
      .default("+00:00"),
    allow_zero_amount: z.boolean().default(false),
  }),
  recipients: z.strictObject({
    mode: z.enum(["allowlist", "allowlist_or_approval"]),
    allowed: z.array(identifierSchema, {
      error: (iss) =>
        iss.input === undefined
          ? "is required (use [] to explicitly allow no recipients)"
          : "must be a list of recipient identifiers",
    }),
  }),
  networks: z.strictObject({
    allowed: z.array(identifierSchema, {
      error: (iss) => (iss.input === undefined ? "is required" : "must be a list of network identifiers"),
    }),
  }),
  approval: z
    .strictObject({
      max_age_seconds: z.int().min(1).max(7 * 24 * 3600).default(900),
    })
    .default({ max_age_seconds: 900 }),
});

export type PolicyDocument = z.output<typeof policyDocumentSchema>;

export interface AssetPolicy {
  readonly id: string;
  readonly decimals: number;
  readonly maxTransactionAtomic: bigint;
  readonly maxDailySpendAtomic: bigint;
  /** `null` means no amount-based approval threshold. */
  readonly approvalRequiredAboveAtomic: bigint | null;
}

export interface Policy {
  readonly version: 1;
  /** `sha256:<hex>` of the canonical, normalised policy document. */
  readonly hash: string;
  readonly agentId: string;
  readonly agentName: string | undefined;
  readonly executionMode: "simulation" | "testnet";
  readonly assets: ReadonlyMap<string, AssetPolicy>;
  readonly maxTransactionCountPerDay: number;
  /** Offset of the daily accounting window from UTC, in minutes. */
  readonly windowOffsetMinutes: number;
  readonly allowZeroAmount: boolean;
  readonly recipientMode: "allowlist" | "allowlist_or_approval";
  readonly allowedRecipients: ReadonlySet<string>;
  readonly allowedNetworks: ReadonlySet<string>;
  readonly approvalMaxAgeSeconds: number;
  /** The validated document (with defaults applied) the policy was built from. */
  readonly document: PolicyDocument;
}

export interface PolicyLoadSuccess {
  ok: true;
  policy: Policy;
  warnings: ConfigIssue[];
}
export type PolicyLoadResult = PolicyLoadSuccess | { ok: false; issues: ConfigIssue[] };

/** Build a policy from an already-parsed object (e.g. JSON). */
export function policyFromObject(input: unknown, source = "<policy>"): PolicyLoadResult {
  const parsed = policyDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.map(String).join("."),
        message: i.message,
        source,
      })),
    };
  }
  return buildPolicy(parsed.data, source);
}

/** Parse and validate a YAML policy document. */
export function policyFromYaml(text: string, source = "<policy>"): PolicyLoadResult {
  const parsed: ParseResult<PolicyDocument> = parseYamlWithSchema(text, policyDocumentSchema, source);
  if (!parsed.ok) return parsed;
  return buildPolicy(parsed.value, source);
}

function buildPolicy(doc: PolicyDocument, source: string): PolicyLoadResult {
  const issues: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];
  const assets = new Map<string, AssetPolicy>();

  doc.assets.forEach((a, idx) => {
    const at = (field: string) => `assets.${idx}.${field}`;
    if (assets.has(a.id)) {
      issues.push({ path: at("id"), message: `duplicate asset id "${a.id}"`, source });
      return;
    }
    const amount = (field: "max_transaction_amount" | "max_daily_spend" | "approval_required_above") => {
      const raw = a[field];
      if (raw === undefined) return null;
      const r = parseDecimalAmount(raw, a.decimals);
      if (!r.ok) {
        issues.push({ path: at(field), message: r.message, source });
        return null;
      }
      return r.value;
    };
    const maxTx = amount("max_transaction_amount");
    const maxDaily = amount("max_daily_spend");
    const approvalAbove = amount("approval_required_above");
    if (maxTx === null || maxDaily === null) return;
    if (maxDaily < maxTx) {
      warnings.push({
        path: at("max_daily_spend"),
        message: `max_daily_spend (${a.max_daily_spend}) is lower than max_transaction_amount (${a.max_transaction_amount}); the daily limit will be the effective per-transaction cap`,
        source,
      });
    }
    if (approvalAbove !== null && approvalAbove >= maxTx) {
      warnings.push({
        path: at("approval_required_above"),
        message: `approval threshold ${formatAtomic(approvalAbove, a.decimals)} is not below max_transaction_amount; amount-based approval can never trigger`,
        source,
      });
    }
    assets.set(a.id, Object.freeze({
      id: a.id,
      decimals: a.decimals,
      maxTransactionAtomic: maxTx,
      maxDailySpendAtomic: maxDaily,
      approvalRequiredAboveAtomic: approvalAbove,
    }));
  });

  for (const [field, list] of [
    ["recipients.allowed", doc.recipients.allowed],
    ["networks.allowed", doc.networks.allowed],
  ] as const) {
    const dupes = list.filter((v, i) => list.indexOf(v) !== i);
    if (dupes.length > 0) issues.push({ path: field, message: `duplicate entries: ${[...new Set(dupes)].join(", ")}`, source });
  }
  if (doc.recipients.allowed.length === 0) {
    warnings.push({
      path: "recipients.allowed",
      message:
        doc.recipients.mode === "allowlist"
          ? "recipient allowlist is empty: every transaction will be blocked"
          : "recipient allowlist is empty: every transaction will require approval",
      source,
    });
  }
  if (doc.networks.allowed.length === 0) {
    warnings.push({ path: "networks.allowed", message: "network allowlist is empty: every transaction will be blocked", source });
  }
  if (issues.length > 0) return { ok: false, issues };

  const offset = doc.limits.daily_window_utc_offset;
  const sign = offset.startsWith("-") ? -1 : 1;
  const [hh, mm] = offset.slice(1).split(":").map(Number) as [number, number];

  const policy: Policy = Object.freeze({
    version: 1,
    hash: hashCanonical(doc),
    agentId: doc.agent.id,
    agentName: doc.agent.name,
    executionMode: doc.execution.mode,
    assets,
    maxTransactionCountPerDay: doc.limits.max_transaction_count_per_day,
    windowOffsetMinutes: sign * (hh * 60 + mm),
    allowZeroAmount: doc.limits.allow_zero_amount,
    recipientMode: doc.recipients.mode,
    allowedRecipients: new Set(doc.recipients.allowed),
    allowedNetworks: new Set(doc.networks.allowed),
    approvalMaxAgeSeconds: doc.approval.max_age_seconds,
    document: deepFreeze(structuredClone(doc)),
  });
  return { ok: true, policy, warnings };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The daily accounting window containing `at`: a calendar day in the policy's fixed
 * UTC offset, half-open `[start, end)`.
 */
export function dailyWindow(policy: Pick<Policy, "windowOffsetMinutes">, at: Date): { start: Date; end: Date } {
  const offsetMs = policy.windowOffsetMinutes * 60_000;
  const local = at.getTime() + offsetMs;
  const startLocal = Math.floor(local / DAY_MS) * DAY_MS;
  const start = new Date(startLocal - offsetMs);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}
