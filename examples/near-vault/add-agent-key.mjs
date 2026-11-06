// Gives the agent account a FUNCTION-CALL key on NEAR TESTNET. The key can call only the
// vault's `request_payment` method, cannot attach a deposit, and has a gas allowance. It
// refuses any other network.
//
// Run once, during setup, by whoever holds the agent account's full-access key:
//   DRAINPROOF_NEAR_EXECUTION=testnet
//   NEAR_TESTNET_ACCOUNT_ID=<agent>.testnet        the agent account
//   NEAR_TESTNET_PRIVATE_KEY=ed25519:...           its FULL-ACCESS key, for this setup step only
//   DRAINPROOF_VAULT_ACCOUNT_ID=vault.<owner>.testnet
//   DRAINPROOF_AGENT_ALLOWANCE=0.25                NEAR the new key may spend on gas (optional)
//   DRAINPROOF_AGENT_PUBLIC_KEY=ed25519:...        optional: add this public key instead
//   node add-agent-key.mjs
//
// Without DRAINPROOF_AGENT_PUBLIC_KEY, a new key pair is generated in memory and its private
// key is printed once; it is never written anywhere. The agent runtime then uses only that
// key, as DRAINPROOF_AGENT_PRIVATE_KEY.
import { isDeepStrictEqual } from "node:util";
import { KeyPair, PublicKey, actions } from "near-api-js";
import { Refusal, connectTestnet, nearToYocto, printOutcome, runScript, send, testnetAccountFromEnv, view } from "./lib/testnet.mjs";

await runScript(async () => {
  const vaultId = testnetAccountFromEnv("DRAINPROOF_VAULT_ACCOUNT_ID");
  const allowance = nearToYocto(process.env.DRAINPROOF_AGENT_ALLOWANCE || "0.25", "DRAINPROOF_AGENT_ALLOWANCE");
  const agent = await connectTestnet();

  let config;
  try {
    config = await view(agent.provider, vaultId, "get_config");
  } catch (err) {
    throw new Refusal(`could not read ${vaultId}'s configuration (is the vault deployed?): ${err.message}`);
  }
  if (config.agent_id !== agent.signerId) {
    throw new Refusal(`the vault's agent is ${config.agent_id}, not ${agent.signerId}`);
  }

  let keyPair;
  let publicKey;
  if (process.env.DRAINPROOF_AGENT_PUBLIC_KEY) {
    try {
      publicKey = PublicKey.fromString(process.env.DRAINPROOF_AGENT_PUBLIC_KEY);
    } catch (err) {
      throw new Refusal(`DRAINPROOF_AGENT_PUBLIC_KEY is not a valid public key: ${err.message}`);
    }
  } else {
    keyPair = KeyPair.fromRandom("ed25519");
    publicKey = keyPair.getPublicKey();
  }

  const r = await send(agent.account, agent.signerId, [
    actions.addFunctionCallAccessKey(publicKey, vaultId, ["request_payment"], allowance),
  ]);
  printOutcome(`Add a function-call key to ${agent.signerId}`, r);
  if (r.failure) process.exit(1);

  // Read the key back from the chain and check exactly what it allows.
  const key = await agent.provider.viewAccessKey({
    accountId: agent.signerId,
    publicKey: publicKey.toString(),
    finalityQuery: { finality: "final" },
  });
  const fc = key.permission?.FunctionCall;
  const ok =
    fc !== undefined &&
    fc.receiver_id === vaultId &&
    isDeepStrictEqual([...fc.method_names], ["request_payment"]) &&
    BigInt(fc.allowance) === allowance;
  console.log(`\nOn-chain permission of ${publicKey.toString()}:`);
  console.log(`  receiver: ${fc?.receiver_id}, methods: ${JSON.stringify(fc?.method_names)}, allowance: ${fc?.allowance} yoctoNEAR`);
  console.log(ok ? "  Verified: the key can call only request_payment on the vault." : "  NOT as expected. Do not use this key.");
  if (!ok) process.exit(1);

  if (keyPair) {
    console.log("\nPrivate key of the new function-call key (shown once, testnet only).");
    console.log("Keep it in your secret store and give it to the agent as DRAINPROOF_AGENT_PRIVATE_KEY:");
    console.log(`  ${keyPair.toString()}`);
  }
  console.log(`\nTo revoke it later: near account delete-keys ${agent.signerId} public-keys ${publicKey.toString()} network-config testnet sign-with-keychain send`);
});
