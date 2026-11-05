import { describe, expect, it, vi } from "vitest";
import { InMemoryLedger, PolicyEngine, policyFromYaml } from "@agentguard/core";
import {
  checkAccountNetwork,
  checkDirectSubAccount,
  checkNearAccountId,
  checkTestnetAccountId,
  classifyStatus,
  nearAccountIdValidator,
  nearTestnetConfigFromEnv,
  NearTestnetExecutor,
  type NearClient,
} from "../src/index.js";

const POLICY = `
version: 1
agent: { id: near-agent }
assets:
  - { id: NEAR, decimals: 24, max_transaction_amount: "1", max_daily_spend: "2" }
limits: { max_transaction_count_per_day: 10 }
recipients: { mode: allowlist, allowed: [merchant.testnet, Merchant.testnet, bob.near] }
networks: { allowed: [near-testnet] }
`;

function engineFor(yaml = POLICY, ledger = new InMemoryLedger()) {
  const r = policyFromYaml(yaml);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return new PolicyEngine({ policy: r.policy, ledger, validators: [nearAccountIdValidator()] });
}

const proposal = (o: Record<string, unknown> = {}) => ({
  requestId: `r-${Math.random().toString(36).slice(2)}`,
  agentId: "near-agent",
  assetId: "NEAR",
  amount: "0.5",
  recipientId: "merchant.testnet",
  networkId: "near-testnet",
  ...o,
});

function fakeClient(overrides: Partial<NearClient> = {}): NearClient & { transfer: ReturnType<typeof vi.fn> } {
  return {
    signerAccountId: "agentguard-demo.testnet",
    getNetworkId: async () => "testnet",
    transfer: vi.fn(async () => ({ status: { SuccessValue: "" }, transaction_outcome: { id: "FakeHashFromNetwork111" } })),
    transactionStatus: async (h: string) => ({ status: { SuccessValue: "" }, transaction_outcome: { id: h } }),
    ...overrides,
  } as NearClient & { transfer: ReturnType<typeof vi.fn> };
}

describe("NEAR account IDs", () => {
  it.each(["alice.testnet", "a-b_c.testnet", "ab", "sub.account.testnet", "a".repeat(64).replace(/a/g, "f"), `0x${"ab".repeat(20)}`])(
    "accepts %s",
    (id) => expect(checkNearAccountId(id).ok).toBe(true),
  );
  it.each(["Alice.testnet", "a", ".alice", "alice.", "a..b", "a--b", "alice-", "a b", "a".repeat(65), "alice@testnet", ""])(
    "rejects %j",
    (id) => expect(checkNearAccountId(id).ok).toBe(false),
  );
  it("flags cross-network named accounts", () => {
    expect(checkAccountNetwork("bob.near", "near-testnet").ok).toBe(false);
    expect(checkAccountNetwork("bob.testnet", "near-mainnet").ok).toBe(false);
    expect(checkAccountNetwork("f".repeat(64), "near-testnet").ok).toBe(true);
  });
});

describe("testnet-only account checks for the vault scripts", () => {
  it.each(["alice.testnet", "vault.alice.testnet", "f".repeat(64), `0x${"ab".repeat(20)}`])("accepts %s", (id) =>
    expect(checkTestnetAccountId(id).ok).toBe(true),
  );
  it.each(["alice.near", "alice", "near", "Alice.testnet", "testnet.near"])("rejects %s", (id) =>
    expect(checkTestnetAccountId(id).ok).toBe(false),
  );
  it("only accepts a direct sub-account", () => {
    expect(checkDirectSubAccount("vault.alice.testnet", "alice.testnet").ok).toBe(true);
    expect(checkDirectSubAccount("a.vault.alice.testnet", "alice.testnet").ok).toBe(false);
    expect(checkDirectSubAccount("vaultalice.testnet", "alice.testnet").ok).toBe(false);
    expect(checkDirectSubAccount(".alice.testnet", "alice.testnet").ok).toBe(false);
    expect(checkDirectSubAccount("alice.testnet", "alice.testnet").ok).toBe(false);
  });
});

describe("nearAccountIdValidator in the engine", () => {
  it("blocks allowlisted but invalid or wrong-network recipients", async () => {
    const engine = engineFor();
    const upper = await engine.authorize(proposal({ recipientId: "Merchant.testnet" }));
    expect(upper.decision).toBe("BLOCK");
    expect(upper.reasonCodes).toEqual(["ADAPTER_VALIDATION_FAILED"]);
    const mainnetAccount = await engine.authorize(proposal({ recipientId: "bob.near" }));
    expect(mainnetAccount.reasonCodes).toEqual(["ADAPTER_VALIDATION_FAILED"]);
    expect((await engine.authorize(proposal())).decision).toBe("ALLOW");
  });
  it("uses exact yoctoNEAR arithmetic", async () => {
    const engine = engineFor();
    const e = await engine.authorize(proposal({ amount: "1.000000000000000000000001" }));
    expect(e.reasonCodes).toEqual(["AMOUNT_EXCEEDS_TRANSACTION_LIMIT"]);
  });
});

describe("NearTestnetExecutor", () => {
  async function authorised(engine = engineFor(), o: Record<string, unknown> = {}) {
    const e = await engine.authorize(proposal(o));
    expect(e.decision).toBe("ALLOW");
    return { engine, id: e.reservation!.reservationId };
  }

  it("executes an authorised transfer and records the hash returned by the network", async () => {
    const { engine, id } = await authorised();
    const client = fakeClient();
    const r = await new NearTestnetExecutor({ engine, client }).execute(id);
    expect(r.status).toBe("confirmed");
    expect(r.transactionHash).toBe("FakeHashFromNetwork111");
    expect(client.transfer).toHaveBeenCalledWith("merchant.testnet", 500_000_000_000_000_000_000_000n);
    const stored = await engine.getReservation(id);
    expect(stored?.status).toBe("confirmed");
    expect(stored?.transactionReference).toBe("FakeHashFromNetwork111");
  });

  it("refuses unknown reservations without touching the network", async () => {
    const client = fakeClient();
    const r = await new NearTestnetExecutor({ engine: engineFor(), client }).execute("res_nope");
    expect(r.status).toBe("refused");
    expect(client.transfer).not.toHaveBeenCalled();
  });

  it("refuses when the RPC is not testnet and leaves the reservation untouched", async () => {
    const { engine, id } = await authorised();
    const client = fakeClient({ getNetworkId: async () => "mainnet" });
    const r = await new NearTestnetExecutor({ engine, client }).execute(id);
    expect(r).toMatchObject({ status: "refused", reasonCode: "RPC_NOT_TESTNET" });
    expect(client.transfer).not.toHaveBeenCalled();
    expect((await engine.getReservation(id))?.status).toBe("reserved");
  });

  it("refuses non-testnet signers", async () => {
    const { engine, id } = await authorised();
    const client = fakeClient({ signerAccountId: "whale.near" });
    expect((await new NearTestnetExecutor({ engine, client }).execute(id)).reasonCode).toBe("SIGNER_NOT_TESTNET");
    expect(client.transfer).not.toHaveBeenCalled();
  });

  it("refuses non-NEAR assets", async () => {
    const yaml = POLICY.replace("assets:\n", "assets:\n  - { id: USDC, decimals: 6, max_transaction_amount: \"5\", max_daily_spend: \"5\" }\n");
    const { engine, id } = await authorised(engineFor(yaml), { assetId: "USDC", amount: "1" });
    const client = fakeClient();
    expect((await new NearTestnetExecutor({ engine, client }).execute(id)).reasonCode).toBe("ASSET_NOT_SUPPORTED");
  });

  it("cannot execute the same reservation twice", async () => {
    const { engine, id } = await authorised();
    const client = fakeClient();
    const ex = new NearTestnetExecutor({ engine, client });
    await ex.execute(id);
    const second = await ex.execute(id);
    expect(second.status).toBe("refused");
    expect(second.reasonCode).toBe("INVALID_STATE_TRANSITION");
    expect(client.transfer).toHaveBeenCalledTimes(1);
  });

  it("refuses reservations authorised under a stale policy", async () => {
    const ledger = new InMemoryLedger();
    const { id } = await authorised(engineFor(POLICY, ledger));
    const newer = engineFor(POLICY.replace('max_daily_spend: "2"', 'max_daily_spend: "3"'), ledger);
    const client = fakeClient();
    expect((await new NearTestnetExecutor({ engine: newer, client }).execute(id)).reasonCode).toBe("STALE_POLICY_VERSION");
    expect(client.transfer).not.toHaveBeenCalled();
  });

  it("records on-chain failures and releases the budget", async () => {
    const { engine, id } = await authorised();
    const client = fakeClient({
      transfer: vi.fn(async () => ({ status: { Failure: { ActionError: {} } }, transaction_outcome: { id: "FailedTx" } })),
    });
    const r = await new NearTestnetExecutor({ engine, client }).execute(id);
    expect(r.status).toBe("failed");
    expect((await engine.getReservation(id))?.status).toBe("failed");
  });

  it("leaves ambiguous outcomes submitted (still counting) and never invents a hash", async () => {
    const { engine, id } = await authorised();
    const client = fakeClient({ transfer: vi.fn(async () => { throw new Error("socket hang up"); }) });
    const r = await new NearTestnetExecutor({ engine, client }).execute(id);
    expect(r.status).toBe("unknown");
    expect(r.transactionHash).toBeUndefined();
    expect((await engine.getReservation(id))?.status).toBe("submitted");
    // The 0.5 NEAR in flight still counts: 0.5 + 1 = 1.5 fits the 2 NEAR limit, a further 0.6 does not.
    expect((await engine.authorize(proposal({ amount: "1" }))).decision).toBe("ALLOW");
    expect((await engine.authorize(proposal({ amount: "0.6" }))).reasonCodes).toEqual(["DAILY_SPEND_LIMIT_EXCEEDED"]);
  });

  it("treats a response without a transaction hash as unknown", async () => {
    const { engine, id } = await authorised();
    const client = fakeClient({ transfer: vi.fn(async () => ({ status: { SuccessValue: "" } }) as never) });
    const r = await new NearTestnetExecutor({ engine, client }).execute(id);
    expect(r.status).toBe("unknown");
    expect(r.transactionHash).toBeUndefined();
  });

  it("times out slow transfers as unknown", async () => {
    const { engine, id } = await authorised();
    const client = fakeClient({ transfer: vi.fn(() => new Promise(() => {})) as never });
    const r = await new NearTestnetExecutor({ engine, client, timeoutMs: 50 }).execute(id);
    expect(r.status).toBe("unknown");
    expect(r.message).toMatch(/timed out/);
  });

  it("reconciles an ambiguous reservation only with a transaction that matches it", async () => {
    const { engine, id } = await authorised();
    const view = (receiver: string, deposit: string, hash: string) => ({
      status: { SuccessValue: "" },
      transaction_outcome: { id: hash },
      transaction: { signer_id: "agentguard-demo.testnet", receiver_id: receiver, actions: [{ Transfer: { deposit } }] },
    });
    const amount = (500_000_000_000_000_000_000_000n).toString();
    await new NearTestnetExecutor({ engine, client: fakeClient({ transfer: vi.fn(async () => { throw new Error("timeout"); }) }) }).execute(id);
    // An unrelated transaction (different receiver) cannot settle it.
    const wrong = await new NearTestnetExecutor({
      engine,
      client: fakeClient({ transactionStatus: async (h: string) => view("someone-else.testnet", amount, h) }),
    }).reconcile(id, "UnrelatedHash");
    expect(wrong).toMatchObject({ status: "refused", reasonCode: "TRANSACTION_MISMATCH" });
    // The matching transaction does.
    const ok = await new NearTestnetExecutor({
      engine,
      client: fakeClient({ transactionStatus: async (h: string) => view("merchant.testnet", amount, h) }),
    }).reconcile(id, "KnownHash");
    expect(ok.status).toBe("confirmed");
    expect((await engine.getReservation(id))?.transactionReference).toBe("KnownHash");
    const mismatch = await new NearTestnetExecutor({
      engine,
      client: fakeClient({ transactionStatus: async () => ({ status: { SuccessValue: "" }, transaction_outcome: { id: "Other" } }) }),
    }).reconcile(id, "KnownHash");
    expect(mismatch.status).toBe("refused"); // already confirmed: nothing left to reconcile
  });

  it("a pending transfer's hash is recorded, and an unrelated failed hash cannot release its budget", async () => {
    const { engine, id } = await authorised();
    const pending = fakeClient({ transfer: vi.fn(async () => ({ status: "Started", transaction_outcome: { id: "RealHash" } })) });
    const r = await new NearTestnetExecutor({ engine, client: pending }).execute(id);
    expect(r.status).toBe("pending");
    expect((await engine.getReservation(id))?.transactionReference).toBe("RealHash");
    const attacker = fakeClient({ transactionStatus: async (h: string) => ({ status: { Failure: {} }, transaction_outcome: { id: h } }) });
    const res = await new NearTestnetExecutor({ engine, client: attacker }).reconcile(id, "SomeOtherFailedTx");
    expect(res).toMatchObject({ status: "refused", reasonCode: "TRANSACTION_MISMATCH" });
    const stored = await engine.getReservation(id);
    expect(stored?.status).toBe("submitted");
    expect(stored?.transactionReference).toBe("RealHash");
  });

  it("classifies FinalExecutionStatus values", () => {
    expect(classifyStatus({ SuccessValue: "" })).toBe("confirmed");
    expect(classifyStatus({ Failure: {} })).toBe("failed");
    expect(classifyStatus("NotStarted")).toBe("pending");
    expect(classifyStatus("Started")).toBe("pending");
    expect(classifyStatus(undefined)).toBe("pending");
  });
});

describe("nearTestnetConfigFromEnv", () => {
  const key = `ed25519:${"3".repeat(80)}`;
  it("is disabled by default", () => {
    expect(nearTestnetConfigFromEnv({}).ok).toBe(false);
    expect(nearTestnetConfigFromEnv({ NEAR_TESTNET_ACCOUNT_ID: "a.testnet", NEAR_TESTNET_PRIVATE_KEY: key }).ok).toBe(false);
  });
  it("requires credentials, a key-shaped secret and an https non-mainnet RPC", () => {
    const base = { AGENTGUARD_NEAR_EXECUTION: "testnet", NEAR_TESTNET_ACCOUNT_ID: "a.testnet", NEAR_TESTNET_PRIVATE_KEY: key };
    expect(nearTestnetConfigFromEnv(base).ok).toBe(true);
    expect(nearTestnetConfigFromEnv({ ...base, NEAR_TESTNET_PRIVATE_KEY: "word word word" }).ok).toBe(false);
    expect(nearTestnetConfigFromEnv({ ...base, NEAR_TESTNET_RPC_URL: "http://rpc.testnet.example" }).ok).toBe(false);
    expect(nearTestnetConfigFromEnv({ ...base, NEAR_TESTNET_RPC_URL: "https://rpc.mainnet.near.org" }).ok).toBe(false);
    const r = nearTestnetConfigFromEnv(base);
    if (r.ok) expect(JSON.stringify(r.config)).not.toContain(key);
  });
});
