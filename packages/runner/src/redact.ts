/**
 * Redaction applied to every report before it is serialised or printed.
 *
 * Reports should never contain secrets in the first place (policies and scenarios
 * hold none, and signing keys never enter the runner), so this is defence in depth
 * against a custom target or adapter echoing credentials into results.
 */
export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY =
  /(private[_-]?key|secret|seed[_-]?phrase|mnemonic|password|passphrase|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|bearer|authorization|credential|signing[_-]?key)/i;

const SENSITIVE_VALUES: RegExp[] = [
  // NEAR / generic curve-prefixed private keys (public keys are ~44 base58 chars; private keys are ~88).
  /\b(?:ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{60,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g, // common API key prefix
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
];

export interface RedactOptions {
  /** Exact secret values to remove wherever they appear (e.g. values of secret env vars). */
  secrets?: readonly string[];
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function redactString(s: string, opts: RedactOptions = {}): string {
  let out = s;
  for (const secret of opts.secrets ?? []) {
    if (secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  for (const re of SENSITIVE_VALUES) out = out.replace(re, REDACTED);
  return out;
}

/** Deep-copy `value`, replacing sensitive keys and credential-shaped strings. */
export function redact<T>(value: T, opts: RedactOptions = {}): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redactString(v, opts);
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) {
        out[k] = isSensitiveKey(k) && inner !== undefined && inner !== null ? REDACTED : walk(inner);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** Values of environment variables whose names look secret, for exact-match redaction. */
export function secretsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([k, v]) => v !== undefined && v.length >= 8 && isSensitiveKey(k))
    .map(([, v]) => v as string);
}
