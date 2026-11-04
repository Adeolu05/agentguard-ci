import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseYamlWithSchema, policyFromYaml, type ConfigIssue, type Policy } from "@agentguard/core";

export const PROJECT_FILE = "agentguard.yaml";

export const projectSchema = z.strictObject({
  version: z.literal(1, { error: "only project config version 1 is supported" }),
  name: z.string().min(1).max(120).optional(),
  /** Path to the policy file, relative to the project file. */
  policy: z.string().min(1),
  /** Scenario directories, relative to the project file. */
  scenarios: z.array(z.string().min(1)).min(1),
  target: z
    .strictObject({
      type: z.enum(["engine", "module"]),
      /** For `type: module`: path to an ES module exporting `createTarget`. */
      module: z.string().min(1).optional(),
    })
    .refine((t) => (t.type === "module") === (t.module !== undefined), {
      message: "`module` is required when type is module, and only allowed then",
    })
    .default({ type: "engine" }),
  integrations: z
    .strictObject({
      near: z.strictObject({ validate_account_ids: z.boolean() }).optional(),
    })
    .default({}),
  reports: z.strictObject({ dir: z.string().min(1).default(".agentguard/runs") }).default({ dir: ".agentguard/runs" }),
});
export type ProjectConfig = z.output<typeof projectSchema>;

export interface LoadedProject {
  root: string;
  configPath: string;
  config: ProjectConfig;
  /** Policy path relative to the project root. */
  policyFile: string;
  policy: Policy;
  policyWarnings: ConfigIssue[];
}

export type ProjectLoadResult = { ok: true; project: LoadedProject } | { ok: false; issues: ConfigIssue[] };

export async function loadPolicyFile(absPath: string, displayName: string) {
  let text: string;
  try {
    text = await readFile(absPath, "utf8");
  } catch (err) {
    return {
      ok: false as const,
      issues: [{ path: "", message: `cannot read policy: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`, source: displayName }],
    };
  }
  return policyFromYaml(text, displayName);
}

export async function loadProject(configPath: string): Promise<ProjectLoadResult> {
  const abs = path.resolve(configPath);
  const root = path.dirname(abs);
  const display = path.basename(abs);
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      issues: [
        {
          path: "",
          message: code === "ENOENT" ? "project file not found; run `agentguard init` to create one" : `cannot read: ${code ?? String(err)}`,
          source: display,
        },
      ],
    };
  }
  const parsed = parseYamlWithSchema(text, projectSchema, display);
  if (!parsed.ok) return parsed;
  const config = parsed.value;
  const policyAbs = path.resolve(root, config.policy);
  const policyFile = path.relative(root, policyAbs).split(path.sep).join("/");
  const loaded = await loadPolicyFile(policyAbs, policyFile);
  if (!loaded.ok) return loaded;
  return {
    ok: true,
    project: { root, configPath: abs, config, policyFile, policy: loaded.policy, policyWarnings: loaded.warnings },
  };
}
