import Link from "next/link";
import { notFound } from "next/navigation";
import { StepList } from "@/components/steps";
import { Card, Code, PageHeader, SeverityBadge } from "@/components/ui";
import { formatTime, loadRun } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function FindingPage({ params }: { params: Promise<{ runId: string; scenarioId: string }> }) {
  const { runId, scenarioId } = await params;
  const run = await loadRun(runId);
  const finding = run?.findings.find((f) => f.scenarioId === scenarioId);
  const scenario = run?.scenarios.find((s) => s.id === scenarioId);
  if (!run || !finding || !scenario) notFound();

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`/runs/${run.runId}`} className="text-accent hover:underline">
          ← Run {run.runId.slice(0, 12)}
        </Link>
      </p>
      <PageHeader title={finding.title} subtitle={`${formatTime(run.startedAt)} · finding ${finding.id}`}>
        <SeverityBadge severity={finding.severity} />
      </PageHeader>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Problem">
          <p className="text-sm">{finding.description}</p>
          <p className="mt-3 text-xs text-muted">{finding.severityRationale}</p>
        </Card>
        <Card title="Remediation">
          <p className="text-sm">{finding.remediation}</p>
        </Card>
        <Card title="Expected behaviour">
          <pre className="whitespace-pre-wrap break-all font-mono text-xs">{finding.expected}</pre>
        </Card>
        <Card title="Observed behaviour">
          <pre className="whitespace-pre-wrap break-all font-mono text-xs text-fail">{finding.observed}</pre>
        </Card>
        <Card title="Reproduce" className="lg:col-span-2">
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {finding.reproduction.map((r) => (
              <li key={r}>
                <Code>{r}</Code>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-xs text-muted">
            Evidence: <span className="font-mono">{finding.evidence.file}</span>
            {finding.evidence.step !== undefined ? `, step ${finding.evidence.step + 1}` : ""} · definition{" "}
            <span className="font-mono">{finding.evidence.definitionHash.slice(0, 19)}…</span> · policy{" "}
            <span className="font-mono">{run.policy.hash.slice(0, 19)}…</span>
          </p>
        </Card>
      </div>
      <h2 className="mb-3 mt-8 text-sm font-semibold text-muted">Scenario steps</h2>
      <StepList scenario={scenario} />
    </>
  );
}
