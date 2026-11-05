// Deploys the AgentGuard Vault to NEAR TESTNET. It refuses any other network.
//
//   AGENTGUARD_NEAR_EXECUTION=testnet
//   NEAR_TESTNET_ACCOUNT_ID=<owner>.testnet            the owner: pays for and controls the vault
//   NEAR_TESTNET_PRIVATE_KEY=ed25519:...               the owner's testnet key
//   AGENTGUARD_VAULT_ACCOUNT_ID=vault.<owner>.testnet  created by this script; must not exist yet
//   AGENTGUARD_AGENT_ACCOUNT_ID=<agent>.testnet        the only account allowed to request payments
//   AGENTGUARD_VAULT_FUNDING=3                         NEAR moved into the vault (optional, default 3)
//   node deploy.mjs [policy.yaml] [--dry-run]
//
// The contract's code needs about 1.9 NEAR of storage stake, so with the default funding
// about 1.1 NEAR remains available for payments (measured in the sandbox; see README).
//
// Two transactions:
//  1. The owner creates the vault account, funds it, and adds the owner's own public key as
//     its full-access key (so the owner can redeploy or clean up; no new key is created).
//  2. The vault account deploys the contract and calls `new` in the same transaction, so
//     nobody can initialise it in between (`new` is private to the vault account).
import { isDeepStrictEqual } from "node:util";
import { checkDirectSubAccount } from "@agentguard/near";
import { actions } from "near-api-js";
import { loadWasm } from "./lib/wasm.mjs";
import { loadVaultPolicy } from "./lib/policy.mjs";
import { Refusal, accountExists, connectTestnet, nearToYocto, printOutcome, runScript, send, testnetAccountFromEnv, view } from "./lib/testnet.mjs";

const TGAS = 10n ** 12n;

await runScript(async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const policyFile = args.find((a) => !a.startsWith("--"));
  const { vaultPolicy } = await loadVaultPolicy(policyFile);

  const ownerId = testnetAccountFromEnv("NEAR_TESTNET_ACCOUNT_ID");
  const vaultId = testnetAccountFromEnv("AGENTGUARD_VAULT_ACCOUNT_ID");
  const agentId = testnetAccountFromEnv("AGENTGUARD_AGENT_ACCOUNT_ID");
  const sub = checkDirectSubAccount(vaultId, ownerId);
  if (!sub.ok) throw new Refusal(`AGENTGUARD_VAULT_ACCOUNT_ID: ${sub.message}`);
  if (new Set([ownerId, vaultId, agentId]).size !== 3) throw new Refusal("the owner, vault and agent must be three different accounts");
  const funding = nearToYocto(process.env.AGENTGUARD_VAULT_FUNDING || "3", "AGENTGUARD_VAULT_FUNDING");
  const initArgs = { owner_id: ownerId, agent_id: agentId, policy: vaultPolicy };

  console.log(`Vault ${vaultId}: owner ${ownerId}, agent ${agentId}, funding ${funding} yoctoNEAR`);
  console.log(`Initial policy (exact on-chain arguments):\n${JSON.stringify(vaultPolicy, null, 2)}`);
  if (dryRun) {
    console.log("\nDry run: nothing was signed or sent.");
    return;
  }

  let wasm;
  try {
    wasm = await loadWasm();
  } catch (err) {
    throw new Refusal(err.message);
  }

  const owner = await connectTestnet();
  if (owner.signerId !== ownerId) throw new Refusal("NEAR_TESTNET_ACCOUNT_ID changed while running");
  if (await accountExists(owner.provider, vaultId)) {
    throw new Refusal(`${vaultId} already exists. Use push-policy.mjs to change the policy of an existing vault`);
  }
  if (!(await accountExists(owner.provider, agentId))) throw new Refusal(`the agent account ${agentId} does not exist`);

  const created = await send(owner.account, vaultId, [
    actions.createAccount(),
    actions.transfer(funding),
    actions.addFullAccessKey(owner.publicKey),
  ]);
  printOutcome(`\n1. Create and fund ${vaultId}`, created);
  if (created.failure) process.exit(1);

  // The same key now also controls the vault account, so it signs the deployment.
  const vaultEnv = { ...process.env, NEAR_TESTNET_ACCOUNT_ID: vaultId };
  const vault = await connectTestnet(vaultEnv);
  const deployed = await send(vault.account, vaultId, [actions.deployContract(wasm), actions.functionCall("new", initArgs, 100n * TGAS, 0n)]);
  printOutcome(`\n2. Deploy the contract and initialise it`, deployed);
  if (deployed.failure) process.exit(1);

  const config = await view(owner.provider, vaultId, "get_config");
  const onChain = await view(owner.provider, vaultId, "get_policy");
  const same = isDeepStrictEqual(onChain, vaultPolicy);
  console.log(`\nOn-chain config: ${JSON.stringify(config)}`);
  console.log(`On-chain policy ${same ? "matches" : "DOES NOT MATCH"} the YAML policy (hash ${onChain.policy_hash}).`);
  console.log(`Available for payments: ${await view(owner.provider, vaultId, "available_balance")} yoctoNEAR`);
  console.log("\nNext: give the agent its function-call key with add-agent-key.mjs.");
  if (!same) process.exit(1);
});
