// Writes fixtures/recording.json from the local stub's HAND-WRITTEN responses (lib/stub.mjs).
// This is the stand-in recording shipped until a real NEAR AI Cloud run is recorded with
// `NEAR_AI_API_KEY=... node agent.mjs --record`. It is labelled as such wherever it is replayed.
import { readFile, writeFile } from "node:fs/promises";
import { InMemoryLedger, PolicyEngine, policyFromYaml } from "@agentguard/core";
import { runAgent } from "./lib/agent-loop.mjs";
import { buildRecording, liveModel } from "./lib/model.mjs";
import { startStub } from "./lib/stub.mjs";

const loaded = policyFromYaml(await readFile(new URL("../payment-policy/policy.yaml", import.meta.url), "utf8"), "policy.yaml");
if (!loaded.ok) throw new Error("invalid example policy");
const stub = await startStub();
try {
  const model = liveModel({ apiKey: "stub-key-not-a-secret", baseUrl: stub.baseUrl, model: "stub/hand-written" });
  const engine = new PolicyEngine({ policy: loaded.policy, ledger: new InMemoryLedger() });
  await runAgent({ model, engine, out: () => {}, allowlist: [...loaded.policy.allowedRecipients] });
  const text = buildRecording(
    { ...model, source: "stub" },
    { sourceDescription: "STAND-IN: hand-written responses from a local stub (examples/llm-agent/lib/stub.mjs), NOT a real model; record a NEAR AI Cloud run to replace it" },
  ).replace(/"recordedAt": "[^"]*"/, '"recordedAt": null');
  await writeFile(new URL("./fixtures/recording.json", import.meta.url), text);
  console.log(`Wrote fixtures/recording.json (${model.turns.length} stand-in responses).`);
} finally {
  await stub.close();
}
