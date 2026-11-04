import Link from "next/link";
import type { RunReport } from "@agentguard/runner";
import type { DataSource, InvalidReport } from "@/lib/data";
import { formatDuration, formatTime, shortId } from "@/lib/data";
import { Code, EmptyState, Notice, StatusBadge } from "./ui";

export function RunsTable({ runs, caption }: { runs: readonly RunReport[]; caption: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">Run</th>
            <th scope="col" className="px-4 py-2 font-medium">Started</th>
            <th scope="col" className="px-4 py-2 font-medium">Result</th>
            <th scope="col" className="px-4 py-2 font-medium">Mode</th>
            <th scope="col" className="px-4 py-2 text-right font-medium">Pass / Fail / Error / Skip</th>
            <th scope="col" className="px-4 py-2 text-right font-medium">Duration</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.runId} className="border-b border-border last:border-0 hover:bg-surface-2">
              <td className="px-4 py-2">
                <Link href={`/runs/${r.runId}`} className="font-mono text-accent hover:underline">
                  {shortId(r.runId)}
                </Link>
                {r.project.name ? <div className="text-xs text-muted">{r.project.name}</div> : null}
              </td>
              <td className="px-4 py-2 whitespace-nowrap">{formatTime(r.startedAt)}</td>
              <td className="px-4 py-2">
                <StatusBadge status={r.status} runLevel />
              </td>
              <td className="px-4 py-2">{r.executionMode}</td>
              <td className="px-4 py-2 text-right font-mono tabular-nums">
                {r.summary.passed} / <span className={r.summary.failed ? "text-fail" : ""}>{r.summary.failed}</span> /{" "}
                <span className={r.summary.errored ? "text-error" : ""}>{r.summary.errored}</span> / {r.summary.skipped}
              </td>
              <td className="px-4 py-2 text-right tabular-nums">{formatDuration(r.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function NoRuns({ source }: { source: DataSource }) {
  return (
    <EmptyState title="No test runs yet">
      <p>
        The dashboard shows reports written by the AgentGuard CLI. It looked in <Code>{source.runsDir}</Code>.
      </p>
      <p className="mt-3">Run the suite in your project, then point the dashboard at its reports directory:</p>
      <pre className="mt-3 overflow-x-auto rounded bg-surface-2 p-3 text-left font-mono text-xs text-fg">
        {`agentguard test\nAGENTGUARD_RUNS_DIR=<project>/.agentguard/runs pnpm --filter @agentguard/web dev`}
      </pre>
    </EmptyState>
  );
}

export function InvalidReports({ invalid }: { invalid: readonly InvalidReport[] }) {
  if (invalid.length === 0) return null;
  return (
    <Notice tone="warn">
      <strong>
        {invalid.length} report file{invalid.length === 1 ? "" : "s"} could not be read and {invalid.length === 1 ? "is" : "are"} not shown.
      </strong>
      <ul className="mt-1 list-disc pl-5">
        {invalid.slice(0, 5).map((i) => (
          <li key={i.file}>
            <span className="font-mono">{i.file}</span>: {i.error}
          </li>
        ))}
      </ul>
    </Notice>
  );
}
