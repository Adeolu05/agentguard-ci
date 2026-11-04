import { createHash, randomUUID } from "node:crypto";

/**
 * Deterministic JSON serialisation: object keys are sorted, `undefined` members are
 * omitted, BigInt values are serialised as decimal strings. Non-finite numbers,
 * functions and symbols are rejected so that two semantically different values can
 * never hash identically by accident.
 */
export function canonicalJson(value: unknown): string {
  return serialise(value, new Set());
}

function serialise(value: unknown, seen: Set<unknown>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return JSON.stringify(value.toString());
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (seen.has(value)) throw new TypeError("canonicalJson: circular structure");
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((v) => serialise(v === undefined ? null : v, seen)).join(",")}]`;
        }
        if (value instanceof Set) {
          return serialise([...value].sort(), seen);
        }
        if (value instanceof Map) {
          return serialise(Object.fromEntries([...value.entries()]), seen);
        }
        const entries = Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialise(v, seen)}`).join(",")}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hashCanonical(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
