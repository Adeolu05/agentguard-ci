import Link from "next/link";
import { notFound } from "next/navigation";
import { StepList } from "@/components/steps";
import { Card, PageHeader, SeverityBadge, StatusBadge } from "@/components/ui";
import { formatTime, loadRuns, scenarioLibrary } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function ScenarioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(id)) notFound();
  const { runs } = await loadRuns();
  const entry = scenarioLibrary(runs).get(id);
  if (!entry) notFound();
  const { latest, history } = entry;
  const counts = history.reduce<Record<string, number>>((acc, h) => ((acc[h.status] = (acc[h.status] ?? 0) + 1), acc), {});

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/scenarios" className="text-accent hover:underline">
          ← Scenario library
        </Link>
      </p>
      <PageHeader title={latest.name} subtitle={<span className="font-mono">{latest.id}</span>}>
        <SeverityBadge severity={latest.severity} />
      </PageHeader>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Description" className="lg:col-span-2">
          <p className="text-sm">{latest.description}</p>
          {latest.remediation ? <p className="mt-3 text-sm text-muted">Remediation: {latest.remediation}</p> : null}
          <p className="mt-3 text-xs text-muted">
            {latest.category} · {latest.required ? "required" : "optional"} · <span className="font-mono">{latest.file}</span>
          </p>
        </Card>
        <Card title="Outcomes across stored runs">
          <ul className="space-y-1 text-sm">
            {(["PASS", "FAIL", "ERROR", "SKIPPED"] as const).map((s) => (
              <li key={s} className="flex justify-between">
                <StatusBadge status={s} /> <span className="tabular-nums">{counts[s] ?? 0}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <h2 className="mb-3 mt-8 text-sm font-semibold text-muted">Execution history</h2>
      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Execution history for {latest.id}</caption>
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Run</th>
              <th scope="col" className="px-4 py-2 font-medium">Started</th>
              <th scope="col" className="px-4 py-2 font-medium">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.runId} className="border-b border-border last:border-0">
                <td className="px-4 py-2">
                  <Link href={`/runs/${h.runId}`} className="font-mono text-accent hover:underline">
                    {h.runId.slice(0, 12)}
                  </Link>
                </td>
                <td className="px-4 py-2">{formatTime(h.startedAt)}</td>
                <td className="px-4 py-2">
                  <StatusBadge status={h.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2 className="mb-3 mt-8 text-sm font-semibold text-muted">Most recent steps</h2>
      <StepList scenario={latest} />
    </>
  );
}
