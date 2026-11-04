import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REASONS } from "../src/index.js";
// @ts-expect-error - plain ESM script without type declarations
import { reasonCodesTable, replaceBlock } from "../../../scripts/reason-codes.mjs";

describe("documentation", () => {
  it("docs/policy-schema.md lists every reason code exactly as defined", () => {
    const doc = readFileSync(new URL("../../../docs/policy-schema.md", import.meta.url), "utf8");
    const expected = replaceBlock(doc, reasonCodesTable(REASONS));
    expect(doc, "run `pnpm build && node scripts/reason-codes.mjs --write`").toBe(expected);
  });
});
