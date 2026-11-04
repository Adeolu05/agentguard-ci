/**
 * Exercises the real near-api-js v7 code path (key handling, transaction building,
 * Borsh encoding, signing, JSON-RPC calls) against a local JSON-RPC stub.
 *
 * What this verifies: AgentGuard's client wrapper drives near-api-js correctly. It builds
 * a correctly signed transfer with the exact amount and receiver, asks for FINAL, and
 * reads the network ID. What it does NOT verify: live NEAR testnet behaviour. The stub's
 * responses are minimal fixtures, not real network output.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { KeyPair, base64Decode, baseEncode, decodeSignedTransaction, encodeTransaction } from "near-api-js";
import { InMemoryLedger, PolicyEngine, policyFromYaml } from "@agentguard/core";
import { NearTestnetExecutor, createNearTestnetClient, nearAccountIdValidator } from "../src/index.js";

interface Stub {
  url: string;
  calls: { method: string; params: Record<string, unknown> }[];
  close(): void;
}

const servers: Stub[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function rpcStub(opts: { chainId?: string; txStatus?: unknown } = {}): Promise<Stub> {
  const blockHash = baseEncode(new Uint8Array(32).fill(7));
  const calls: Stub["calls"] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body) as { id: unknown; method: string; params: Record<string, unknown> };
      calls.push({ method: msg.method, params: msg.params });
      let result: unknown;
      if (msg.method === "status") result = { chain_id: opts.chainId ?? "testnet" };
      else if (msg.method === "block") result = { header: { hash: blockHash, height: 100 } };
      else if (msg.method === "query") result = { nonce: 5, permission: "FullAccess", block_hash: blockHash, block_height: 100 };
      else if (msg.method === "send_tx") {
        const signed = decodeSignedTransaction(base64Decode(msg.params.signed_tx_base64 as string));
        const hash = baseEncode(createHash("sha256").update(encodeTransaction(signed.transaction)).digest());
        result = {
          status: opts.txStatus ?? { SuccessValue: "" },
          transaction: { hash },
          transaction_outcome: { id: hash, block_hash: blockHash, outcome: {}, proof: [] },
          receipts_outcome: [],
          final_execution_status: "FINAL",
        };
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          result === undefined
            ? { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `stub does not implement ${msg.method}`, data: "" } }
            : { jsonrpc: "2.0", id: msg.id, result },
        ),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const stub = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => server.close() };
  servers.push(stub);
  return stub;
}

describe("createNearTestnetClient with near-api-js 7.4.0", () => {
  it("reads the network id from the RPC status call", async () => {
    const stub = await rpcStub({ chainId: "testnet" });
    const client = await createNearTestnetClient({ accountId: "agent.testnet", rpcUrl: stub.url }, KeyPair.fromRandom("ed25519").toString());
    expect(await client.getNetworkId()).toBe("testnet");
    expect(stub.calls[0]?.method).toBe("status");
  });

  it("signs exactly one transfer with the exact yoctoNEAR amount and receiver", async () => {
    const stub = await rpcStub();
    const kp = KeyPair.fromRandom("ed25519");
    const client = await createNearTestnetClient({ accountId: "agent.testnet", rpcUrl: stub.url }, kp.toString());
    const amount = 123_456_789_012_345_678_901_234n;
    const r = await client.transfer("merchant-example.testnet", amount);

    const sends = stub.calls.filter((c) => c.method === "send_tx");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.params.wait_until).toBe("FINAL");
    const signed = decodeSignedTransaction(base64Decode(sends[0]!.params.signed_tx_base64 as string));
    expect(signed.transaction.signerId).toBe("agent.testnet");
    expect(signed.transaction.receiverId).toBe("merchant-example.testnet");
    expect(signed.transaction.actions).toHaveLength(1);
    expect(signed.transaction.actions[0]!.transfer?.deposit).toBe(amount);
    // The signature verifies against the signer's public key over sha256(borsh(transaction)).
    const digest = createHash("sha256").update(encodeTransaction(signed.transaction)).digest();
    // Decoded transactions carry the raw Borsh enum ({ ed25519Signature: { data } }).
    const sig = Uint8Array.from(signed.signature.ed25519Signature?.data ?? []);
    expect(sig).toHaveLength(64);
    expect(kp.verify(new Uint8Array(digest), sig)).toBe(true);
    expect(kp.verify(new Uint8Array(32), sig)).toBe(false);
    expect(r.transaction_outcome.id).toBe(baseEncode(digest));
  });
});

describe("NearTestnetExecutor with the real client", () => {
  const POLICY = `
version: 1
agent: { id: near-agent }
assets: [{ id: NEAR, decimals: 24, max_transaction_amount: "1", max_daily_spend: "2" }]
limits: { max_transaction_count_per_day: 10 }
recipients: { mode: allowlist, allowed: [merchant-example.testnet] }
networks: { allowed: [near-testnet] }
`;
  async function authorised() {
    const loaded = policyFromYaml(POLICY);
    if (!loaded.ok) throw new Error("policy");
    const engine = new PolicyEngine({ policy: loaded.policy, ledger: new InMemoryLedger(), validators: [nearAccountIdValidator()] });
    const e = await engine.authorize({
      requestId: "r1", agentId: "near-agent", assetId: "NEAR", amount: "0.25", recipientId: "merchant-example.testnet", networkId: "near-testnet",
    });
    return { engine, id: e.reservation!.reservationId };
  }

  it("confirms a transfer and records the hash computed from the signed transaction", async () => {
    const stub = await rpcStub();
    const { engine, id } = await authorised();
    const client = await createNearTestnetClient({ accountId: "agent.testnet", rpcUrl: stub.url }, KeyPair.fromRandom("ed25519").toString());
    const r = await new NearTestnetExecutor({ engine, client }).execute(id);
    expect(r.status).toBe("confirmed");
    const signed = decodeSignedTransaction(base64Decode(stub.calls.find((c) => c.method === "send_tx")!.params.signed_tx_base64 as string));
    expect(signed.transaction.actions[0]!.transfer?.deposit).toBe(250_000_000_000_000_000_000_000n);
    expect((await engine.getReservation(id))?.transactionReference).toBe(r.transactionHash);
  });

  it("records an on-chain failure as failed when throwOnFailure is disabled", async () => {
    const stub = await rpcStub({ txStatus: { Failure: { ActionError: { index: 0, kind: { AccountDoesNotExist: { account_id: "x" } } } } } });
    const { engine, id } = await authorised();
    const client = await createNearTestnetClient({ accountId: "agent.testnet", rpcUrl: stub.url }, KeyPair.fromRandom("ed25519").toString());
    const r = await new NearTestnetExecutor({ engine, client }).execute(id);
    expect(r.status).toBe("failed");
  });

  it("refuses to sign anything when the RPC reports mainnet", async () => {
    const stub = await rpcStub({ chainId: "mainnet" });
    const { engine, id } = await authorised();
    const client = await createNearTestnetClient({ accountId: "agent.testnet", rpcUrl: stub.url }, KeyPair.fromRandom("ed25519").toString());
    const r = await new NearTestnetExecutor({ engine, client }).execute(id);
    expect(r).toMatchObject({ status: "refused", reasonCode: "RPC_NOT_TESTNET" });
    expect(stub.calls.map((c) => c.method)).toEqual(["status"]);
  });
});
