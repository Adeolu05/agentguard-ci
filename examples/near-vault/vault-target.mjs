// The Drainproof Vault as a scenario target: the built-in security scenarios run against
// the real contract on a local NEAR sandbox (never testnet or mainnet).
//
// Each scenario gets a fresh sandbox and vault, started on its first proposal. Every
// proposal is a real `request_payment` transaction signed with the agent's function-call
// key, and the decision, reason codes and replay flag come from the contract's return
// value. Scenarios the vault has no equivalent for are skipped with the reason (see
// unsupported() below and docs/vault-design.md).
//
// Units: a real vault holds native NEAR. The scenario policy uses USDC with 6 decimals, so
// this target maps the policy's single asset onto the vault's integer unit: limits and
// amounts keep their exact atomic values (5 USDC = 5000000 units), which is all the
// contract compares.
import { dailyWindow, parseDecimalAmount } from "@drainproof/core";
import { checkNearAccountId, vaultPolicyFromPolicy } from "@drainproof/near";
import { Account, KeyPair, NEAR, actions, startVault } from "./lib/sandbox.mjs";

const NETWORK = "near-testnet";
const PROPOSAL_FIELDS = new Set(["requestId", "agentId", "assetId", "networkId", "amount", "amountAtomic", "recipientId", "idempotencyKey", "memo"]);
const IMPOSTOR = "impostor.sandbox";
const KEY_POOL_SIZE = 12;
const U128_MAX = (1n << 128n) - 1n;
const U32_MAX = 2 ** 32 - 1;
const BOUNDARY_GUARD_MS = 60_000;

/** For malformed input: the contract's typed arguments cannot even express it. */
const typed = (why) => ({
  ok: false,
  why: `${why}. The vault takes typed arguments, so this input is checked by the off-chain engine instead`,
});

/** Maps a scenario proposal onto `request_payment` arguments, or says why it cannot. */
function toVaultCall(p, asset) {
  if (typeof p !== "object" || p === null || Array.isArray(p)) return typed("the proposal is not an object");
  const extra = Object.keys(p).filter((k) => !PROPOSAL_FIELDS.has(k));
  if (extra.length > 0) return typed(`it has fields a vault call does not take (${extra.join(", ")})`);
  for (const f of ["requestId", "agentId", "recipientId"]) {
    if (typeof p[f] !== "string") return typed(`${f} is missing or not a string`);
  }
  for (const f of ["idempotencyKey", "memo"]) {
    if (p[f] !== undefined && typeof p[f] !== "string") return typed(`${f} is not a string`);
  }
  if (p.assetId !== asset.id) {
    return { ok: false, why: `it uses asset ${JSON.stringify(p.assetId)}, but a vault holds one asset, fixed at deployment` };
  }
  if (p.networkId !== NETWORK) {
    return { ok: false, why: `it targets network ${JSON.stringify(p.networkId)}, but a vault runs on one network, fixed at deployment` };
  }
  if (!checkNearAccountId(p.recipientId).ok) {
    return {
      ok: false,
      why: `its recipient ${JSON.stringify(p.recipientId)} is not a valid NEAR account ID. The scenario tests how the engine compares arbitrary identifier strings and expects reason codes for that; the vault blocks every such string as RECIPIENT_INVALID, which the vault's own tests check`,
    };
  }
  let atomic;
  if (p.amount !== undefined && p.amountAtomic !== undefined) return typed("it gives both amount and amountAtomic");
  if (p.amount !== undefined) {
    const parsed = parseDecimalAmount(p.amount, asset.decimals);
    if (!parsed.ok) return typed(`its amount cannot be an exact integer amount of ${asset.id} (${parsed.code})`);
    atomic = parsed.value;
  } else if (typeof p.amountAtomic === "string" && /^[0-9]+$/.test(p.amountAtomic)) {
    atomic = BigInt(p.amountAtomic);
  } else {
    return typed("it has no exact amount");
  }
  if (atomic > U128_MAX) return typed("its amount does not fit the contract's u128");
  return {
    ok: true,
    agentId: p.agentId,
    args: {
      request_id: p.requestId,
      recipient_id: p.recipientId,
      amount: atomic.toString(),
      ...(p.idempotencyKey !== undefined ? { idempotency_key: p.idempotencyKey } : {}),
      ...(p.memo !== undefined ? { memo: p.memo } : {}),
    },
  };
}

export function createTarget({ policy, clock, seed }) {
  const asset = [...policy.assets.values()][0];
  const converted = asset
    ? vaultPolicyFromPolicy(policy, { asset: { id: asset.id, decimals: asset.decimals }, networkId: NETWORK })
    : { ok: false, issues: ["the policy has no asset"] };

  let started; // Promise of the running vault, created on the first proposal
  let created = 0; // payments submitted by the scenario's own proposals (seeded history excluded)
  const freeKeys = [];
  const waiting = [];

  const acquire = () => (freeKeys.length > 0 ? Promise.resolve(freeKeys.pop()) : new Promise((resolve) => waiting.push(resolve)));
  const release = (account) => {
    const next = waiting.shift();
    if (next) next(account);
    else freeKeys.push(account);
  };

  async function start() {
    const seedRecipients = seed.map((r) => r.recipientId);
    const recipients = [...new Set([...converted.policy.allowed_recipients, ...seedRecipients])];
    // Seeded history is recreated as real payments made earlier in the same window. Seed
    // amounts can exceed the scenario's own limits (for example 90 USDC already spent
    // today), so they are paid under a permissive seeding policy; the scenario's policy is
    // then installed with an owner set_policy call before the first scenario step.
    const seeding = {
      ...converted.policy,
      max_transaction: U128_MAX.toString(),
      max_daily_spend: U128_MAX.toString(),
      max_daily_count: U32_MAX,
      approval_required_above: null,
      recipient_mode: "allowlist",
      allowed_recipients: recipients,
      policy_hash: "sha256:seeding",
    };
    const vault = await startVault({
      policy: seed.length > 0 ? seeding : converted.policy,
      recipients,
      extraAccounts: [IMPOSTOR],
      agentAllowance: NEAR,
    });
    try {
      // Several function-call keys, so concurrent proposals do not compete for one nonce.
      const keys = Array.from({ length: KEY_POOL_SIZE }, () => KeyPair.fromRandom("ed25519"));
      await vault.agentFullAccess.signAndSendTransaction({
        receiverId: vault.ids.agent,
        actions: keys.map((k) => actions.addFunctionCallAccessKey(k.getPublicKey(), vault.ids.vault, ["request_payment"], NEAR)),
        waitUntil: "FINAL",
      });
      freeKeys.push(...keys.map((k) => new Account(vault.ids.agent, vault.provider, k.toString())));

      if (seed.length > 0) {
        const results = await Promise.all(
          seed.map((r, i) =>
            payAs(vault, { request_id: `seed-${i}`, recipient_id: r.recipientId, amount: r.amountAtomic.toString() }),
          ),
        );
        results.forEach((d, i) => {
          if (d.decision !== "ALLOW") throw new Error(`could not recreate seeded payment ${i}: ${d.decision} ${d.reason_codes.join(", ")}`);
        });
        const installed = await vault.ownerCall("set_policy", { policy: converted.policy });
        if (installed.failure) throw new Error(`could not install the scenario policy: ${installed.failure}`);
      }
      return vault;
    } catch (err) {
      await vault.stop();
      throw err;
    }
  }

  async function payAs(vault, args) {
    const account = await acquire();
    try {
      const r = await vault.call(account, "request_payment", args);
      if (r.failure) throw new Error(`request_payment failed: ${r.failure}`);
      return r.value;
    } finally {
      release(account);
    }
  }

  /** Milliseconds until the vault's current daily window ends, on real time. */
  function msToWindowEnd() {
    return dailyWindow(policy, new Date()).end.getTime() - Date.now();
  }

  return {
    name: "drainproof-vault-sandbox",
    capabilities: { reasonCodes: true, approvals: false, lifecycle: false, ledgerInspection: true, policyReload: false, failureInjection: false },

    unsupported(scenario) {
      if (!converted.ok) return `its policy cannot be represented exactly in the vault (${converted.issues.join("; ")})`;
      if (scenario.steps.some((step) => "advance_time" in step)) {
        return "it moves the clock (advance_time), but the sandbox runs on real block time. The window reset is covered by the contract's unit tests and by a sandbox test that waits for a real window boundary";
      }
      const window = dailyWindow(policy, clock.now());
      for (const r of seed) {
        if (r.status !== "confirmed") return `its seeded history has a ${r.status} payment, which cannot be recreated on-chain`;
        if (r.assetId !== asset.id) return `its seeded history uses asset ${r.assetId}, but a vault holds one asset`;
        const at = Date.parse(r.createdAt);
        if (at < window.start.getTime() || at >= window.end.getTime()) {
          return "its seeded history is dated outside the scenario's current day, which cannot be recreated on-chain";
        }
      }
      for (const [i, step] of scenario.steps.entries()) {
        let proposal = "propose" in step ? step.propose : "concurrent" in step ? step.concurrent.proposal : undefined;
        if (proposal === undefined) continue;
        if ("propose" in step && step.fill) {
          // Same expansion the runner applies before sending the proposal.
          proposal = { ...proposal };
          for (const [field, spec] of Object.entries(step.fill)) proposal[field] = spec.char.repeat(spec.length);
        }
        const call = toVaultCall(proposal, asset);
        if (!call.ok) return `step ${i + 1}: ${call.why}`;
      }
      const usesWindow = seed.length > 0 || scenario.steps.some((step) => "expect_ledger" in step || "concurrent" in step);
      if (usesWindow && msToWindowEnd() < BOUNDARY_GUARD_MS) {
        return "the vault's daily window ends in less than a minute, so the result could depend on timing. Run it again after the boundary";
      }
      return undefined;
    },

    async propose(proposal) {
      started ??= start();
      const vault = await started;
      const call = toVaultCall(proposal, asset);
      if (!call.ok) throw new Error(`proposal cannot be sent to the vault: ${call.why}`);

      if (call.agentId !== policy.agentId) {
        // A different agent: send the same call from another account. Only the configured
        // agent account may request payments, so the contract refuses it.
        const r = await vault.call(vault.fullAccess(IMPOSTOR), "request_payment", call.args);
        if (r.failure && /AGENT_NOT_RECOGNISED/.test(r.failure)) return { decision: "BLOCK", reasonCodes: ["AGENT_NOT_RECOGNISED"] };
        if (r.failure) throw new Error(`request_payment failed: ${r.failure}`);
        return { decision: r.value.decision, reasonCodes: r.value.reason_codes, replay: r.value.replay, handle: r.value.key };
      }

      const d = await payAs(vault, call.args);
      if (d.decision === "ALLOW" && !d.replay) created += 1;
      return { decision: d.decision, reasonCodes: d.reason_codes, replay: d.replay, handle: d.key };
    },

    async ledgerUsage(assetId) {
      if (!started) return { activeAtomic: 0n, activeCount: 0, created: 0 };
      const vault = await started;
      const u = await vault.view("get_usage");
      const current = u.window === u.current_window;
      return {
        activeAtomic: current && assetId === asset.id ? BigInt(u.spent) : 0n,
        activeCount: current ? u.count : 0,
        created,
      };
    },

    async dispose() {
      if (started) await started.then((vault) => vault.stop(), () => undefined);
    },
  };
}
