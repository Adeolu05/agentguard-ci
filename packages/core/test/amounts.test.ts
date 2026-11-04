import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatAtomic, parseAtomicAmount, parseDecimalAmount } from "../src/index.js";

describe("parseDecimalAmount", () => {
  it.each([
    ["25", 6, 25_000_000n],
    ["0.000001", 6, 1n],
    ["25.000001", 6, 25_000_001n],
    ["1.50", 2, 150n],
    ["1.5000", 2, 150n], // trailing zeros beyond precision do not change the value
    ["0", 6, 0n],
    ["7", 0, 7n],
    ["1", 24, 10n ** 24n],
  ])("parses %s with %i decimals", (input, decimals, expected) => {
    expect(parseDecimalAmount(input, decimals)).toEqual({ ok: true, value: expected });
  });

  it.each([
    [25, "AMOUNT_NOT_STRING"],
    [25.5, "AMOUNT_NOT_STRING"],
    [null, "AMOUNT_NOT_STRING"],
    ["", "AMOUNT_EMPTY"],
    ["-5", "AMOUNT_NEGATIVE"],
    ["+5", "AMOUNT_FORMAT"],
    ["1e3", "AMOUNT_FORMAT"],
    [" 5", "AMOUNT_FORMAT"],
    ["5 ", "AMOUNT_FORMAT"],
    ["05", "AMOUNT_FORMAT"],
    [".5", "AMOUNT_FORMAT"],
    ["5.", "AMOUNT_FORMAT"],
    ["5,00", "AMOUNT_FORMAT"],
    ["0x10", "AMOUNT_FORMAT"],
    ["NaN", "AMOUNT_FORMAT"],
    ["Infinity", "AMOUNT_FORMAT"],
    ["٥", "AMOUNT_FORMAT"], // non-ASCII digit
    ["1.0000001", "AMOUNT_PRECISION_EXCEEDED"],
    ["9".repeat(200), "AMOUNT_TOO_LARGE"],
  ])("rejects %j with %s", (input, code) => {
    const r = parseDecimalAmount(input, 6);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });

  it("rejects invalid decimals configuration", () => {
    expect(() => parseDecimalAmount("1", -1)).toThrow(RangeError);
    expect(() => parseDecimalAmount("1", 1.5)).toThrow(RangeError);
  });

  it("round-trips through formatAtomic (property)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 40n }), fc.integer({ min: 0, max: 24 }), (atomic, decimals) => {
        const text = formatAtomic(atomic, decimals);
        expect(parseDecimalAmount(text, decimals)).toEqual({ ok: true, value: atomic });
      }),
    );
  });

  it("never yields a value for non-canonical strings (property)", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = parseDecimalAmount(s, 6);
        if (r.ok) {
          expect(s).toMatch(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
          expect(r.value >= 0n).toBe(true);
        }
      }),
    );
  });
});

describe("parseAtomicAmount", () => {
  it("accepts integer strings", () => {
    expect(parseAtomicAmount("25000000")).toEqual({ ok: true, value: 25_000_000n });
  });
  it.each(["1.5", "-1", "01", "", "1e6"])("rejects %j", (s) => {
    expect(parseAtomicAmount(s).ok).toBe(false);
  });
  it("rejects numbers even when integral", () => {
    expect(parseAtomicAmount(1).ok).toBe(false);
  });
});

describe("formatAtomic", () => {
  it("formats canonical decimals", () => {
    expect(formatAtomic(25_000_000n, 6)).toBe("25");
    expect(formatAtomic(25_000_001n, 6)).toBe("25.000001");
    expect(formatAtomic(1n, 6)).toBe("0.000001");
    expect(formatAtomic(7n, 0)).toBe("7");
  });
});
