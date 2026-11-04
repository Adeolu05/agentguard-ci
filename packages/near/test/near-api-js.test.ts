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

async function rpcStub(
  opts: { chainId?: string; txStatus?: unknown; firstSendFails?: "http500" | "invalidNonce" } = {},
): Promise<Stub> {
  let sends = 0;
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
      else if (msg.method === "send_tx" && sends++ === 0 && opts.firstSendFails === "http500") {
        res.statusCode = 500;
        res.end("internal error");
        return;
      } else if (msg.method === "send_tx" && sends === 1 && opts.firstSendFails === "invalidNonce") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              name: "HANDLER_ERROR",
              cause: { name: "INVALID_TRANSACTION", info: {} },
              data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { ak_nonce: 6, tx_nonce: 6 } } } },
              code: -32000,
              message: "Server error",
            },
          }),
        );
        return;
      } else if (msg.method === "send_tx") {
        const signed = decodeSignedTransaction(base64Decode(msg.params.signed_tx_base64 as string));
        const hash = baseEncode(createHash("sha256").update(encodeTransaction(signed.transaction)).digest());
        const t = signed.transaction;
        result = {
          status: opts.txStatus ?? { SuccessValue: "" },
          transaction: {
            hash,
            signer_id: t.signerId,
            receiver_id: t.receiverId,
            actions: t.actions.map((a) => (a.transfer ? { Transfer: { deposit: a.transfer.deposit.toString() } } : a)),
          },
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

  for (const failure of ["http500", "invalidNonce"] as const) {
    it(`broadcasts at most once when the first send fails (${failure}) and leaves the outcome to reconcile`, async () => {
      const stub = await rpcStub({ firstSendFails: failure });
      const { engine, id } = await authorised();
      const client = await createNearTestnetClient({ accountId: "agent.testnet", rpcUrl: stub.url }, KeyPair.fromRandom("ed25519").toString());
      const r = await new NearTestnetExecutor({ engine, client, timeoutMs: 10_000 }).execute(id);
      expect(stub.calls.filter((c) => c.method === "send_tx")).toHaveLength(1);
      expect(r.status).toBe("unknown");
      expect(r.transactionHash).toBeUndefined();
      expect((await engine.getReservation(id))?.status).toBe("submitted"); // still counts toward limits
    });
  }

  it("blocked and unapproved proposals never reach signing or broadcasting", async () => {
    const stub = await rpcStub();
    const loaded = policyFromYaml(POLICY.replace('max_daily_spend: "2" }', 'max_daily_spend: "2", approval_required_above: "0.5" }'));
    if (!loaded.ok) throw new Error("policy");
    const engine = new PolicyEngine({ policy: loaded.policy, ledger: new InMemoryLedger(), validators: [nearAccountIdValidator()] });
    const client = await createNearTestnetClient({ accountId: "agent.testnet", rpcUrl: stub.url }, KeyPair.fromRandom("ed25519").toString());
    const executor = new NearTestnetExecutor({ engine, client });
    const base = { agentId: "near-agent", assetId: "NEAR", networkId: "near-testnet" };

    const attempts = [
      { requestId: "over-limit", ...base, amount: "5", recipientId: "merchant-example.testnet" },
      { requestId: "mainnet-account", ...base, amount: "0.1", recipientId: "merchant-example.near" },
      { requestId: "not-allowlisted", ...base, amount: "0.1", recipientId: "attacker.testnet" },
      { requestId: "needs-approval", ...base, amount: "0.75", recipientId: "merchant-example.testnet" },
    ];
    for (const p of attempts) {
      const e = await engine.authorize(p);
      expect(e.decision, p.requestId).not.toBe("ALLOW");
      expect(e.reservation, p.requestId).toBeUndefined(); // nothing an executor could act on
    }
    // Even an executor invoked with a made-up reservation id refuses before any RPC call.
    expect((await executor.execute("res_does_not_exist")).status).toBe("refused");
    expect(stub.calls).toEqual([]); // no status, access-key, block or send_tx request: nothing was signed or sent

    const ok = await engine.authorize({ requestId: "ok", ...base, amount: "0.1", recipientId: "merchant-example.testnet" });
    expect(ok.decision).toBe("ALLOW");
    expect((await executor.execute(ok.reservation!.reservationId)).status).toBe("confirmed");
    const sends = stub.calls.filter((c) => c.method === "send_tx");
    expect(sends).toHaveLength(1);
    const signed = decodeSignedTransaction(base64Decode(sends[0]!.params.signed_tx_base64 as string));
    expect(signed.transaction.receiverId).toBe("merchant-example.testnet");
    expect(signed.transaction.actions[0]!.transfer?.deposit).toBe(100_000_000_000_000_000_000_000n);
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
