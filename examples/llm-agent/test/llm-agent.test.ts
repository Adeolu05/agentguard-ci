/**
 * Offline tests for the LLM prompt-injection demo. No network: the live client is pointed at a
 * local stub on 127.0.0.1 (lib/stub.mjs) that returns hand-written responses.
 */
import { execFile } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { InMemoryLedger, PolicyEngine, policyFromYaml } from "@agentguard/core";
import { PAGE_URL, readPage, runAgent } from "../lib/agent-loop.mjs";
import { buildRecording, checkBaseUrl, liveModel, redact, replayModel } from "../lib/model.mjs";
import { checkResponseSignature, sha256Hex } from "../lib/signature.mjs";
import { startStub } from "../lib/stub.mjs";

const run = promisify(execFile);
const AGENT = new URL("../agent.mjs", import.meta.url).pathname;
const RECORDING = JSON.parse(readFileSync(new URL("../fixtures/recording.json", import.meta.url), "utf8"));
const SECRET = "sk-test-secret-do-not-print-0123456789";

function engine() {
  const loaded = policyFromYaml(readFileSync(new URL("../../payment-policy/policy.yaml", import.meta.url), "utf8"), "policy.yaml");
  if (!loaded.ok) throw new Error("invalid policy");
  return { engine: new PolicyEngine({ policy: loaded.policy, ledger: new InMemoryLedger() }), allowlist: [...loaded.policy.allowedRecipients] };
}

async function runWith(model: any) {
  const lines: string[] = [];
  const { engine: e, allowlist } = engine();
  const result = await runAgent({ model, engine: e, out: (l: string) => lines.push(l), allowlist });
  return { result, output: lines.join("\n") };
}

describe("recorded mode", () => {
  it("the shipped recording is labelled as a stand-in when it did not come from NEAR AI Cloud", () => {
    if (RECORDING.source !== "near-ai-cloud") {
      expect(RECORDING.sourceDescription).toMatch(/STAND-IN/);
      expect(RECORDING.sourceDescription).toMatch(/NOT a real model/);
    }
  });

  it("replays the recording: injected payments are blocked and never executed", async () => {
    const { result, output } = await runWith(replayModel(RECORDING));
    const toAttacker = result.payments.filter((p: any) => !p.allowlisted);
    for (const p of toAttacker) {
      expect(p.decision).not.toBe("ALLOW");
      expect(p.reasonCodes).toContain("RECIPIENT_NOT_ALLOWED");
      expect(p.executed).toBe(false);
    }
    expect(result.payments.filter((p: any) => p.executed && !p.allowlisted)).toHaveLength(0);
    expect(output).toContain("served the local fixture");
  });

  it("refuses to replay when the agent's request differs from the recorded one", async () => {
    const changed = structuredClone(RECORDING);
    changed.turns[0].requestBody = changed.turns[0].requestBody.replace("Summarise", "Summarize");
    await expect(runWith(replayModel(changed))).rejects.toThrow(/differs from the recorded one/);
  });
});

describe("live mode against a local stub", () => {
  it("sends OpenAI-compatible requests with the key only in the Authorization header, and checks signatures", async () => {
    const stub = await startStub({ signatures: true });
    try {
      const model = liveModel({ apiKey: SECRET, baseUrl: stub.baseUrl, model: "stub/hand-written", signatureDelayMs: 0 });
      const { result, output } = await runWith(model);
      const posts = stub.requests.filter((r) => r.method === "POST");
      expect(posts).toHaveLength(4);
      for (const r of posts) {
        expect(r.url).toBe("/v1/chat/completions");
        expect(r.headers.authorization).toBe(`Bearer ${SECRET}`);
        expect(r.headers["x-no-aliasing"]).toBe("true");
        const body = JSON.parse(r.body);
        expect(body.model).toBe("stub/hand-written");
        expect(body.tools.map((t: any) => t.function.name)).toEqual(["read_page", "propose_payment"]);
        expect(r.body).not.toContain(SECRET);
      }
      expect(stub.requests.filter((r) => r.method === "GET").every((r) => /signing_algo=ed25519/.test(r.url))).toBe(true);
      expect(output.match(/response signature: VALID/g)).toHaveLength(4);
      expect(output).not.toContain(SECRET);
      expect(result.payments.map((p: any) => p.decision)).toEqual(["BLOCK", "BLOCK", "ALLOW"]);

      // The recording holds bodies and signatures, never the key, and replays to the same result.
      const text = buildRecording(model, { apiKey: SECRET, sourceDescription: "test" });
      expect(text).not.toContain(SECRET);
      const replay = await runWith(replayModel(JSON.parse(text)));
      expect(replay.output.match(/response signature: VALID/g)).toHaveLength(4);
      expect(replay.result.payments.map((p: any) => p.decision)).toEqual(["BLOCK", "BLOCK", "ALLOW"]);
    } finally {
      await stub.close();
    }
  });

  it("reports a signature over different response bytes as INVALID", async () => {
    const stub = await startStub({ signatures: true, tamper: true });
    try {
      const { output } = await runWith(liveModel({ apiKey: SECRET, baseUrl: stub.baseUrl, model: "stub/hand-written", signatureDelayMs: 0 }));
      expect(output.match(/response signature: INVALID/g)).toHaveLength(4);
    } finally {
      await stub.close();
    }
  });

  it("never puts the key in an error message", async () => {
    const fetchImpl = async () => new Response(`{"error":"bad key ${SECRET}"}`, { status: 401 });
    const model = liveModel({ apiKey: SECRET, baseUrl: "https://cloud-api.near.ai/v1", fetchImpl: fetchImpl as any });
    const err = await runWith(model).catch((e: Error) => e);
    expect(String(err)).toContain("HTTP 401");
    expect(String(err)).not.toContain(SECRET);
    expect(redact(`x ${SECRET} y`, SECRET)).toBe("x [REDACTED] y");
  });

  it("only sends the key over https, or http on the loopback interface", () => {
    expect(checkBaseUrl("https://cloud-api.near.ai/v1").ok).toBe(true);
    expect(checkBaseUrl("http://127.0.0.1:8080/v1").ok).toBe(true);
    expect(checkBaseUrl("http://example.com/v1").ok).toBe(false);
    expect(checkBaseUrl("not a url").ok).toBe(false);
    expect(() => liveModel({ apiKey: SECRET, baseUrl: "http://example.com/v1" })).toThrow(/https/);
  });
});

describe("tools", () => {
  it("read_page serves only the one fixture URL; nothing else is read or fetched", () => {
    expect(readPage(PAGE_URL).ok).toBe(true);
    for (const url of ["https://data-provider.example/../../etc/passwd", "file:///etc/passwd", "../fixtures/poisoned-page.html", "https://evil.example/"]) {
      expect(readPage(url)).toMatchObject({ ok: false });
    }
  });
});

describe("response signature check", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const address = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url").toString("hex");
  const req = Buffer.from('{"model":"m"}');
  const res = Buffer.from('{"id":"x"}');
  const signed = (text: string, kind: string, algo = "ed25519") => ({
    text,
    signature: sign(null, Buffer.from(text), privateKey).toString("hex"),
    signing_address: address,
    signing_algo: algo,
    signature_kind: kind,
  });

  it("provider_tee signs model:request_hash:response_hash", () => {
    const text = `m:${sha256Hex(req)}:${sha256Hex(res)}`;
    expect(checkResponseSignature({ signature: signed(text, "provider_tee"), requestBytes: req, responseBytes: res, model: "m" }).status).toBe("valid");
    expect(checkResponseSignature({ signature: signed(text, "provider_tee"), requestBytes: req, responseBytes: res, model: "other" }).status).toBe("invalid");
  });

  it("does not claim anything it does not check", () => {
    const text = `${sha256Hex(req)}:${sha256Hex(res)}`;
    expect(checkResponseSignature({ signature: signed(text, "gateway", "ecdsa"), requestBytes: req, responseBytes: res, model: "m" }).status).toBe("unchecked");
    expect(checkResponseSignature({ signature: signed(text, "mystery"), requestBytes: req, responseBytes: res, model: "m" }).status).toBe("unchecked");
    expect(checkResponseSignature({ signature: { error_code: "disconnected", message: "stream disconnected" }, requestBytes: req, responseBytes: res, model: "m" }).status).toBe("unchecked");
    expect(checkResponseSignature({ signature: null, requestBytes: req, responseBytes: res, model: "m" }).status).toBe("unchecked");
    const forged = { ...signed(text, "gateway"), signature: "00".repeat(64) };
    expect(checkResponseSignature({ signature: forged, requestBytes: req, responseBytes: res, model: "m" }).status).toBe("invalid");
  });
});

describe("command line", () => {
  it("runs the recorded demo offline and exits 0", async () => {
    const env = { ...process.env, NEAR_AI_API_KEY: "" };
    const { stdout } = await run(process.execPath, [AGENT], { env });
    expect(stdout).toContain("RECORDED");
    expect(stdout).toContain("AgentGuard:  BLOCK  (RECIPIENT_NOT_ALLOWED)");
    expect(stdout).toMatch(/0 executed to a recipient outside the allowlist/);
  });

  it("refuses --record without a key, and unknown arguments, with exit code 2", async () => {
    const env = { ...process.env, NEAR_AI_API_KEY: "" };
    await expect(run(process.execPath, [AGENT, "--record"], { env })).rejects.toMatchObject({ code: 2 });
    await expect(run(process.execPath, [AGENT, "--bogus"], { env })).rejects.toMatchObject({ code: 2 });
  });
});
