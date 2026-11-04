import { readFileSync } from "node:fs";
import { appendFile, cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { formatIssue, type ConfigIssue, type ProposalValidator } from "@agentguard/core";
import {
  EXIT_CODES,
  PROJECT_FILE,
  SCENARIO_CATEGORIES,
  formatScenarioLine,
  formatSummary,
  loadModuleTarget,
  loadPolicyFile,
  loadProject,
  loadScenarios,
  patchPolicy,
  redactString,
  renderMarkdown,
  runReportSchema,
  runSuite,
  secretsFromEnv,
  selectScenarios,
  type LoadedProject,
  type RunReport,
} from "@agentguard/runner";

export interface CliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  color: boolean;
}

const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));

export const VERSION: string = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string }
).version;

class UsageError extends Error {}

const HELP = `AgentGuard CI ${VERSION}
Test whether an AI agent's proposed financial actions comply with explicit transaction policies.

Usage:
  agentguard init [dir] [--force] [--github-actions]
  agentguard policy validate [policy.yaml] [--config <file>]
  agentguard scenarios validate [--config <file>]
  agentguard scenarios list [--category <c>] [--config <file>]
  agentguard test [--scenario <id>]... [--category <c>]... [options]
  agentguard report [--run <id>] [--format markdown|json] [--output <file>] [--config <file>]

Test options:
  --config <file>        Project file (default: ./${PROJECT_FILE})
  --scenario <id>        Run only this scenario (repeatable)
  --category <name>      Run only this category (repeatable): ${SCENARIO_CATEGORIES.join(", ")}
  --json <file>          Also write the JSON report to <file>
  --markdown <file>      Also write the Markdown report to <file>
  --github-summary       Append the Markdown report to $GITHUB_STEP_SUMMARY
  --no-save              Do not store the run in the reports directory
  --quiet                Only print failures, errors and the summary
  --no-color             Disable coloured output (also honours NO_COLOR)

Exit codes:
  0  all required scenarios passed
  1  at least one required scenario failed
  2  configuration, scenario validation or usage error (nothing was run)
  3  run incomplete: a required scenario errored, or nothing could be evaluated

Docs: docs/cli.md, docs/policy-schema.md, docs/scenarios.md, docs/limitations.md
`;

type ParsedValues = Record<string, string | boolean | string[] | undefined>;

function parse(
  args: string[],
  options: ParseArgsConfig["options"],
  allowPositionals = 0,
): { values: ParsedValues; positionals: string[] } {
  try {
    const r = parseArgs({ args, options: { ...options, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true });
    if (r.positionals.length > allowPositionals) throw new UsageError(`unexpected argument: ${r.positionals[allowPositionals]}`);
    return { values: r.values as ParsedValues, positionals: r.positionals };
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError((err as Error).message);
  }
}

function printIssues(io: CliIO, issues: readonly ConfigIssue[]): void {
  for (const i of issues) io.stderr(`  ✗ ${formatIssue(i)}\n`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function requireProject(io: CliIO, configArg: string | undefined): Promise<LoadedProject | undefined> {
  const configPath = path.resolve(io.cwd, configArg ?? PROJECT_FILE);
  const r = await loadProject(configPath);
  if (!r.ok) {
    io.stderr("Project configuration is invalid:\n");
    printIssues(io, r.issues);
    return undefined;
  }
  return r.project;
}

async function integrationValidators(project: LoadedProject): Promise<{ validators: ProposalValidator[]; names: string[] }> {
  const validators: ProposalValidator[] = [];
  const names: string[] = [];
  if (project.config.integrations.near?.validate_account_ids) {
    const near = await import("@agentguard/near");
    validators.push(near.nearAccountIdValidator());
    names.push("near:account-id-validation");
  }
  return { validators, names };
}

// ─── init ────────────────────────────────────────────────────────────────────

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(path.relative(base, full));
  }
  return out.sort();
}

async function cmdInit(io: CliIO, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { force: { type: "boolean" }, "github-actions": { type: "boolean" } }, 1);
  if (values.help) return (io.stdout(HELP), 0);
  const target = path.resolve(io.cwd, positionals[0] ?? ".");
  const files = (await listFiles(TEMPLATES_DIR)).filter((f) => !f.startsWith(`github${path.sep}`));
  const conflicts = [];
  for (const f of files) if (await exists(path.join(target, f))) conflicts.push(f);
  if (conflicts.length > 0 && !values.force) {
    io.stderr(`Refusing to overwrite existing files (use --force):\n${conflicts.map((c) => `  ${c}`).join("\n")}\n`);
    return EXIT_CODES.USAGE;
  }
  await mkdir(target, { recursive: true });
  for (const f of files) {
    await mkdir(path.dirname(path.join(target, f)), { recursive: true });
    await cp(path.join(TEMPLATES_DIR, f), path.join(target, f));
  }
  const created = [...files];
  if (values["github-actions"]) {
    const wf = path.join(".github", "workflows", "agentguard.yml");
    if ((await exists(path.join(target, wf))) && !values.force) {
      io.stderr(`Refusing to overwrite ${wf} (use --force)\n`);
      return EXIT_CODES.USAGE;
    }
    await mkdir(path.dirname(path.join(target, wf)), { recursive: true });
    await cp(path.join(TEMPLATES_DIR, "github", "agentguard.yml"), path.join(target, wf));
    created.push(wf);
  }
  io.stdout(`Initialised AgentGuard project in ${path.relative(io.cwd, target) || "."}\n`);
  const scenarioFiles = created.filter((f) => f.startsWith(`scenarios${path.sep}`));
  for (const f of created.filter((c) => !scenarioFiles.includes(c))) io.stdout(`  + ${f.split(path.sep).join("/")}\n`);
  const categories = new Set(scenarioFiles.map((f) => f.split(path.sep)[1]));
  io.stdout(`  + scenarios/ (${scenarioFiles.length} scenarios in ${categories.size} categories)\n`);
  io.stdout(`\nNext steps:\n  agentguard policy validate\n  agentguard test\n`);
  return EXIT_CODES.PASSED;
}

// ─── policy validate ─────────────────────────────────────────────────────────

async function cmdPolicyValidate(io: CliIO, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { config: { type: "string" } }, 1);
  if (values.help) return (io.stdout(HELP), 0);
  let file = positionals[0];
  if (!file) {
    const project = await requireProject(io, values.config as string | undefined);
    if (!project) return EXIT_CODES.USAGE;
    file = path.join(project.root, project.policyFile);
  }
  const abs = path.resolve(io.cwd, file);
  const display = path.relative(io.cwd, abs).split(path.sep).join("/") || abs;
  const r = await loadPolicyFile(abs, display);
  if (!r.ok) {
    io.stderr(`✗ ${display} is invalid:\n`);
    printIssues(io, r.issues);
    return EXIT_CODES.USAGE;
  }
  const p = r.policy;
  io.stdout(`✓ ${display} is valid\n`);
  io.stdout(`  agent:      ${p.agentId}\n  mode:       ${p.executionMode}\n  hash:       ${p.hash}\n`);
  io.stdout(`  assets:     ${[...p.assets.keys()].join(", ")}\n  networks:   ${[...p.allowedNetworks].join(", ") || "(none)"}\n`);
  io.stdout(`  recipients: ${p.allowedRecipients.size} allowlisted (${p.recipientMode})\n`);
  for (const w of r.warnings) io.stdout(`  ⚠ ${formatIssue(w)}\n`);
  return EXIT_CODES.PASSED;
}

// ─── scenarios ───────────────────────────────────────────────────────────────

async function loadSuite(io: CliIO, project: LoadedProject) {
  const set = await loadScenarios(project.config.scenarios, project.root);
  const issues = [...set.issues];
  // Pre-flight: scenario policy patches must produce a valid policy.
  for (const s of set.scenarios) {
    if (!s.scenario.given.policy_patch) continue;
    try {
      const r = patchPolicy(project.policy.document, s.scenario.given.policy_patch, s.file);
      if (!r.ok) issues.push(...r.issues.map((i) => ({ ...i, path: `given.policy_patch → ${i.path}` })));
    } catch (err) {
      issues.push({ path: "given.policy_patch", message: (err as Error).message, source: s.file });
    }
  }
  if (issues.length > 0) {
    io.stderr(`Scenario validation failed (${issues.length} issue${issues.length === 1 ? "" : "s"}):\n`);
    printIssues(io, issues);
    return undefined;
  }
  return set;
}

async function cmdScenarios(io: CliIO, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "validate" && sub !== "list") throw new UsageError("expected `scenarios validate` or `scenarios list`");
  const { values } = parse(rest, { config: { type: "string" }, category: { type: "string", multiple: true } });
  if (values.help) return (io.stdout(HELP), 0);
  const project = await requireProject(io, values.config as string | undefined);
  if (!project) return EXIT_CODES.USAGE;
  const set = await loadSuite(io, project);
  if (!set) return EXIT_CODES.USAGE;
  if (sub === "validate") {
    io.stdout(`✓ ${set.scenarios.length} scenarios are valid (suite ${set.suiteHash.slice(0, 19)}…)\n`);
    return EXIT_CODES.PASSED;
  }
  const categories = (values.category as string[] | undefined) ?? [];
  for (const s of selectScenarios(set.scenarios, { categories })) {
    const sc = s.scenario;
    io.stdout(`${sc.id.padEnd(44)} ${sc.category.padEnd(20)} ${sc.severity.padEnd(13)} ${sc.name}\n`);
  }
  return EXIT_CODES.PASSED;
}

// ─── test ────────────────────────────────────────────────────────────────────

async function writeReportFile(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function cmdTest(io: CliIO, args: string[]): Promise<number> {
  const { values } = parse(args, {
    config: { type: "string" },
    scenario: { type: "string", multiple: true },
    category: { type: "string", multiple: true },
    json: { type: "string" },
    markdown: { type: "string" },
    "github-summary": { type: "boolean" },
    "no-save": { type: "boolean" },
    quiet: { type: "boolean" },
    "no-color": { type: "boolean" },
  });
  if (values.help) return (io.stdout(HELP), 0);
  const style = { color: io.color && !values["no-color"] };
  const project = await requireProject(io, values.config as string | undefined);
  if (!project) return EXIT_CODES.USAGE;

  const categories = (values.category as string[] | undefined) ?? [];
  const unknownCats = categories.filter((c) => !(SCENARIO_CATEGORIES as readonly string[]).includes(c));
  if (unknownCats.length > 0) throw new UsageError(`unknown category: ${unknownCats.join(", ")}`);

  const set = await loadSuite(io, project);
  if (!set) return EXIT_CODES.USAGE;
  const scenarioIds = (values.scenario as string[] | undefined) ?? [];
  const unknownIds = scenarioIds.filter((id) => !set.scenarios.some((s) => s.scenario.id === id));
  if (unknownIds.length > 0) throw new UsageError(`unknown scenario: ${unknownIds.join(", ")}`);
  const selected = selectScenarios(set.scenarios, { scenarioIds, categories });
  if (selected.length === 0) throw new UsageError("no scenarios match the given filters");

  let target: { type: "engine" } | { type: "module"; module: string; factory: Awaited<ReturnType<typeof loadModuleTarget>> } = {
    type: "engine",
  };
  if (project.config.target.type === "module") {
    const modulePath = project.config.target.module!;
    try {
      target = { type: "module", module: modulePath, factory: await loadModuleTarget(path.resolve(project.root, modulePath)) };
    } catch (err) {
      io.stderr(`✗ Could not load target module ${modulePath}: ${(err as Error).message}\n`);
      return EXIT_CODES.ERROR;
    }
  }
  const { validators, names } = await integrationValidators(project);

  io.stdout(`AgentGuard CI ${VERSION}\n`);
  io.stdout(`Policy:   ${project.policyFile} (${project.policy.hash.slice(0, 19)}…)\n`);
  io.stdout(`Target:   ${target.type === "engine" ? "AgentGuard engine" : target.module}\n`);
  io.stdout(`Mode:     simulation (scenario runs never sign or send transactions)\n`);
  if (names.length > 0) io.stdout(`Integrations: ${names.join(", ")}\n`);
  for (const w of project.policyWarnings) io.stdout(`⚠ ${formatIssue(w)}\n`);
  io.stdout(`Running ${selected.length} scenario${selected.length === 1 ? "" : "s"}\n\n`);

  const report = await runSuite({
    agentguardVersion: VERSION,
    ...(project.config.name ? { projectName: project.config.name } : {}),
    policy: project.policy,
    policyFile: project.policyFile,
    policyWarnings: project.policyWarnings.map((w) => `${w.path}: ${w.message}`),
    scenarios: set.scenarios,
    suiteHash: set.suiteHash,
    target,
    validators,
    integrations: names,
    filter: { scenarioIds, categories },
    redaction: { secrets: secretsFromEnv(io.env) },
    onScenarioComplete: (r) => {
      if (!values.quiet || r.status !== "PASS") io.stdout(`${formatScenarioLine(r, style)}\n`);
    },
  });

  io.stdout(`${formatSummary(report, style)}\n`);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const written: string[] = [];
  if (!values["no-save"]) {
    const dir = path.resolve(project.root, project.config.reports.dir);
    await mkdir(dir, { recursive: true });
    if (!(await exists(path.join(dir, ".gitignore")))) await writeFile(path.join(dir, ".gitignore"), "*\n");
    const file = path.join(dir, `${report.runId}.json`);
    await writeFile(file, json);
    written.push(file);
  }
  if (values.json) {
    const file = path.resolve(io.cwd, values.json as string);
    await writeReportFile(file, json);
    written.push(file);
  }
  if (values.markdown) {
    const file = path.resolve(io.cwd, values.markdown as string);
    await writeReportFile(file, renderMarkdown(report));
    written.push(file);
  }
  if (values["github-summary"] && io.env.GITHUB_STEP_SUMMARY) {
    await appendFile(io.env.GITHUB_STEP_SUMMARY, renderMarkdown(report));
  }
  for (const f of written) io.stdout(`Report: ${path.relative(io.cwd, f).split(path.sep).join("/")}\n`);
  return report.exitCode;
}

// ─── report ──────────────────────────────────────────────────────────────────

async function cmdReport(io: CliIO, args: string[]): Promise<number> {
  const { values } = parse(args, {
    config: { type: "string" },
    run: { type: "string" },
    format: { type: "string", default: "markdown" },
    output: { type: "string" },
  });
  if (values.help) return (io.stdout(HELP), 0);
  const format = values.format as string;
  if (format !== "markdown" && format !== "json") throw new UsageError("--format must be markdown or json");
  const project = await requireProject(io, values.config as string | undefined);
  if (!project) return EXIT_CODES.USAGE;
  const dir = path.resolve(project.root, project.config.reports.dir);
  let file: string;
  if (values.run) {
    const id = values.run as string;
    if (!/^run_[a-f0-9]{32}$/.test(id)) throw new UsageError("--run must be a run id such as run_0123…");
    file = path.join(dir, `${id}.json`);
  } else {
    const entries = (await exists(dir)) ? (await readdir(dir)).filter((f) => /^run_[a-f0-9]{32}\.json$/.test(f)) : [];
    if (entries.length === 0) {
      io.stderr("No stored runs found. Run `agentguard test` first.\n");
      return EXIT_CODES.USAGE;
    }
    const withTimes = await Promise.all(entries.map(async (f) => ({ f, t: (await stat(path.join(dir, f))).mtimeMs })));
    file = path.join(dir, withTimes.sort((a, b) => b.t - a.t)[0]!.f);
  }
  let report: RunReport;
  try {
    const parsed = runReportSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "schema mismatch");
    report = parsed.data;
  } catch (err) {
    io.stderr(`✗ Cannot read report ${path.relative(io.cwd, file)}: ${(err as Error).message}\n`);
    return EXIT_CODES.USAGE;
  }
  const content = format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report);
  if (values.output) {
    await writeReportFile(path.resolve(io.cwd, values.output as string), content);
    io.stdout(`Wrote ${values.output as string}\n`);
  } else {
    io.stdout(content);
  }
  return EXIT_CODES.PASSED;
}

// ─── entry ───────────────────────────────────────────────────────────────────

export async function main(argv: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.stdout(HELP);
        return command === undefined ? EXIT_CODES.USAGE : EXIT_CODES.PASSED;
      case "--version":
      case "-v":
        io.stdout(`${VERSION}\n`);
        return EXIT_CODES.PASSED;
      case "init":
        return await cmdInit(io, rest);
      case "policy":
        if (rest[0] !== "validate") throw new UsageError("expected `policy validate`");
        return await cmdPolicyValidate(io, rest.slice(1));
      case "scenarios":
        return await cmdScenarios(io, rest);
      case "test":
        return await cmdTest(io, rest);
      case "report":
        return await cmdReport(io, rest);
      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`Error: ${err.message}\nRun \`agentguard --help\` for usage.\n`);
      return EXIT_CODES.USAGE;
    }
    const message = redactString((err as Error)?.message ?? String(err), { secrets: secretsFromEnv(io.env) });
    io.stderr(`Internal error: ${message}\n`);
    return EXIT_CODES.ERROR;
  }
}
