/** @drainproof/near is an optional peer dependency: a missing package must give a clear usage error. */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { main, type CliIO } from "../src/main.js";

vi.mock("@drainproof/near", () => {
  throw new Error("Cannot find package '@drainproof/near'");
});

it("explains how to fix a NEAR integration whose package is not installed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "drainproof-nonear-"));
  let out = "";
  let err = "";
  const io: CliIO = { stdout: (s) => (out += s), stderr: (s) => (err += s), cwd: dir, env: {}, color: false };
  expect(await main(["init"], io)).toBe(0);
  // Without the integration, the CLI works even though the package is "missing".
  expect(await main(["test", "--no-save", "--scenario", "negative-amount"], io)).toBe(0);
  const cfg = path.join(dir, "drainproof.yaml");
  await writeFile(cfg, `${await readFile(cfg, "utf8")}integrations:\n  near:\n    validate_account_ids: true\n`);
  out = "";
  expect(await main(["test", "--no-save"], io)).toBe(2);
  expect(err).toMatch(/@drainproof\/near package is not installed/);
  expect(out).not.toMatch(/Result:/);
});
