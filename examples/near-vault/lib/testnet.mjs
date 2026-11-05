// Guard rails shared by the vault's testnet scripts. A script signs nothing unless:
//  - AGENTGUARD_NEAR_EXECUTION=testnet is set (an explicit opt-in),
//  - the RPC URL is https and does not look like a mainnet endpoint,
//  - the RPC node itself reports the chain id "testnet",
//  - every account involved is a testnet account (a .testnet name or an implicit account).
// Private keys are read only from the environment variables listed in .env.example.
import { parseDecimalAmount } from "@agentguard/core";
import { checkTestnetAccountId, nearTestnetConfigFromEnv, testnetExplorerTxUrl } from "@agentguard/near";
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";
import { decodeReturn, eventsOf, failureMessage, logsOf } from "./outcome.mjs";

/** A refusal to act. Scripts print it and exit with code 2; nothing has been signed. */
export class Refusal extends Error {}

export function requireEnv(name, env = process.env) {
  const value = env[name];
  if (!value) throw new Refusal(`${name} is not set (see .env.example)`);
  return value;
}

/** Reads and checks a testnet account ID from the environment. */
export function testnetAccountFromEnv(name, env = process.env) {
  const id = requireEnv(name, env);
  const check = checkTestnetAccountId(id);
  if (!check.ok) throw new Refusal(`${name}: ${check.message}`);
  return id;
}

/** "3" or "0.25" NEAR as exact yoctoNEAR. */
export function nearToYocto(value, label) {
  const parsed = parseDecimalAmount(value, 24);
  if (!parsed.ok) throw new Refusal(`${label}: "${value}" is not an exact NEAR amount (${parsed.code})`);
  return parsed.value;
}

/**
 * Connects to testnet as NEAR_TESTNET_ACCOUNT_ID, signing with NEAR_TESTNET_PRIVATE_KEY.
 * Refuses unless the opt-in is set and the RPC node reports "testnet".
 */
export async function connectTestnet(env = process.env) {
  const cfg = nearTestnetConfigFromEnv(env);
  if (!cfg.ok) throw new Refusal(cfg.reason);
  const idCheck = checkTestnetAccountId(cfg.config.accountId);
  if (!idCheck.ok) throw new Refusal(`NEAR_TESTNET_ACCOUNT_ID: ${idCheck.message}`);
  const provider = new JsonRpcProvider({ url: cfg.config.rpcUrl });
  let networkId;
  try {
    networkId = await provider.getNetworkId();
  } catch (err) {
    throw new Refusal(`could not reach the RPC at ${cfg.config.rpcUrl}: ${err.message}`);
  }
  if (networkId !== "testnet") {
    throw new Refusal(`the RPC at ${cfg.config.rpcUrl} reports network "${networkId}", not "testnet"`);
  }
  return {
    provider,
    rpcUrl: cfg.config.rpcUrl,
    signerId: cfg.config.accountId,
    publicKey: KeyPair.fromString(cfg.privateKey).getPublicKey(),
    account: new Account(cfg.config.accountId, provider, cfg.privateKey),
  };
}

export async function accountExists(provider, accountId) {
  try {
    await provider.viewAccount({ accountId, finalityQuery: { finality: "final" } });
    return true;
  } catch (err) {
    if (err?.constructor?.name === "AccountDoesNotExistError" || /does not exist/i.test(String(err?.message))) return false;
    throw err;
  }
}

export const view = (provider, contractId, method, args = {}) => provider.callFunction({ contractId, method, args });

/** Signs and sends one transaction. It is never re-signed or re-sent with a new nonce. */
export async function send(account, receiverId, actions) {
  const tx = await account.signAndSendTransaction({ receiverId, actions, waitUntil: "FINAL", throwOnFailure: false, retries: 0 });
  return {
    tx,
    hash: tx.transaction_outcome?.id,
    value: decodeReturn(tx.status),
    failure: failureMessage(tx),
    events: eventsOf(tx),
    logs: logsOf(tx),
  };
}

/** Prints a transaction's hash as returned by the network, its explorer link and its status. */
export function printOutcome(label, r) {
  console.log(label);
  console.log(`  Transaction hash (as returned by the network): ${r.hash ?? "none returned"}`);
  const url = testnetExplorerTxUrl(r.hash);
  if (url) console.log(`  Explorer: ${url}`);
  console.log(r.failure ? `  Transaction status: FAILED (${r.failure})` : "  Transaction status: executed");
}

/** Runs a script's main function: a Refusal exits with code 2, any other error with 1. */
export async function runScript(main) {
  try {
    await main();
  } catch (err) {
    if (err instanceof Refusal) {
      console.error(`Refused: ${err.message}. Nothing was signed or sent.`);
      process.exit(2);
    }
    console.error(err);
    process.exit(1);
  }
}
