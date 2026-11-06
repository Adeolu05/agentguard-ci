// Optional: send the model's payment proposals to the AgentGuard Vault contract, signed with
// the agent's function-call key. Default is a local NEAR sandbox (needs `pnpm build:vault`);
// with AGENTGUARD_NEAR_EXECUTION=testnet it uses a vault you deployed on testnet.
//
// The vault holds native NEAR only, while the task is priced in USDC. This demo converts at a
// fixed, made-up rate of 1 USDC = 0.01 NEAR, and maps the policy's recipient names to NEAR
// accounts with a fixed address book (configured by the operator, never by the model). Any
// other recipient string is sent to the vault unchanged.
import { formatAtomic, parseDecimalAmount } from "@agentguard/core";

const NEAR_VAULT = new URL("../../near-vault/", import.meta.url);
const TGAS = 10n ** 12n;
/** 1 micro-USDC (10^-6) = 10^-8 NEAR = 10^16 yoctoNEAR, i.e. 1 USDC = 0.01 NEAR. */
const YOCTO_PER_MICRO_USDC = 10n ** 16n;
export const RATE_LABEL = "demo rate: 1 USDC = 0.01 NEAR";

export function usdcToYocto(amount) {
  const parsed = parseDecimalAmount(amount, 6);
  return parsed.ok ? parsed.value * YOCTO_PER_MICRO_USDC : undefined;
}

function printDecision(r, out) {
  if (r.hash) out(`    vault tx:    ${r.hash} (as returned by the network)${r.explorer ? `, ${r.explorer}` : ""}`);
  if (r.failure) out(`    vault:       the call failed: ${r.failure}`);
  const d = r.value;
  if (d) out(`    vault:       ${d.decision}${d.reason_codes.length ? ` (${d.reason_codes.join(", ")})` : ""}, status ${d.status ?? "not stored"}`);
  for (const e of r.events ?? []) out(`    on-chain event: EVENT_JSON:${JSON.stringify(e)}`);
  const settled = (r.events ?? []).find((e) => e.event === "payment_settled");
  return { decision: d?.decision ?? "FAILED", paid: d?.decision === "ALLOW" && settled?.data?.[0]?.status === "PAID" };
}

function makeRequester({ addressBook, send, label }) {
  return {
    label,
    async request({ requestId, recipient, amount, memo, out }) {
      const yocto = usdcToYocto(amount);
      if (yocto === undefined || typeof recipient !== "string") {
        out(`    vault:       not sent: ${JSON.stringify(amount)} USDC to ${JSON.stringify(recipient)} cannot be expressed as a vault call`);
        return { decision: "NOT_SENT", paid: false };
      }
      const recipientId = addressBook[recipient] ?? recipient;
      out(`    vault call:  request_payment ${formatAtomic(yocto, 24)} NEAR → ${recipientId} (${RATE_LABEL})`);
      const args = { request_id: requestId, recipient_id: recipientId, amount: yocto.toString(), ...(memo === undefined ? {} : { memo }) };
      return printDecision(await send(args), out);
    },
  };
}

/** A fresh vault on a local NEAR sandbox, with the policy of examples/near-vault/policy.yaml. */
export async function sandboxVault() {
  const { startVault } = await import(new URL("lib/sandbox.mjs", NEAR_VAULT));
  const { loadVaultPolicy } = await import(new URL("lib/policy.mjs", NEAR_VAULT));
  const { vaultPolicy } = await loadVaultPolicy();
  const v = await startVault({ policy: vaultPolicy, recipients: vaultPolicy.allowed_recipients });
  const addressBook = { "data-provider-example": "data-provider-example.testnet", "merchant-example": "merchant-example.testnet" };
  return {
    ...makeRequester({ addressBook, label: "local NEAR sandbox, nothing leaves this machine", send: (args) => v.requestPayment(args, { gas: 50n * TGAS }) }),
    describe: `vault ${v.ids.vault} on a local NEAR sandbox; the agent signs with a function-call key limited to request_payment; allowlist ${JSON.stringify(vaultPolicy.allowed_recipients)}`,
    stop: () => v.stop(),
  };
}

/** Your vault on NEAR testnet (opt-in). Every check of examples/near-vault/lib/testnet.mjs applies. */
export async function testnetVault(env = process.env) {
  const t = await import(new URL("lib/testnet.mjs", NEAR_VAULT));
  const { testnetExplorerTxUrl } = await import("@agentguard/near");
  const { actions } = await import(new URL("lib/sandbox.mjs", NEAR_VAULT)); // re-exports near-api-js actions
  const vaultId = t.testnetAccountFromEnv("AGENTGUARD_VAULT_ACCOUNT_ID", env);
  const agentId = t.testnetAccountFromEnv("AGENTGUARD_AGENT_ACCOUNT_ID", env);
  const agentKey = t.requireEnv("AGENTGUARD_AGENT_PRIVATE_KEY", env);
  const dataProvider = t.testnetAccountFromEnv("AGENTGUARD_LLM_DATA_PROVIDER", env);
  const agent = await t.connectTestnet({ ...env, NEAR_TESTNET_ACCOUNT_ID: agentId, NEAR_TESTNET_PRIVATE_KEY: agentKey });
  const policy = await t.view(agent.provider, vaultId, "get_policy");
  if (!policy.allowed_recipients.includes(dataProvider)) throw new t.Refusal(`AGENTGUARD_LLM_DATA_PROVIDER ${dataProvider} is not in the vault's allowlist`);
  const run = Date.now();
  return {
    ...makeRequester({
      addressBook: { "data-provider-example": dataProvider },
      label: `NEAR testnet vault ${vaultId}`,
      send: async (args) => {
        const r = await t.send(agent.account, vaultId, [actions.functionCall("request_payment", { ...args, request_id: `${args.request_id}-${run}` }, 50n * TGAS, 0n)]);
        return { ...r, explorer: testnetExplorerTxUrl(r.hash) };
      },
    }),
    describe: `vault ${vaultId} on NEAR testnet; agent ${agentId} signs with its function-call key`,
    stop: async () => {},
  };
}
