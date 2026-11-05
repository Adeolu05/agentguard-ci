/**
 * Testnet explorer links.
 *
 * Format confirmed from the official NEAR documentation source (github.com/near/docs,
 * commit fa2acf6, 2026-11-05), which links testnet transactions as
 * `https://testnet.nearblocks.io/txns/<hash>` in integrations/accounts.mdx,
 * integrations/deposits.mdx and integrations/balance-changes.mdx, and names
 * "Testnet NearBlocks" as the testnet explorer in integrations/testing.mdx.
 */
export const TESTNET_EXPLORER_TX_BASE = "https://testnet.nearblocks.io/txns/";

/** A NEAR transaction hash is the base58 encoding of a 32-byte hash. */
const TX_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isTransactionHash(value: unknown): value is string {
  return typeof value === "string" && TX_HASH_RE.test(value);
}

/**
 * Explorer link for a testnet transaction hash, or `undefined` when the value is not a
 * well-formed hash. A link is never built from anything else.
 */
export function testnetExplorerTxUrl(hash: unknown): string | undefined {
  return isTransactionHash(hash) ? `${TESTNET_EXPLORER_TX_BASE}${hash}` : undefined;
}
