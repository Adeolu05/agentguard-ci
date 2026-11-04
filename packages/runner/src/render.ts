import type { RunReport, ScenarioResult } from "./report.js";

export interface TerminalStyle {
  color: boolean;
}

const COLORS = { green: 32, red: 31, yellow: 33, magenta: 35, dim: 2, bold: 1 } as const;

function paint(style: TerminalStyle, color: keyof typeof COLORS, s: string): string {
  return style.color ? `\u001b[${COLORS[color]}m${s}\u001b[0m` : s;
}

const STATUS_COLOR = { PASS: "green", FAIL: "red", ERROR: "magenta", SKIPPED: "yellow" } as const;

export function formatScenarioLine(r: ScenarioResult, style: TerminalStyle): string {
  const label = paint(style, STATUS_COLOR[r.status], r.status.padEnd(7));
  const optional = r.required ? "" : paint(style, "dim", " (optional)");
  let detail = "";
  if (r.status === "FAIL") {
    const step = r.steps[r.failedStep ?? -1];
    detail = `\n         ${paint(style, "dim", `step ${(r.failedStep ?? 0) + 1}:`)} ${step?.message ?? "expectation not met"}`;
  } else if (r.status === "ERROR") {
    detail = `\n         ${paint(style, "dim", "error:")} ${r.error?.message ?? "unknown error"}`;
  } else if (r.status === "SKIPPED") {
    detail = `\n         ${paint(style, "dim", "skipped:")} ${r.skipReason ?? ""}`;
  }
  return `${label} ${r.id}${optional}${detail}`;
}

export function formatSummary(report: RunReport, style: TerminalStyle): string {
  const s = report.summary;
  const result =
    report.status === "PASSED"
      ? paint(style, "green", "PASSED")
      : report.status === "FAILED"
        ? paint(style, "red", "FAILED")
        : paint(style, "magenta", "INCOMPLETE (errors)");
  const lines = [
    "",
    paint(style, "bold", "Summary"),
    `  Scenarios: ${s.total}`,
    `  Passed:    ${s.passed}`,
    `  Failed:    ${s.failed}`,
    `  Errors:    ${s.errored}`,
    `  Skipped:   ${s.skipped}`,
  ];
  if (report.findings.length > 0) {
    lines.push("", paint(style, "bold", "Findings"));
    for (const f of report.findings) lines.push(`  [${f.severity.toUpperCase()}] ${f.title}`);
  }
  lines.push("", `Result: ${result}  (exit code ${report.exitCode})`);
  return lines.join("\n");
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function code(s: string): string {
  const fence = s.includes("`") ? "``" : "`";
  return `${fence}${s}${fence}`;
}

/** Markdown report suitable for PR comments and GitHub job summaries. */
export function renderMarkdown(report: RunReport): string {
  const s = report.summary;
  const icon = report.status === "PASSED" ? "✅" : report.status === "FAILED" ? "❌" : "⚠️";
  const out: string[] = [];
  out.push(`# ${icon} AgentGuard CI: ${report.status}`);
  out.push("");
  out.push(
    `Run ${code(report.runId)} · ${report.startedAt} · ${report.executionMode} · AgentGuard ${report.agentguardVersion} · exit code ${report.exitCode}`,
  );
  out.push("");
  out.push("| Scenarios | Passed | Failed | Errors | Skipped |");
  out.push("| ---: | ---: | ---: | ---: | ---: |");
  out.push(`| ${s.total} | ${s.passed} | ${s.failed} | ${s.errored} | ${s.skipped} |`);
  out.push("");
  out.push(`- Policy: ${code(report.policy.file)} (${code(report.policy.hash.slice(0, 19))}…), agent ${code(report.policy.agentId)}`);
  out.push(`- Suite: ${s.total} of ${report.suite.scenarioCount} scenarios, hash ${code(report.suite.hash.slice(0, 19))}…`);
  out.push(`- Target: ${report.target.type === "engine" ? "AgentGuard engine" : code(report.target.module ?? report.target.name)}`);
  if (report.integrations.length > 0) out.push(`- Integrations: ${report.integrations.join(", ")}`);
  for (const w of report.policy.warnings) out.push(`- ⚠️ Policy warning: ${mdEscape(w)}`);
  out.push("");

  if (report.findings.length > 0) {
    out.push("## Findings");
    out.push("");
    for (const f of report.findings) {
      out.push(`### [${f.severity.toUpperCase()}] ${mdEscape(f.title)}`);
      out.push("");
      out.push(f.description);
      out.push("");
      out.push(`- **Expected:** ${code(f.expected)}`);
      out.push(`- **Observed:** ${code(f.observed)}`);
      out.push(`- **Severity rationale:** ${f.severityRationale}`);
      out.push(`- **Remediation:** ${f.remediation}`);
      out.push(`- **Reproduce:** ${f.reproduction.map(code).join(" · ")}`);
      out.push("");
    }
  }

  const problems = report.scenarios.filter((r) => r.status === "ERROR" || r.status === "SKIPPED");
  if (problems.length > 0) {
    out.push("## Errors and skipped scenarios");
    out.push("");
    for (const r of problems) {
      out.push(`- **${r.status}** ${code(r.id)}: ${mdEscape(r.status === "ERROR" ? (r.error?.message ?? "") : (r.skipReason ?? ""))}`);
    }
    out.push("");
  }

  out.push("## Scenarios");
  out.push("");
  out.push("| Status | Scenario | Category | Severity | Required |");
  out.push("| --- | --- | --- | --- | --- |");
  for (const r of report.scenarios) {
    out.push(`| ${r.status} | ${code(r.id)} ${mdEscape(r.name)} | ${r.category} | ${r.severity} | ${r.required ? "yes" : "no"} |`);
  }
  out.push("");
  out.push(
    "> AgentGuard tests the behaviours defined in these scenarios under the stated conditions. Passing them is not proof that an agent or wallet is secure in general. See docs/limitations.md.",
  );
  out.push("");
  return out.join("\n");
}
