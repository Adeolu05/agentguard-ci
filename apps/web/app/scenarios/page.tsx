import type { Metadata } from "next";
import Link from "next/link";
import { InvalidReports, NoRuns } from "@/components/runs";
import { PageHeader, SeverityBadge, StatusBadge } from "@/components/ui";
import { loadRuns, scenarioLibrary, type ScenarioHistoryEntry } from "@/lib/data";

export const metadata: Metadata = { title: "Scenario library" };
export const dynamic = "force-dynamic";

const DOT: Record<string, string> = { PASS: "bg-pass", FAIL: "bg-fail", ERROR: "bg-error", SKIPPED: "bg-skip" };

/** Outcome history, newest first. Each dot sits in a 24x24 tap target linking to its run. */
function History({ history }: { history: readonly ScenarioHistoryEntry[] }) {
  const shown = history.slice(0, 12);
  return (
    <ul className="flex flex-wrap" aria-label={`Last ${shown.length} outcomes, newest first`}>
      {shown.map((h) => (
        <li key={h.runId}>
          <Link
            href={`/runs/${h.runId}`}
            title={`${h.status} · ${h.startedAt}`}
            aria-label={`${h.status} in run ${h.runId.slice(0, 12)}`}
            className="flex h-6 w-6 items-center justify-center rounded hover:bg-surface-2"
          >
            <span aria-hidden="true" className={`block h-3 w-3 rounded-sm ${DOT[h.status]}`} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

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
        <>
          {/* Phones and tablets: cards */}
          <ul aria-label="Scenario library" className="grid gap-2 md:grid-cols-2 md:gap-3 lg:hidden">
            {lib.map(({ latest, history }) => (
              <li key={latest.id} className="rounded-lg border border-border bg-surface p-4">
                <div className="flex items-start justify-between gap-3">
                  <Link href={`/scenarios/${latest.id}`} className="min-w-0 font-medium text-accent hover:underline">
                    {latest.name}
                  </Link>
                  <StatusBadge status={history[0]!.status} />
                </div>
                <div className="mt-1 font-mono text-xs text-muted">{latest.id}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <SeverityBadge severity={latest.severity} />
                  <span>{latest.category}</span>
                </div>
                <div className="mt-2">
                  <History history={history} />
                </div>
              </li>
            ))}
          </ul>
          {/* Laptops and up: table */}
          <div className="hidden overflow-x-auto rounded-lg border border-border bg-surface lg:block">
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
                      <Link href={`/scenarios/${latest.id}`} className="inline-flex min-h-6 items-center font-medium text-accent hover:underline">
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
                      <History history={history} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
