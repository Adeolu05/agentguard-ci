import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { observedReasonCodes, StepList } from "@/components/steps";
import { Card, Code, Metric, Notice, PageHeader, SeverityBadge, StatusBadge } from "@/components/ui";
import { formatDuration, formatTime, loadRun } from "@/lib/data";

export async function generateMetadata({ params }: { params: Promise<{ runId: string }> }): Promise<Metadata> {
  const { runId } = await params;
  return { title: `Run ${runId.slice(0, 12)}` };
}
export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = await loadRun(runId);
  if (!run) notFound();
  const s = run.summary;

  return (
    <>
      <PageHeader
        title={`Run ${run.runId.slice(0, 12)}`}
        subtitle={
          <>
            {formatTime(run.startedAt)} · {run.executionMode} · exit code {run.exitCode} · <span className="font-mono text-xs">{run.runId}</span>
          </>
        }
      >
        <StatusBadge status={run.status} runLevel />
      </PageHeader>
      {run.status === "ERROR" ? (
        <Notice tone="error">
          This run is <strong>incomplete</strong>: at least one required scenario could not be evaluated, or nothing was evaluated. It is not a
          pass.
        </Notice>
      ) : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-6">
        <Metric label="Scenarios" value={s.total} />
        <Metric label="Passed" value={<span className="text-pass">{s.passed}</span>} />
        <Metric label="Failed" value={<span className={s.failed ? "text-fail" : ""}>{s.failed}</span>} />
        <Metric label="Errors" value={<span className={s.errored ? "text-error" : ""}>{s.errored}</span>} />
        <Metric label="Skipped" value={s.skipped} />
        <Metric label="Duration" value={formatDuration(run.durationMs)} />
      </div>

      {run.findings.length > 0 ? (
        <Card title={`Findings (${run.findings.length})`} className="mt-6">
          <ul className="divide-y divide-border">
            {run.findings.map((f) => (
              <li key={f.id} className="flex items-start gap-3 py-2">
                <SeverityBadge severity={f.severity} />
                <Link href={`/runs/${run.runId}/findings/${f.scenarioId}`} className="inline-flex min-h-6 items-center text-sm text-accent hover:underline">
                  {f.title}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <h2 className="mb-3 mt-8 text-sm font-semibold text-muted">Scenario results</h2>
      <div className="space-y-2">
        {run.scenarios.map((sc) => {
          const codes = observedReasonCodes(sc);
          return (
            <details key={sc.id} className="group rounded-2xl border border-border bg-surface" open={sc.status === "FAIL" || sc.status === "ERROR"}>
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-4 py-3">
                <StatusBadge status={sc.status} />
                <span className="font-medium">{sc.name}</span>
                <span className="font-mono text-xs text-muted">{sc.id}</span>
                <span className="ml-auto flex items-center gap-2 text-xs text-muted">
                  {sc.category} <SeverityBadge severity={sc.severity} /> {sc.required ? null : <span>(optional)</span>}
                </span>
              </summary>
              <div className="border-t border-border px-4 py-3 text-sm">
                <p className="text-muted">{sc.description}</p>
                {sc.status === "FAIL" ? (
                  <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                    <dt className="text-muted">Expected</dt>
                    <dd className="font-mono text-xs">{sc.expected}</dd>
                    <dt className="text-muted">Observed</dt>
                    <dd className="font-mono text-xs text-fail">{sc.observed}</dd>
                  </dl>
                ) : null}
                {sc.error ? <p className="mt-3 text-error">Error: {sc.error.message}</p> : null}
                {sc.skipReason ? <p className="mt-3 text-skip">Skipped: {sc.skipReason}</p> : null}
                {codes.length > 0 ? (
                  <p className="mt-3">
                    <span className="text-muted">Reason codes: </span>
                    {codes.map((c) => (
                      <Code key={c}>{c}</Code>
                    ))}
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted">
                  <span>
                    File <span className="font-mono">{sc.file}</span>
                  </span>
                  <span>{formatDuration(sc.durationMs)}</span>
                  <Link href={`/scenarios/${sc.id}`} className="inline-flex min-h-11 sm:min-h-6 items-center text-accent hover:underline">
                    Scenario history →
                  </Link>
                  {sc.status === "FAIL" ? (
                    <Link href={`/runs/${run.runId}/findings/${sc.id}`} className="inline-flex min-h-11 sm:min-h-6 items-center text-accent hover:underline">
                      Finding →
                    </Link>
                  ) : null}
                </div>
                <div className="mt-4">
                  <StepList scenario={sc} />
                </div>
              </div>
            </details>
          );
        })}
      </div>

      <Card title="Execution details" className="mt-8">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-y-1.5">
          <dt className="text-muted">Policy</dt>
          <dd>
            <Code>{run.policy.file}</Code> <span className="font-mono text-xs">{run.policy.hash}</span>
          </dd>
          <dt className="text-muted">Agent</dt>
          <dd className="font-mono">{run.policy.agentId}</dd>
          <dt className="text-muted">Suite</dt>
          <dd>
            {run.suite.scenarioCount} scenarios · <span className="font-mono text-xs">{run.suite.hash}</span>
          </dd>
          <dt className="text-muted">Filters</dt>
          <dd>
            {run.filters.scenarioIds.length || run.filters.categories.length
              ? [...run.filters.scenarioIds, ...run.filters.categories].join(", ")
              : "none"}
          </dd>
          <dt className="text-muted">Target</dt>
          <dd>{run.target.type === "engine" ? "Drainproof engine" : <Code>{run.target.module}</Code>}</dd>
          <dt className="text-muted">Integrations</dt>
          <dd>{run.integrations.length ? run.integrations.join(", ") : "none"}</dd>
          <dt className="text-muted">Environment</dt>
          <dd>
            Node {run.environment.node} · {run.environment.platform}/{run.environment.arch}
            {run.environment.ci ? " · CI" : ""}
            {run.environment.gitSha ? ` · ${run.environment.gitSha.slice(0, 10)}` : ""}
          </dd>
          <dt className="text-muted">Drainproof</dt>
          <dd>{run.drainproofVersion}</dd>
        </dl>
        {run.policy.warnings.length > 0 ? (
          <ul className="mt-3 list-disc pl-5 text-sm text-skip">
            {run.policy.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
      </Card>
    </>
  );
}
