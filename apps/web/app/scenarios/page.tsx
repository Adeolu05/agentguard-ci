import Link from "next/link";
import { InvalidReports, NoRuns } from "@/components/runs";
import { PageHeader, SeverityBadge, StatusBadge } from "@/components/ui";
import { loadRuns, scenarioLibrary } from "@/lib/data";

export const dynamic = "force-dynamic";

const DOT: Record<string, string> = { PASS: "bg-pass", FAIL: "bg-fail", ERROR: "bg-error", SKIPPED: "bg-skip" };

export default async function ScenariosPage() {
  const { runs, invalid, source } = await loadRuns();
  const lib = [...scenarioLibrary(runs).values()].sort(
    (a, b) => a.latest.category.localeCompare(b.latest.category) || a.latest.id.localeCompare(b.latest.id),
  );
  return (
    <>
      <PageHeader
        title="Scenario library"
        subtitle="Scenarios that appear in stored runs, with their most recent definition and outcome history (newest on the left)."
      />
      <InvalidReports invalid={invalid} />
      {lib.length === 0 ? (
        <NoRuns source={source} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Scenario library</caption>
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Scenario</th>
                <th scope="col" className="px-4 py-2 font-medium">Category</th>
                <th scope="col" className="px-4 py-2 font-medium">Risk</th>
                <th scope="col" className="px-4 py-2 font-medium">Latest</th>
                <th scope="col" className="px-4 py-2 font-medium">History</th>
              </tr>
            </thead>
            <tbody>
              {lib.map(({ latest, history }) => (
                <tr key={latest.id} className="border-b border-border align-top last:border-0">
                  <td className="px-4 py-2">
                    <Link href={`/scenarios/${latest.id}`} className="font-medium text-accent hover:underline">
                      {latest.name}
                    </Link>
                    <div className="font-mono text-xs text-muted">{latest.id}</div>
                    <div className="mt-1 max-w-xl text-xs text-muted">{latest.description}</div>
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">{latest.category}</td>
                  <td className="px-4 py-2">
                    <SeverityBadge severity={latest.severity} />
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={history[0]!.status} />
                  </td>
                  <td className="px-4 py-2">
                    <ul className="flex gap-1" aria-label={`Last ${Math.min(history.length, 12)} outcomes`}>
                      {history.slice(0, 12).map((h) => (
                        <li key={h.runId}>
                          <Link
                            href={`/runs/${h.runId}`}
                            title={`${h.status} · ${h.startedAt}`}
                            aria-label={`${h.status} in run ${h.runId.slice(0, 12)}`}
                            className={`block h-3 w-3 rounded-sm ${DOT[h.status]}`}
                          />
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
