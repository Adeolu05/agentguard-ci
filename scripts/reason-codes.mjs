// Generates the reason-code table in docs/policy-schema.md from packages/core/src/reasons.ts.
//   node scripts/reason-codes.mjs          print the table
//   node scripts/reason-codes.mjs --write  update docs/policy-schema.md in place
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const START = "<!-- reason-codes:start -->";
export const END = "<!-- reason-codes:end -->";

export function reasonCodesTable(reasons) {
  const rows = Object.entries(reasons).map(
    ([code, r]) => `| \`${code}\` | ${r.category} | ${r.blocking ? "yes" : "no"} | ${r.summary} |`,
  );
  return ["| Code | Category | Blocking | Meaning |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

export function replaceBlock(doc, table) {
  const a = doc.indexOf(START);
  const b = doc.indexOf(END);
  if (a < 0 || b < a) throw new Error("reason-code markers not found");
  return `${doc.slice(0, a + START.length)}\n${table}\n${doc.slice(b)}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { REASONS } = await import("../packages/core/dist/reasons.js");
  const table = reasonCodesTable(REASONS);
  if (process.argv.includes("--write")) {
    const file = fileURLToPath(new URL("../docs/policy-schema.md", import.meta.url));
    writeFileSync(file, replaceBlock(readFileSync(file, "utf8"), table));
    console.log(`updated ${file}`);
  } else {
    console.log(table);
  }
}
