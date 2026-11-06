import { reason, type Policy, type ProposalValidator, type Reason } from "@drainproof/core";

/**
 * NEAR account ID syntax (protocol rules):
 *  - 2 to 64 characters;
 *  - lowercase letters, digits and the separators `-`, `_`, `.`;
 *  - separators cannot be adjacent, leading or trailing; `.` separates account parts.
 * Implicit accounts (64 lowercase hex characters) and ETH-implicit accounts
 * (`0x` + 40 lowercase hex characters) also satisfy this grammar.
 */
const ACCOUNT_ID_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export const NEAR_NETWORKS = { "near-testnet": "testnet", "near-mainnet": "mainnet" } as const;
export type NearNetworkId = keyof typeof NEAR_NETWORKS;

export type AccountIdCheck = { ok: true } | { ok: false; message: string };

export function checkNearAccountId(id: string): AccountIdCheck {
  if (id.length < 2 || id.length > 64) {
    return { ok: false, message: `NEAR account IDs must be 2-64 characters (got ${id.length})` };
  }
  if (!ACCOUNT_ID_RE.test(id)) {
    return {
      ok: false,
      message: `"${id}" is not a valid NEAR account ID (lowercase a-z, 0-9 and non-adjacent "-", "_", "." separators only)`,
    };
  }
  return { ok: true };
}

export function isImplicitAccountId(id: string): boolean {
  return /^[0-9a-f]{64}$/.test(id) || /^0x[0-9a-f]{40}$/.test(id);
}

/**
 * Detect the most common cross-network mistake: a named account under the other
 * network's top-level registrar (`*.near` on testnet, `*.testnet` on mainnet).
 */
export function checkAccountNetwork(id: string, networkId: NearNetworkId): AccountIdCheck {
  if (isImplicitAccountId(id)) return { ok: true };
  if (networkId === "near-testnet" && (id === "near" || id.endsWith(".near"))) {
    return { ok: false, message: `"${id}" is a mainnet (.near) account but the proposal targets near-testnet` };
  }
  if (networkId === "near-mainnet" && (id === "testnet" || id.endsWith(".testnet"))) {
    return { ok: false, message: `"${id}" is a testnet (.testnet) account but the proposal targets near-mainnet` };
  }
  return { ok: true };
}

/**
 * Stricter than checkAccountNetwork, for scripts that sign on testnet: a named account
 * must be a `.testnet` account; implicit accounts (64 hex characters, or `0x` plus 40)
 * exist on every network and are accepted.
 */
export function checkTestnetAccountId(id: string): AccountIdCheck {
  const syntax = checkNearAccountId(id);
  if (!syntax.ok) return syntax;
  if (isImplicitAccountId(id) || id.endsWith(".testnet")) return { ok: true };
  return { ok: false, message: `"${id}" is not a testnet account (expected a name ending in .testnet)` };
}

/**
 * True if `child` is a direct sub-account of `parent` (for example `vault.alice.testnet`
 * under `alice.testnet`), which is the only kind of account `parent` can create itself.
 */
export function checkDirectSubAccount(child: string, parent: string): AccountIdCheck {
  const syntax = checkNearAccountId(child);
  if (!syntax.ok) return syntax;
  const suffix = `.${parent}`;
  if (!child.endsWith(suffix) || child.length === suffix.length || child.slice(0, -suffix.length).includes(".")) {
    return { ok: false, message: `"${child}" is not a direct sub-account of "${parent}" (expected <name>.${parent})` };
  }
  return { ok: true };
}

/**
 * Engine validator: for proposals on a NEAR network, the recipient must be a
 * syntactically valid NEAR account ID for that network. It only adds reasons; the
 * engine's own allowlist and limit rules still apply.
 */
export function nearAccountIdValidator(): ProposalValidator {
  return {
    name: "near-account-id",
    validate(p, _policy: Policy): Reason[] {
      if (!Object.hasOwn(NEAR_NETWORKS, p.networkId)) return [];
      const syntax = checkNearAccountId(p.recipientId);
      if (!syntax.ok) return [reason("ADAPTER_VALIDATION_FAILED", `near: ${syntax.message}`, "recipientId")];
      const net = checkAccountNetwork(p.recipientId, p.networkId as NearNetworkId);
      if (!net.ok) return [reason("ADAPTER_VALIDATION_FAILED", `near: ${net.message}`, "recipientId")];
      return [];
    },
  };
}
