import type { Policy } from "@drainproof/core";
import { checkAccountNetwork, checkNearAccountId, type NearNetworkId } from "./account-id.js";

/** Mirrors `MAX_RECIPIENTS` in contracts/vault/src/types.rs. */
export const VAULT_MAX_RECIPIENTS = 100;
const U128_MAX = (1n << 128n) - 1n;
const U32_MAX = 2 ** 32 - 1;

/** The contract's `VaultPolicy`, as JSON call arguments. Amounts are yoctoNEAR strings. */
export interface VaultPolicyJson {
  max_transaction: string;
  max_daily_spend: string;
  max_daily_count: number;
  approval_required_above: string | null;
  recipient_mode: "allowlist" | "allowlist_or_approval";
  allowed_recipients: string[];
  daily_window_utc_offset_minutes: number;
  allow_zero_amount: boolean;
  approval_ttl_seconds: number;
  policy_hash: string;
}

export interface VaultPolicyOptions {
  /**
   * The asset the vault's unit stands for. A real vault holds native NEAR (24 decimals,
   * the default). The sandbox scenario target uses the scenario policy's own asset, so
   * limits and amounts keep their exact atomic values.
   */
  asset?: { id: string; decimals: number };
  /** The network the vault is deployed on. Default `near-testnet`. */
  networkId?: NearNetworkId;
}

export type VaultPolicyResult = { ok: true; policy: VaultPolicyJson } | { ok: false; issues: string[] };

/**
 * Converts a Drainproof policy into the vault's on-chain policy, or explains why it
 * cannot be represented exactly. Nothing is rounded, dropped or defaulted silently:
 * anything the vault cannot enforce exactly is an issue.
 */
export function vaultPolicyFromPolicy(policy: Policy, options: VaultPolicyOptions = {}): VaultPolicyResult {
  const asset = options.asset ?? { id: "NEAR", decimals: 24 };
  const networkId = options.networkId ?? "near-testnet";
  const issues: string[] = [];

  const assets = [...policy.assets.values()];
  if (assets.length !== 1) {
    issues.push(`assets: the vault holds exactly one asset, but the policy configures ${assets.length}`);
  }
  const a = assets[0];
  if (a && (a.id !== asset.id || a.decimals !== asset.decimals)) {
    issues.push(`assets: the vault's asset is ${asset.id} with ${asset.decimals} decimals, but the policy's is ${a.id} with ${a.decimals}`);
  }
  for (const [name, value] of [
    ["max_transaction_amount", a?.maxTransactionAtomic],
    ["max_daily_spend", a?.maxDailySpendAtomic],
    ["approval_required_above", a?.approvalRequiredAboveAtomic ?? null],
  ] as const) {
    if (typeof value === "bigint" && value > U128_MAX) issues.push(`assets[0].${name}: does not fit in the contract's u128`);
  }
  if (policy.maxTransactionCountPerDay > U32_MAX) {
    issues.push("limits.max_transaction_count_per_day: does not fit in the contract's u32");
  }

  const networks = [...policy.allowedNetworks];
  if (networks.length !== 1 || networks[0] !== networkId) {
    issues.push(`networks.allowed: must be exactly [${networkId}] for a vault on that network, but is [${networks.join(", ")}]`);
  }

  const recipients = [...policy.allowedRecipients];
  if (recipients.length > VAULT_MAX_RECIPIENTS) {
    issues.push(`recipients.allowed: the vault accepts at most ${VAULT_MAX_RECIPIENTS} recipients, but the policy lists ${recipients.length}`);
  }
  for (const id of recipients) {
    const syntax = checkNearAccountId(id);
    const network = syntax.ok ? checkAccountNetwork(id, networkId) : syntax;
    if (!network.ok) issues.push(`recipients.allowed: ${network.message}`);
  }

  if (issues.length > 0 || !a) return { ok: false, issues };
  return {
    ok: true,
    policy: {
      max_transaction: a.maxTransactionAtomic.toString(),
      max_daily_spend: a.maxDailySpendAtomic.toString(),
      max_daily_count: policy.maxTransactionCountPerDay,
      approval_required_above: a.approvalRequiredAboveAtomic === null ? null : a.approvalRequiredAboveAtomic.toString(),
      recipient_mode: policy.recipientMode,
      allowed_recipients: recipients,
      daily_window_utc_offset_minutes: policy.windowOffsetMinutes,
      allow_zero_amount: policy.allowZeroAmount,
      approval_ttl_seconds: policy.approvalMaxAgeSeconds,
      policy_hash: policy.hash,
    },
  };
}
