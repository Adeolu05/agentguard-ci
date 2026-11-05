import Link from "next/link";
import type { ReactNode } from "react";

type Status = "PASS" | "FAIL" | "ERROR" | "SKIPPED" | "PASSED" | "FAILED";

const STATUS_STYLE: Record<Status, { cls: string; icon: string; label: string }> = {
  PASS: { cls: "bg-pass-bg text-pass", icon: "✓", label: "Pass" },
  PASSED: { cls: "bg-pass-bg text-pass", icon: "✓", label: "Passed" },
  FAIL: { cls: "bg-fail-bg text-fail", icon: "✕", label: "Fail" },
  FAILED: { cls: "bg-fail-bg text-fail", icon: "✕", label: "Failed" },
  ERROR: { cls: "bg-error-bg text-error", icon: "!", label: "Error" },
  SKIPPED: { cls: "bg-skip-bg text-skip", icon: "–", label: "Skipped" },
};

/** Status is always conveyed by text and icon as well as colour. */
export function StatusBadge({ status, runLevel = false }: { status: Status; runLevel?: boolean }) {
  const s = STATUS_STYLE[status];
  const label = runLevel && status === "ERROR" ? "Incomplete" : s.label;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold whitespace-nowrap [overflow-wrap:normal] ${s.cls}`}>
      <span aria-hidden="true">{s.icon}</span>
      {label}
    </span>
  );
}

const SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-fail text-white dark:text-black",
  high: "bg-fail-bg text-fail",
  medium: "bg-skip-bg text-skip",
  low: "bg-surface-2 text-muted",
  informational: "bg-surface-2 text-muted",
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span className={`inline-block shrink-0 rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap [overflow-wrap:normal] ${SEVERITY_STYLE[severity] ?? ""}`}>
      {severity}
    </span>
  );
}

export function Card({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-border bg-surface p-4 ${className}`}>
      {title ? <h2 className="mb-3 text-sm font-semibold text-muted">{title}</h2> : null}
      {children}
    </section>
  );
}

export function Metric({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface p-3 sm:p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums sm:text-2xl">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </div>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold sm:text-xl">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {children}
    </div>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[max(0.85em,12px)]">{children}</code>;
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-accent underline underline-offset-2 hover:decoration-2">
      {children}
    </Link>
  );
}

export function EmptyState({ title, children, level = 2 }: { title: string; children: ReactNode; level?: 1 | 2 }) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <div className="rounded-lg border border-dashed border-border bg-surface p-5 text-center sm:p-8">
      <Heading className="text-base font-semibold">{title}</Heading>
      <div className="mx-auto mt-2 max-w-xl text-sm text-muted">{children}</div>
    </div>
  );
}

export function Notice({ tone, children }: { tone: "warn" | "error" | "info"; children: ReactNode }) {
  const cls = tone === "error" ? "border-fail bg-fail-bg text-fail" : tone === "warn" ? "border-skip bg-skip-bg text-skip" : "border-border bg-surface-2 text-fg";
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`mb-4 rounded-md border px-4 py-3 text-sm ${cls}`}>
      {children}
    </div>
  );
}
