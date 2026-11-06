import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@drainproof/core": src("core"),
      "@drainproof/runner": src("runner"),
      "@drainproof/near": src("near"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts", "apps/web/lib/**/*.test.ts", "examples/llm-agent/test/**/*.test.ts", "examples/recipient-checks/test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
