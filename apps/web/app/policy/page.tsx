import { stringify } from "yaml";
import { Card, Code, EmptyState, Notice, PageHeader, TextLink } from "@/components/ui";
import { formatTime, loadPolicyStatus, loadRuns } from "@/lib/data";

export const dynamic = "force-dynamic";

function PolicyDocument({ document }: { document: unknown }) {
  return <pre className="overflow-x-auto rounded bg-surface-2 p-4 font-mono text-xs leading-relaxed">{stringify(document)}</pre>;
}

export default async function PolicyPage() {
  const [status, { runs }] = await Promise.all([loadPolicyStatus(), loadRuns()]);
  const latest = runs[0];
  return (
    <>
      <PageHeader
        title="Policy"
        subtitle="Policies are edited in YAML and reviewed like code. The dashboard only displays them; it has no editing path."
      />
      {status.kind === "valid" ? (
        <>
          <Notice tone="info">
            <strong>Valid.</strong> <Code>{status.policyFile}</Code> from <Code>{status.file}</Code> passed schema validation just now.
            Hash <span className="font-mono text-xs">{status.hash}</span>
            {latest && latest.policy.hash !== status.hash ? (
              <span className="mt-1 block text-skip">
                This differs from the policy used in the latest run ({latest.policy.hash.slice(0, 19)}…). Re-run{" "}
                <Code>agentguard test</Code> to test the current version.
              </span>
            ) : null}
          </Notice>
          {status.warnings.length > 0 ? (
            <Notice tone="warn">
              <ul className="list-disc pl-5">
                {status.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          <Card title="Active policy (validated)">
            <PolicyDocument document={status.document} />
          </Card>
        </>
      ) : status.kind === "invalid" ? (
        <Notice tone="error">
          <strong>The configured project or policy is invalid</strong> (<Code>{status.file}</Code>):
          <ul className="mt-1 list-disc pl-5">
            {status.issues.map((i) => (
              <li key={`${i.location}${i.message}`}>
                <span className="font-mono">{i.location}</span>: {i.message}
              </li>
            ))}
          </ul>
        </Notice>
      ) : latest ? (
        <>
          <Notice tone="info">
            No project is configured (<Code>AGENTGUARD_PROJECT</Code>), so this is the policy <em>as recorded</em> in the latest run (
            <TextLink href={`/runs/${latest.runId}`}>{latest.runId.slice(0, 12)}</TextLink>, {formatTime(latest.startedAt)}). It was valid when
            that run started.
          </Notice>
          <Card title={`${latest.policy.file} · ${latest.policy.hash.slice(0, 19)}…`}>
            {latest.policy.document ? <PolicyDocument document={latest.policy.document} /> : <p className="text-sm text-muted">Not recorded.</p>}
          </Card>
        </>
      ) : (
        <EmptyState title="No policy to show">
          Set <Code>AGENTGUARD_PROJECT</Code> to your <Code>agentguard.yaml</Code> to validate and display its policy, or run{" "}
          <Code>agentguard test</Code> to record one in a run report.
        </EmptyState>
      )}
    </>
  );
}
