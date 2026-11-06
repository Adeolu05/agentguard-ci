// NEAR testnet demonstration.
//
// Default (no configuration): proposals are validated and evaluated locally. Nothing is
// signed or sent, and the output says so.
//
// Real testnet execution happens only when you opt in with a TESTNET account you control:
//   DRAINPROOF_NEAR_EXECUTION=testnet \
//   NEAR_TESTNET_ACCOUNT_ID=<you>.testnet \
//   NEAR_TESTNET_PRIVATE_KEY=ed25519:<testnet key> \
//   RECIPIENT=<an existing testnet account you added to policy.yaml> \
//   node demo.mjs
// The allowed proposal then goes through the Drainproof execution gate and is broadcast with
// near-api-js. For each executed transfer the demo prints the transaction hash exactly as the
// network returned it, a NearBlocks testnet explorer link and the final status, then re-reads
// the status from the RPC by hash (read-only). An ambiguous outcome is reported as UNKNOWN.
// Step-by-step guide: docs/testnet-run.md
import { readFile } from "node:fs/promises";
import { InMemoryLedger, PolicyEngine, policyFromYaml } from "@drainproof/core";
import {
  NearTestnetExecutor,
  createNearTestnetClient,
  describeExecution,
  nearAccountIdValidator,
  nearTestnetConfigFromEnv,
} from "@drainproof/near";

const loaded = policyFromYaml(await readFile(new URL("./policy.yaml", import.meta.url), "utf8"), "policy.yaml");
if (!loaded.ok) {
  console.error(loaded.issues);
  process.exit(2);
}
const engine = new PolicyEngine({ policy: loaded.policy, ledger: new InMemoryLedger(), validators: [nearAccountIdValidator()] });
const env = nearTestnetConfigFromEnv();
// A real transfer needs a recipient you chose: never fall back to the placeholder account.
if (env.ok && !process.env.RECIPIENT) {
  console.error("Testnet execution is enabled, so RECIPIENT must be set to an existing testnet account that is in recipients.allowed in policy.yaml.");
  process.exit(2);
}
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

const executor = env.ok
  ? new NearTestnetExecutor({ engine, client: await createNearTestnetClient(env.config, env.privateKey) })
  : undefined;
console.log(executor ? `Testnet execution ENABLED (signer ${env.config.accountId}, RPC ${env.config.rpcUrl})` : `Simulation only: ${env.reason}`);

for (const { label, p } of proposals) {
  const e = await engine.authorize(p);
  console.log(`\n▶ ${label}: ${p.amount} NEAR → ${p.recipientId}`);
  console.log(`  Drainproof: ${e.decision}${e.reasonCodes.length ? ` (${e.reasonCodes.join(", ")})` : ""}`);
  if (e.decision !== "ALLOW") {
    console.log("  Stopped before the execution boundary.");
    continue;
  }
  if (!executor) {
    console.log("  Would proceed to execution. Testnet execution is not enabled, so no transaction was signed or sent.");
    continue;
  }
  const result = await executor.execute(e.reservation.reservationId);
  // Read-only re-check by hash (never changes the ledger), only for a hash the network returned.
  const check = result.transactionHash ? await executor.checkStatus(result.transactionHash) : undefined;
  for (const line of describeExecution(result, check)) console.log(`  ${line}`);
}
