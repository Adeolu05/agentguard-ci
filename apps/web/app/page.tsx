import Link from "next/link";
import { InvalidReports, NoRuns, RunsTable } from "@/components/runs";
import { Card, Code, Metric, PageHeader, SeverityBadge, StatusBadge } from "@/components/ui";
import { formatTime, loadRuns, shortId } from "@/lib/data";

export const dynamic = "force-dynamic";

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "informational"];

export default async function OverviewPage() {
  const { runs, invalid, source } = await loadRuns();
  const latest = runs[0];
  if (!latest) {
    return (
      <>
        <PageHeader title="Overview" />
        <InvalidReports invalid={invalid} />
        <NoRuns source={source} />
      </>
    );
  }
  const completed = runs.filter((r) => r.status !== "ERROR");
  const passedRuns = completed.filter((r) => r.status === "PASSED").length;
  const findings = runs
    .slice(0, 10)
    .flatMap((r) => r.findings.map((f) => ({ ...f, runId: r.runId, startedAt: r.startedAt })))
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || b.startedAt.localeCompare(a.startedAt))
    .slice(0, 8);

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={
          <>
            {latest.project.name ?? "AgentGuard project"} · policy <Code>{latest.policy.file}</Code>{" "}
            <span className="font-mono text-xs">{latest.policy.hash.slice(0, 19)}…</span>
          </>
        }
      />
      <InvalidReports invalid={invalid} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Test runs" value={runs.length} hint={`${completed.length} completed, ${runs.length - completed.length} incomplete`} />
        <Metric
          label="Latest run"
          value={<StatusBadge status={latest.status} runLevel />}
          hint={`${formatTime(latest.startedAt)} · exit code ${latest.exitCode}`}
        />
        <Metric
          label="Failed scenarios (latest)"
          value={<span className={latest.summary.failed ? "text-fail" : ""}>{latest.summary.failed}</span>}
          hint={`${latest.summary.errored} errored · ${latest.summary.skipped} skipped of ${latest.summary.total}`}
        />
        <Metric
          label="Scenario pass rate (latest)"
          value={latest.summary.passRate === null ? "n/a" : `${Math.round(latest.summary.passRate * 100)}%`}
          hint={
            latest.summary.passRate === null
              ? "Not computed: a required scenario errored or nothing was evaluated"
              : `Completed runs passing: ${passedRuns} of ${completed.length}`
          }
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <Card title="Recent findings" className="lg:col-span-3">
          {findings.length === 0 ? (
            <p className="text-sm text-muted">No findings in the last {Math.min(runs.length, 10)} runs.</p>
          ) : (
            <ul className="divide-y divide-border">
              {findings.map((f) => (
                <li key={f.id} className="flex items-start gap-3 py-2">
                  <SeverityBadge severity={f.severity} />
                  <div className="min-w-0">
                    <Link href={`/runs/${f.runId}/findings/${f.scenarioId}`} className="text-sm text-accent hover:underline">
                      {f.title}
                    </Link>
                    <div className="text-xs text-muted">
                      run <span className="font-mono">{shortId(f.runId)}</span> · {formatTime(f.startedAt)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Latest run" className="lg:col-span-2">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted">Run</dt>
            <dd>
              <Link href={`/runs/${latest.runId}`} className="font-mono text-accent hover:underline">
                {shortId(latest.runId)}
              </Link>
            </dd>
            <dt className="text-muted">Agent</dt>
            <dd className="font-mono">{latest.policy.agentId}</dd>
            <dt className="text-muted">Target</dt>
            <dd>{latest.target.type === "engine" ? "AgentGuard engine" : latest.target.module}</dd>
            <dt className="text-muted">Mode</dt>
            <dd>{latest.executionMode}</dd>
            <dt className="text-muted">Suite</dt>
            <dd>
              {latest.summary.total} of {latest.suite.scenarioCount} scenarios
            </dd>
            <dt className="text-muted">Version</dt>
            <dd>AgentGuard {latest.agentguardVersion}</dd>
          </dl>
        </Card>
      </div>

      <h2 className="mb-3 mt-8 text-sm font-semibold text-muted">Recent test runs</h2>
      <RunsTable runs={runs.slice(0, 5)} caption="Five most recent test runs" />
      {runs.length > 5 ? (
        <p className="mt-2 text-sm">
          <Link href="/runs" className="text-accent hover:underline">
            All {runs.length} runs →
          </Link>
        </p>
      ) : null}
    </>
  );
}
