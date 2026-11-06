import type { RunReport } from "@drainproof/runner";

type ScenarioResult = RunReport["scenarios"][number];

function json(v: unknown): string {
  return v === undefined ? "" : JSON.stringify(v, null, 2);
}

export function StepList({ scenario }: { scenario: ScenarioResult }) {
  if (scenario.steps.length === 0) {
    return <p className="text-sm text-muted">No steps were executed{scenario.skipReason ? ` (${scenario.skipReason})` : ""}.</p>;
  }
  return (
    <ol className="space-y-2">
      {scenario.steps.map((st) => (
        <li key={st.index} className="rounded border border-border p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono text-muted">#{st.index + 1}</span>
            <span className="font-mono">{st.kind}</span>
            <span
              className={`shrink-0 rounded px-1.5 text-xs font-semibold whitespace-nowrap [overflow-wrap:normal] ${
                st.status === "passed" ? "bg-pass-bg text-pass" : st.status === "failed" ? "bg-fail-bg text-fail" : "bg-error-bg text-error"
              }`}
            >
              {st.status}
            </span>
            {st.message ? <span className="text-muted">{st.message}</span> : null}
          </div>
          {st.expected !== undefined || st.observed !== undefined ? (
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              {st.expected !== undefined ? (
                <div>
                  <div className="text-xs uppercase tracking-wide text-muted">Expected</div>
                  <pre className="mt-1 rounded bg-surface-2 p-2 font-mono text-xs whitespace-pre-wrap">{json(st.expected)}</pre>
                </div>
              ) : null}
              {st.observed !== undefined ? (
                <div>
                  <div className="text-xs uppercase tracking-wide text-muted">Observed</div>
                  <pre className="mt-1 rounded bg-surface-2 p-2 font-mono text-xs whitespace-pre-wrap">{json(st.observed)}</pre>
                </div>
              ) : null}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** Reason codes observed on the step that decided the outcome (failed step, else last propose step). */
export function observedReasonCodes(s: ScenarioResult): string[] {
  const step = s.failedStep !== undefined ? s.steps[s.failedStep] : [...s.steps].reverse().find((x) => x.kind === "propose");
  const obs = step?.observed as { reason_codes?: unknown } | undefined;
  return Array.isArray(obs?.reason_codes) ? obs.reason_codes.filter((c): c is string => typeof c === "string") : [];
}
