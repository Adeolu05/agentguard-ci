/**
 * Testnet demo output: explorer links, final-status wording and the read-only
 * status check. No network access: the client is a fake.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryLedger, PolicyEngine, policyFromYaml } from "@drainproof/core";
import {
  NearTestnetExecutor,
  TESTNET_EXPLORER_TX_BASE,
  describeExecution,
  isTransactionHash,
  nearAccountIdValidator,
  testnetExplorerTxUrl,
  type NearClient,
} from "../src/index.js";

// A testnet transaction hash quoted in the official NEAR docs source
// (github.com/near/docs fa2acf6, integrations/deposits.mdx:36). Used here only as a
// well-formed example value; no test contacts the network.
const DOCS_HASH = "GgjJMwGhJF8ybgMCCc6v9HxE7DPm8UJyRT6yxdJV3stj";

describe("testnet explorer links", () => {
  it("uses the documented NearBlocks testnet format", () => {
    expect(TESTNET_EXPLORER_TX_BASE).toBe("https://testnet.nearblocks.io/txns/");
    expect(testnetExplorerTxUrl(DOCS_HASH)).toBe(`https://testnet.nearblocks.io/txns/${DOCS_HASH}`);
  });

  it.each([
    ["empty", ""],
    ["non-base58 characters (0, O, I, l)", "0OIl".repeat(11)],
    ["too long", "1".repeat(45)],
    ["too short", "abc"],
    ["path traversal", "../../admin"],
    ["query injection", `${DOCS_HASH}?x=1`],
    ["not a string", 42],
    ["undefined", undefined],
  ])("never builds a link for %s", (_name, value) => {
    expect(isTransactionHash(value)).toBe(false);
    expect(testnetExplorerTxUrl(value)).toBeUndefined();
  });
});

describe("describeExecution", () => {
  it("confirmed: hash exactly as returned, explorer link, final status, matching re-read", () => {
    const lines = describeExecution(
      { status: "confirmed", transactionHash: DOCS_HASH, message: "transaction confirmed" },
      { status: "confirmed", transactionHash: DOCS_HASH, message: "network reports the transaction as confirmed" },
    );
    expect(lines).toEqual([
      `Transaction hash (exactly as returned by the network): ${DOCS_HASH}`,
      `Explorer: https://testnet.nearblocks.io/txns/${DOCS_HASH}`,
      "Final status: CONFIRMED. The transfer executed on testnet.",
      "Re-read from the RPC by hash: CONFIRMED (matches)",
    ]);
  });

  it("failed on-chain", () => {
    const lines = describeExecution({ status: "failed", transactionHash: DOCS_HASH, message: "transaction failed" });
    expect(lines[2]).toMatch(/^Final status: FAILED on-chain\. The transfer did not execute/);
  });

  it("pending says it is not final and keeps counting toward limits", () => {
    const lines = describeExecution({ status: "pending", transactionHash: DOCS_HASH, message: "transaction not final yet" });
    expect(lines[2]).toMatch(/NOT FINAL YET.*keeps counting toward limits/);
  });

  it("an ambiguous outcome without a hash says so and prints no link", () => {
    const lines = describeExecution({ status: "unknown", message: "transfer timed out after 60000 ms" });
    expect(lines[0]).toBe("Transaction hash: none was returned by the network, so there is no explorer link.");
    expect(lines.join("\n")).not.toMatch(/nearblocks/);
    expect(lines[1]).toMatch(
      /UNKNOWN\. The outcome is ambiguous \(transfer timed out after 60000 ms\): the transfer may or may not have executed/,
    );
  });

  it("refusal: nothing signed, no hash or link lines", () => {
    const lines = describeExecution({ status: "refused", reasonCode: "RPC_NOT_TESTNET", message: 'RPC reports network "mainnet"' });
    expect(lines).toEqual(['Refused before signing (RPC_NOT_TESTNET): RPC reports network "mainnet". Nothing was signed or sent.']);
  });

  it("prints a malformed returned value verbatim but builds no link for it", () => {
    const lines = describeExecution({ status: "confirmed", transactionHash: "not a hash", message: "x" });
    expect(lines[0]).toBe("Transaction hash (exactly as returned by the network): not a hash");
    expect(lines[1]).toBe("Explorer: no link (the returned value is not a well-formed transaction hash)");
  });

  it("flags a re-read that differs from the broadcast result", () => {
    const lines = describeExecution(
      { status: "pending", transactionHash: DOCS_HASH, message: "x" },
      { status: "confirmed", transactionHash: DOCS_HASH, message: "y" },
    );
    expect(lines.at(-1)).toBe("Re-read from the RPC by hash: CONFIRMED (differs from the broadcast result, pending)");
  });

  it("reports an unknown re-read with its reason", () => {
    const lines = describeExecution(
      { status: "confirmed", transactionHash: DOCS_HASH, message: "x" },
      { status: "unknown", transactionHash: DOCS_HASH, message: "status query failed: 503" },
    );
    expect(lines.at(-1)).toBe("Re-read from the RPC by hash: UNKNOWN (status query failed: 503)");
  });
});

describe("checkStatus is read-only", () => {
  const POLICY = `
version: 1
agent: { id: near-agent }
assets: [{ id: NEAR, decimals: 24, max_transaction_amount: "1", max_daily_spend: "2" }]
limits: { max_transaction_count_per_day: 10 }
recipients: { mode: allowlist, allowed: [merchant.testnet] }
networks: { allowed: [near-testnet] }
`;

  function setup(client: Partial<NearClient>) {
    const loaded = policyFromYaml(POLICY);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    const engine = new PolicyEngine({ policy: loaded.policy, ledger: new InMemoryLedger(), validators: [nearAccountIdValidator()] });
    const full: NearClient = {
      signerAccountId: "drainproof-demo.testnet",
      getNetworkId: async () => "testnet",
      transfer: async () => ({ status: { SuccessValue: "" }, transaction_outcome: { id: DOCS_HASH } }),
      transactionStatus: async (h: string) => ({ status: { SuccessValue: "" }, transaction_outcome: { id: h } }),
      ...client,
    };
    return { engine, executor: new NearTestnetExecutor({ engine, client: full, timeoutMs: 200 }) };
  }

  const proposal = (requestId: string) => ({
    requestId,
    agentId: "near-agent",
    assetId: "NEAR",
    amount: "0.1",
    recipientId: "merchant.testnet",
    networkId: "near-testnet",
  });

  async function reserve(engine: PolicyEngine, requestId: string): Promise<string> {
    const e = await engine.authorize(proposal(requestId));
    if (!e.reservation) throw new Error(`expected a reservation, got ${e.decision}`);
    return e.reservation.reservationId;
  }

  it("after a confirmed transfer, reconcile() is refused (already settled) but checkStatus() reports the status", async () => {
    const { engine, executor } = setup({});
    const id = await reserve(engine, "r1");
    expect((await executor.execute(id)).status).toBe("confirmed");
    // The earlier demo called reconcile() here, which is correctly refused for a settled reservation.
    expect((await executor.reconcile(id, DOCS_HASH)).status).toBe("refused");
    expect(await executor.checkStatus(DOCS_HASH)).toEqual({
      status: "confirmed",
      transactionHash: DOCS_HASH,
      message: "network reports the transaction as confirmed",
    });
    expect((await engine.getReservation(id))?.status).toBe("confirmed");
  });

  it("never changes an ambiguous reservation, whatever the network reports", async () => {
    const { engine, executor } = setup({
      transfer: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
      transactionStatus: async (h: string) => ({ status: { Failure: {} }, transaction_outcome: { id: h } }),
    });
    const id = await reserve(engine, "r2");
    expect((await executor.execute(id)).status).toBe("unknown");
    const before = await engine.getReservation(id);
    expect((await executor.checkStatus(DOCS_HASH)).status).toBe("failed");
    const after = await engine.getReservation(id);
    expect(after).toEqual(before);
    expect(after?.status).toBe("submitted"); // still counts toward limits
    expect(after?.transactionReference).toBeUndefined();
  });

  it("reports unknown when the RPC errors, times out or answers for another transaction", async () => {
    const failing = setup({
      transactionStatus: async () => {
        throw new Error("503");
      },
    }).executor;
    expect(await failing.checkStatus(DOCS_HASH)).toMatchObject({ status: "unknown", message: "status query failed: 503" });

    const hanging = setup({ transactionStatus: () => new Promise(() => {}) }).executor;
    expect((await hanging.checkStatus(DOCS_HASH)).message).toMatch(/timed out after 200 ms/);

    const other = setup({
      transactionStatus: async () => ({ status: { SuccessValue: "" }, transaction_outcome: { id: "SomeOtherHash" } }),
    }).executor;
    expect(await other.checkStatus(DOCS_HASH)).toMatchObject({
      status: "unknown",
      message: "status response did not match the requested transaction",
    });
  });

  it("classifies a not-yet-final transaction as pending", async () => {
    const { executor } = setup({ transactionStatus: async (h: string) => ({ status: "Started", transaction_outcome: { id: h } }) });
    expect((await executor.checkStatus(DOCS_HASH)).status).toBe("pending");
  });
});
