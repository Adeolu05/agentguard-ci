// Pushes a YAML policy to the vault with `set_policy`, on NEAR TESTNET only, so the policy
// the CI suite tests and the policy the vault enforces come from the same file.
//
//   node push-policy.mjs [policy.yaml]           dry run: prints the exact on-chain arguments
//   node push-policy.mjs [policy.yaml] --send    sends them, with these variables:
//     AGENTGUARD_NEAR_EXECUTION=testnet
//     NEAR_TESTNET_ACCOUNT_ID=<owner>.testnet    the vault's owner
//     NEAR_TESTNET_PRIVATE_KEY=ed25519:...       the owner's full-access key (owner calls attach 1 yoctoNEAR)
//     AGENTGUARD_VAULT_ACCOUNT_ID=vault.<owner>.testnet
//
// A policy that cannot be represented exactly on-chain (another asset, another network,
// recipients that are not testnet accounts, values out of range) is refused, never rounded.
import { isDeepStrictEqual } from "node:util";
import { actions } from "near-api-js";
import { loadVaultPolicy } from "./lib/policy.mjs";
import { Refusal, connectTestnet, printOutcome, runScript, send, testnetAccountFromEnv, view } from "./lib/testnet.mjs";

const TGAS = 10n ** 12n;

await runScript(async () => {
  const args = process.argv.slice(2);
  const sendIt = args.includes("--send");
  const policyFile = args.find((a) => !a.startsWith("--"));
  const { vaultPolicy } = await loadVaultPolicy(policyFile);
  console.log(`set_policy arguments (exact):\n${JSON.stringify({ policy: vaultPolicy }, null, 2)}`);
  if (!sendIt) {
    console.log("\nDry run: nothing was signed or sent. Add --send to push it to testnet.");
    return;
  }

  const vaultId = testnetAccountFromEnv("AGENTGUARD_VAULT_ACCOUNT_ID");
  const owner = await connectTestnet();
  const config = await view(owner.provider, vaultId, "get_config");
  if (config.owner_id !== owner.signerId) throw new Refusal(`the vault's owner is ${config.owner_id}, not ${owner.signerId}`);
  if (isDeepStrictEqual(await view(owner.provider, vaultId, "get_policy"), vaultPolicy)) {
    console.log("\nThe vault already has exactly this policy. Nothing was sent.");
    return;
  }

  const r = await send(owner.account, vaultId, [actions.functionCall("set_policy", { policy: vaultPolicy }, 50n * TGAS, 1n)]);
  printOutcome("\nset_policy", r);
  if (r.failure) process.exit(1);
  const installed = isDeepStrictEqual(await view(owner.provider, vaultId, "get_policy"), vaultPolicy);
  console.log(installed ? `On-chain policy now matches (hash ${vaultPolicy.policy_hash}).` : "On-chain policy DOES NOT MATCH.");
  if (!installed) process.exit(1);
});
