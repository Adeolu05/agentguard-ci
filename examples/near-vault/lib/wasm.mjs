import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Where `pnpm build:vault` (cargo near build non-reproducible-wasm) writes the contract. */
export const WASM_PATH = fileURLToPath(new URL("../../../contracts/vault/target/near/agentguard_vault.wasm", import.meta.url));

export async function loadWasm() {
  try {
    return await readFile(WASM_PATH);
  } catch {
    throw new Error(`Vault wasm not found at ${WASM_PATH}. Build it first: pnpm build:vault (needs Rust and cargo-near).`);
  }
}
