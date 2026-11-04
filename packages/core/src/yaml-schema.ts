import { LineCounter, parseDocument, isNode } from "yaml";
import type { z } from "zod";

export interface ConfigIssue {
  /** Dotted path to the offending field, e.g. `limits.max_daily_spend`. Empty for document-level issues. */
  path: string;
  message: string;
  source: string;
  line?: number;
  column?: number;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: ConfigIssue[] };

/** Hard cap on configuration document size (bytes) to bound parser work. */
export const MAX_CONFIG_BYTES = 512 * 1024;

/**
 * Parse a YAML document and validate it against a zod schema. Issues carry the
 * source file name and, where the node can be located, the line/column.
 *
 * Duplicate keys, YAML syntax errors and excessive alias expansion are rejected.
 * Only the YAML 1.2 core schema is used (no custom tags, no code execution).
 */
export function parseYamlWithSchema<S extends z.ZodType>(
  text: string,
  schema: S,
  source: string,
): ParseResult<z.output<S>> {
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
    return { ok: false, issues: [{ path: "", message: `file exceeds ${MAX_CONFIG_BYTES} bytes`, source }] };
  }
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, {
    lineCounter,
    uniqueKeys: true,
    prettyErrors: true,
    schema: "core",
    strict: true,
  });
  if (doc.errors.length > 0) {
    return {
      ok: false,
      issues: doc.errors.map((e) => ({
        path: "",
        message: e.message.split("\n")[0] ?? e.message,
        source,
        ...(e.linePos?.[0] ? { line: e.linePos[0].line, column: e.linePos[0].col } : {}),
      })),
    };
  }
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 50 });
  } catch (err) {
    return { ok: false, issues: [{ path: "", message: `could not read YAML: ${(err as Error).message}`, source }] };
  }
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, value: result.data };

  const issues: ConfigIssue[] = [];
  for (const issue of result.error.issues) {
    const basePath = issue.path.filter((p): p is string | number => typeof p !== "symbol");
    const extraKeys = issue.code === "unrecognized_keys" ? issue.keys : [undefined];
    for (const key of extraKeys) {
      const path = key === undefined ? basePath : [...basePath, key];
      const pos = locate(doc, lineCounter, path);
      issues.push({
        path: path.join("."),
        message: key === undefined ? issue.message : `unknown field "${key}" is not supported`,
        source,
        ...pos,
      });
    }
  }
  return { ok: false, issues };
}

function locate(
  doc: ReturnType<typeof parseDocument>,
  lineCounter: LineCounter,
  path: (string | number)[],
): { line?: number; column?: number } {
  // Walk up the path until a node can be found (missing fields point at their parent).
  for (let i = path.length; i >= 0; i--) {
    const node: unknown = i === 0 ? doc.contents : doc.getIn(path.slice(0, i), true);
    if (isNode(node) && node.range) {
      const { line, col } = lineCounter.linePos(node.range[0]);
      return { line, column: col };
    }
  }
  return {};
}

export function formatIssue(issue: ConfigIssue): string {
  const loc = issue.line !== undefined ? `${issue.source}:${issue.line}:${issue.column ?? 1}` : issue.source;
  return `${loc}${issue.path ? ` ${issue.path}` : ""}: ${issue.message}`;
}
