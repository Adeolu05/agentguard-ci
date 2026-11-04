import type { NearClient, NearTxView } from "./executor.js";

export const DEFAULT_TESTNET_RPC = "https://test.rpc.fastnear.com";

export interface NearTestnetConfig {
  accountId: string;
  rpcUrl: string;
}

export type EnvConfigResult =
  | { ok: true; config: NearTestnetConfig; privateKey: string }
  | { ok: false; reason: string };

/**
 * Read testnet execution settings from the environment. Execution is OFF unless
 * AGENTGUARD_NEAR_EXECUTION=testnet is set explicitly. Mainnet is not supported.
 *
 *   AGENTGUARD_NEAR_EXECUTION=testnet
 *   NEAR_TESTNET_ACCOUNT_ID=your-account.testnet
 *   NEAR_TESTNET_PRIVATE_KEY=ed25519:...        (a testnet-only key; never a mainnet key)
 *   NEAR_TESTNET_RPC_URL=https://...             (optional)
 */
export function nearTestnetConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EnvConfigResult {
  if (env.AGENTGUARD_NEAR_EXECUTION !== "testnet") {
    return { ok: false, reason: "testnet execution is disabled (set AGENTGUARD_NEAR_EXECUTION=testnet to enable)" };
  }
  const accountId = env.NEAR_TESTNET_ACCOUNT_ID;
  const privateKey = env.NEAR_TESTNET_PRIVATE_KEY;
  if (!accountId || !privateKey) {
    return { ok: false, reason: "NEAR_TESTNET_ACCOUNT_ID and NEAR_TESTNET_PRIVATE_KEY must both be set" };
  }
  if (!/^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$/.test(privateKey)) {
    return { ok: false, reason: "NEAR_TESTNET_PRIVATE_KEY must look like ed25519:<base58>" };
  }
  const rpcUrl = env.NEAR_TESTNET_RPC_URL ?? DEFAULT_TESTNET_RPC;
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    return { ok: false, reason: "NEAR_TESTNET_RPC_URL is not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "NEAR_TESTNET_RPC_URL must use https" };
  if (/mainnet/i.test(url.hostname)) return { ok: false, reason: "NEAR_TESTNET_RPC_URL looks like a mainnet endpoint" };
  return { ok: true, config: { accountId, rpcUrl }, privateKey };
}

/**
 * Build a NearClient on near-api-js v7. The private key stays inside this closure and
 * is never returned, logged or written to reports.
 */
export async function createNearTestnetClient(config: NearTestnetConfig, privateKey: string): Promise<NearClient> {
  const { Account, JsonRpcProvider, actions } = await import("near-api-js");
  const provider = new JsonRpcProvider({ url: config.rpcUrl });
  const account = new Account(config.accountId, provider, privateKey as `ed25519:${string}`);
  return {
    signerAccountId: config.accountId,
    getNetworkId: () => provider.getNetworkId(),
    async transfer(receiverId, amountYocto) {
      const tx = await account.signAndSendTransaction({
        receiverId,
        actions: [actions.transfer(amountYocto)],
        waitUntil: "FINAL",
        throwOnFailure: false,
      });
      return tx as unknown as NearTxView;
    },
    async transactionStatus(txHash) {
      const tx = await provider.viewTransactionStatus({ txHash, accountId: config.accountId, waitUntil: "FINAL" });
      return tx as unknown as NearTxView;
    },
  };
}
