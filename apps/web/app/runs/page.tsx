import Link from "next/link";
import { InvalidReports, NoRuns, RunsTable } from "@/components/runs";
import { EmptyState, PageHeader } from "@/components/ui";
import { loadRuns } from "@/lib/data";

export const dynamic = "force-dynamic";

const RESULTS = ["PASSED", "FAILED", "ERROR"] as const;
const MODES = ["simulation", "testnet"] as const;

function FilterLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded px-2.5 py-1 text-sm ${active ? "bg-fg text-bg" : "text-muted hover:bg-surface-2 hover:text-fg"}`}
    >
      {children}
    </Link>
  );
}

export default async function RunsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const result = typeof params.result === "string" && (RESULTS as readonly string[]).includes(params.result) ? params.result : undefined;
  const mode = typeof params.mode === "string" && (MODES as readonly string[]).includes(params.mode) ? params.mode : undefined;
  const { runs, invalid, source } = await loadRuns();
  const filtered = runs.filter((r) => (!result || r.status === result) && (!mode || r.executionMode === mode));
  const href = (next: { result?: string | undefined; mode?: string | undefined }) => {
    const q = new URLSearchParams();
    if (next.result) q.set("result", next.result);
    if (next.mode) q.set("mode", next.mode);
    const s = q.toString();
    return s ? `/runs?${s}` : "/runs";
  };

  return (
    <>
      <PageHeader title="Test runs" subtitle={`${runs.length} stored run${runs.length === 1 ? "" : "s"}`} />
      <InvalidReports invalid={invalid} />
      {runs.length === 0 ? (
        <NoRuns source={source} />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-6">
            <div role="group" aria-label="Filter by result" className="flex items-center gap-1">
              <span className="mr-1 text-xs uppercase tracking-wide text-muted">Result</span>
              <FilterLink href={href({ mode })} active={!result}>All</FilterLink>
              {RESULTS.map((r) => (
                <FilterLink key={r} href={href({ result: r, mode })} active={result === r}>
                  {r === "ERROR" ? "Incomplete" : r.charAt(0) + r.slice(1).toLowerCase()}
                </FilterLink>
              ))}
            </div>
            <div role="group" aria-label="Filter by execution mode" className="flex items-center gap-1">
              <span className="mr-1 text-xs uppercase tracking-wide text-muted">Mode</span>
              <FilterLink href={href({ result })} active={!mode}>All</FilterLink>
              {MODES.map((m) => (
                <FilterLink key={m} href={href({ result, mode: m })} active={mode === m}>
                  {m}
                </FilterLink>
              ))}
            </div>
          </div>
          {filtered.length === 0 ? (
            <EmptyState title="No runs match these filters">Clear a filter to see more runs.</EmptyState>
          ) : (
            <RunsTable runs={filtered} caption="Test runs, newest first" />
          )}
        </>
      )}
    </>
  );
}
