// NEAR testnet demonstration.
//
// Default (no configuration): proposals are validated and evaluated locally. Nothing is
// signed or sent, and the output says so.
//
// Real testnet execution happens only when you opt in with a TESTNET account you control:
//   AGENTGUARD_NEAR_EXECUTION=testnet \
//   NEAR_TESTNET_ACCOUNT_ID=<you>.testnet \
//   NEAR_TESTNET_PRIVATE_KEY=ed25519:<testnet key> \
//   RECIPIENT=<an existing testnet account you added to policy.yaml> \
//   node demo.mjs
// The allowed proposal then goes through the AgentGuard execution gate, is broadcast with
// near-api-js, and its status is re-read from the RPC by transaction hash.
import { readFile } from "node:fs/promises";
import { InMemoryLedger, PolicyEngine, policyFromYaml } from "@agentguard/core";
import {
  NearTestnetExecutor,
  createNearTestnetClient,
  nearAccountIdValidator,
  nearTestnetConfigFromEnv,
} from "@agentguard/near";

const loaded = policyFromYaml(await readFile(new URL("./policy.yaml", import.meta.url), "utf8"), "policy.yaml");
if (!loaded.ok) {
  console.error(loaded.issues);
  process.exit(2);
}
const engine = new PolicyEngine({ policy: loaded.policy, ledger: new InMemoryLedger(), validators: [nearAccountIdValidator()] });
const recipient = process.env.RECIPIENT ?? "merchant-example.testnet";
if (!loaded.policy.allowedRecipients.has(recipient)) {
  console.error(`RECIPIENT "${recipient}" is not in recipients.allowed in policy.yaml. Add it there first: the demo will not change the policy for you.`);
  process.exit(2);
}
const base = { agentId: "near-research-agent", assetId: "NEAR", networkId: "near-testnet" };

const proposals = [
  { label: "over the per-transaction limit", p: { ...base, requestId: `demo-over-${Date.now()}`, amount: "5", recipientId: recipient } },
  { label: "mainnet account on testnet", p: { ...base, requestId: `demo-wrongnet-${Date.now()}`, amount: "0.01", recipientId: "merchant-example.near" } },
  { label: "within policy", p: { ...base, requestId: `demo-ok-${Date.now()}`, amount: "0.01", recipientId: recipient } },
];

const env = nearTestnetConfigFromEnv();
const executor = env.ok
  ? new NearTestnetExecutor({ engine, client: await createNearTestnetClient(env.config, env.privateKey) })
  : undefined;
console.log(executor ? `Testnet execution ENABLED (signer ${env.config.accountId}, RPC ${env.config.rpcUrl})` : `Simulation only: ${env.reason}`);

for (const { label, p } of proposals) {
  const e = await engine.authorize(p);
  console.log(`\n▶ ${label}: ${p.amount} NEAR → ${p.recipientId}`);
  console.log(`  AgentGuard: ${e.decision}${e.reasonCodes.length ? ` (${e.reasonCodes.join(", ")})` : ""}`);
  if (e.decision !== "ALLOW") {
    console.log("  Stopped before the execution boundary.");
    continue;
  }
  if (!executor) {
    console.log("  Would proceed to execution. Testnet execution is not enabled, so no transaction was signed or sent.");
    continue;
  }
  const result = await executor.execute(e.reservation.reservationId);
  console.log(`  Execution: ${result.status}: ${result.message}`);
  if (result.transactionHash) {
    console.log(`  Transaction hash (from the network): ${result.transactionHash}`);
    const check = await executor.reconcile(e.reservation.reservationId, result.transactionHash);
    console.log(`  Status re-read from RPC: ${check.status}`);
  }
}
