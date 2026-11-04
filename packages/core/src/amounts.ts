/**
 * Exact financial amount handling.
 *
 * All amounts are represented as non-negative BigInt values in the asset's
 * smallest unit ("atomic" units, e.g. 1 USDC = 1_000_000 atomic units when
 * decimals = 6). Floating point numbers are never accepted: a JavaScript
 * `number` amount is rejected outright because it may already have lost
 * precision before it reached us.
 */

/** 10^78 > 2^256, comfortably above any realistic on-chain integer. */
export const MAX_AMOUNT_DIGITS = 78;
export const MAX_ASSET_DECIMALS = 30;

export type AmountErrorCode =
  | "AMOUNT_NOT_STRING"
  | "AMOUNT_EMPTY"
  | "AMOUNT_NEGATIVE"
  | "AMOUNT_FORMAT"
  | "AMOUNT_PRECISION_EXCEEDED"
  | "AMOUNT_TOO_LARGE";

export type AmountResult =
  | { ok: true; value: bigint }
  | { ok: false; code: AmountErrorCode; message: string };

const DECIMAL_RE = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const ATOMIC_RE = /^(0|[1-9][0-9]*)$/;

function fail(code: AmountErrorCode, message: string): AmountResult {
  return { ok: false, code, message };
}

function precheck(input: unknown): AmountResult | string {
  if (typeof input !== "string") {
    return fail(
      "AMOUNT_NOT_STRING",
      `amount must be a string; received ${input === null ? "null" : typeof input}. Numeric JSON amounts are rejected to avoid floating-point precision loss.`,
    );
  }
  if (input.length === 0) return fail("AMOUNT_EMPTY", "amount must not be empty");
  if (input.length > MAX_AMOUNT_DIGITS + MAX_ASSET_DECIMALS + 1) {
    return fail("AMOUNT_TOO_LARGE", `amount string exceeds the maximum supported length`);
  }
  if (input.startsWith("-")) return fail("AMOUNT_NEGATIVE", "amount must not be negative");
  return input;
}

/**
 * Parse a decimal string expressed in whole asset units (e.g. "25.5") into atomic units.
 * Rejects exponents, signs, whitespace, leading zeros, missing integer/fraction parts and
 * any non-zero digit beyond the asset's precision. Trailing zeros beyond the precision are
 * accepted because they do not change the value.
 */
export function parseDecimalAmount(input: unknown, decimals: number): AmountResult {
  assertDecimals(decimals);
  const pre = precheck(input);
  if (typeof pre !== "string") return pre;
  const m = DECIMAL_RE.exec(pre);
  if (!m) {
    return fail(
      "AMOUNT_FORMAT",
      `amount "${truncate(pre)}" is not a plain decimal number (expected digits with an optional fractional part, e.g. "12.50")`,
    );
  }
  const intPart = m[1] ?? "0";
  let frac = m[2] ?? "";
  if (frac.length > decimals) {
    const excess = frac.slice(decimals);
    if (/[^0]/.test(excess)) {
      return fail(
        "AMOUNT_PRECISION_EXCEEDED",
        `amount "${truncate(pre)}" has more than ${decimals} fractional digits supported by the asset`,
      );
    }
    frac = frac.slice(0, decimals);
  }
  if (intPart.length > MAX_AMOUNT_DIGITS) {
    return fail("AMOUNT_TOO_LARGE", "amount exceeds the maximum supported magnitude");
  }
  const atomic = BigInt(intPart + frac.padEnd(decimals, "0"));
  return checkMagnitude(atomic);
}

/** Parse an integer string already expressed in atomic units. */
export function parseAtomicAmount(input: unknown): AmountResult {
  const pre = precheck(input);
  if (typeof pre !== "string") return pre;
  if (!ATOMIC_RE.test(pre)) {
    return fail(
      "AMOUNT_FORMAT",
      `atomic amount "${truncate(pre)}" must be a non-negative integer string without leading zeros`,
    );
  }
  if (pre.length > MAX_AMOUNT_DIGITS) {
    return fail("AMOUNT_TOO_LARGE", "amount exceeds the maximum supported magnitude");
  }
  return checkMagnitude(BigInt(pre));
}

function checkMagnitude(value: bigint): AmountResult {
  if (value.toString().length > MAX_AMOUNT_DIGITS) {
    return fail("AMOUNT_TOO_LARGE", "amount exceeds the maximum supported magnitude");
  }
  return { ok: true, value };
}

/** Format atomic units as a canonical decimal string (no trailing fractional zeros). */
export function formatAtomic(atomic: bigint, decimals: number): string {
  assertDecimals(decimals);
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const s = abs.toString().padStart(decimals + 1, "0");
  const int = decimals === 0 ? s : s.slice(0, -decimals);
  const frac = decimals === 0 ? "" : s.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_ASSET_DECIMALS) {
    throw new RangeError(`asset decimals must be an integer between 0 and ${MAX_ASSET_DECIMALS}`);
  }
}

function truncate(s: string): string {
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}
