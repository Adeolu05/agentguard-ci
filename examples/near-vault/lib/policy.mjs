import { readFile } from "node:fs/promises";
import { policyFromYaml } from "@agentguard/core";
import { vaultPolicyFromPolicy } from "@agentguard/near";
import { Refusal } from "./testnet.mjs";

export const DEFAULT_POLICY_FILE = new URL("../policy.yaml", import.meta.url);

/** Loads a YAML policy and converts it exactly to the vault's policy, or refuses. */
export async function loadVaultPolicy(file = DEFAULT_POLICY_FILE) {
  let yaml;
  try {
    yaml = await readFile(file, "utf8");
  } catch (err) {
    throw new Refusal(`cannot read the policy file ${file}: ${err.message}`);
  }
  const loaded = policyFromYaml(yaml, String(file));
  if (!loaded.ok) {
    throw new Refusal(`invalid policy: ${loaded.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  }
  const converted = vaultPolicyFromPolicy(loaded.policy);
  if (!converted.ok) {
    throw new Refusal(`the policy cannot be represented exactly in the vault:\n  - ${converted.issues.join("\n  - ")}`);
  }
  return { policy: loaded.policy, vaultPolicy: converted.policy };
}
