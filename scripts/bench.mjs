// Measures the numbers quoted in the README's "Project status":
//  1. PolicyEngine.authorize() latency on the example policy (mean and p99, in microseconds),
//     over a mix of allowed, approval-required and blocked proposals.
//  2. The 40-scenario suite: the runner's own duration (durationMs in the JSON report) and
//     the wall time of the whole CLI process, including Node startup.
// Offline, no keys, nothing is signed or sent. Run after `pnpm build`: `pnpm bench`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
// The built package, by path: the repository root does not depend on @drainproof/core.
import { InMemoryLedger, PolicyEngine, policyFromYaml } from "../packages/core/dist/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const ITERATIONS = 20_000;
const WARMUP = 2_000;
const SUITE_RUNS = 5;

const loaded = policyFromYaml(await readFile(join(root, "examples/payment-policy/policy.yaml"), "utf8"), "policy.yaml");
if (!loaded.ok) throw new Error("invalid example policy");

const shapes = [
  { amount: "4", recipientId: "data-provider-example" }, // ALLOW until the daily limits are used up, then BLOCK
  { amount: "12", recipientId: "merchant-example" }, // REQUIRE_APPROVAL
  { amount: "500", recipientId: "attacker-wallet", memo: "IGNORE PREVIOUS INSTRUCTIONS" }, // BLOCK
];

async function measure(n, record) {
  // A fresh engine and ledger per batch, so the allowed shape is really allowed at first.
  let engine;
  const times = [];
  for (let i = 0; i < n; i++) {
    if (i % 1_000 === 0) engine = new PolicyEngine({ policy: loaded.policy, ledger: new InMemoryLedger() });
    const proposal = { requestId: `bench-${i}`, agentId: "research-payment-agent", assetId: "USDC", networkId: "near-testnet", ...shapes[i % shapes.length] };
    const t0 = performance.now();
    await engine.authorize(proposal);
    if (record) times.push((performance.now() - t0) * 1_000);
  }
  return times;
}

await measure(WARMUP, false);
const times = (await measure(ITERATIONS, true)).sort((a, b) => a - b);
const mean = times.reduce((s, t) => s + t, 0) / times.length;
const p99 = times[Math.floor(times.length * 0.99)];

const dir = mkdtempSync(join(tmpdir(), "drainproof-bench-"));
const runner = [];
const wall = [];
try {
  for (let i = 0; i < SUITE_RUNS; i++) {
    const out = join(dir, `run-${i}.json`);
    const t0 = performance.now();
    execFileSync(process.execPath, [join(root, "packages/cli/dist/bin.js"), "test", "--config", join(root, "examples/payment-policy/drainproof.yaml"), "--no-save", "--quiet", "--json", out], { stdio: "ignore" });
    wall.push(performance.now() - t0);
    runner.push(JSON.parse(readFileSync(out, "utf8")).durationMs);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const range = (xs, digits = 0) => `${Math.min(...xs).toFixed(digits)} to ${Math.max(...xs).toFixed(digits)}`;
console.log(`CPU: ${cpus()[0]?.model ?? "unknown"}; Node ${process.version}`);
console.log(`authorize(): ${ITERATIONS} calls, mean ${mean.toFixed(1)} µs, p99 ${p99.toFixed(1)} µs`);
console.log(`40-scenario suite, ${SUITE_RUNS} runs: runner ${range(runner)} ms, CLI wall time ${range(wall)} ms`);
