// Sandbox integration tests for the Drainproof Vault. Not part of the default `pnpm test`:
// they need the contract wasm (built with Rust and cargo-near) and download the NEAR
// sandbox node on first run. Run them with `pnpm test:vault` from the repository root.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 240_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
