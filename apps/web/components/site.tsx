import type { ReactNode } from "react";

export const GITHUB = "https://github.com/Adeolu05/drainproof";
export const docUrl = (file: string) => `${GITHUB}/blob/main/docs/${file}`;

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="font-mono text-xs font-medium uppercase tracking-[0.18em] text-accent">{children}</p>;
}

export function SectionHeading({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="max-w-2xl">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="mt-3 font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h2>
      {children ? <p className="mt-4 text-base text-muted sm:text-lg">{children}</p> : null}
    </div>
  );
}

export type TerminalLine = { text: string; tone?: "cmd" | "muted" | "fail" | "pass" | "warn" | "plain" };

const TONE: Record<NonNullable<TerminalLine["tone"]>, string> = {
  cmd: "text-fg",
  muted: "text-muted",
  fail: "text-fail",
  pass: "text-pass",
  warn: "text-skip",
  plain: "text-fg/90",
};

/** A terminal-style block. Content is real CLI output, quoted from docs/demo.md. */
export function Terminal({ title, lines, className = "" }: { title: string; lines: TerminalLine[]; className?: string }) {
  return (
    <figure className={`overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl shadow-black/10 ${className}`}>
      <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-4 py-2.5">
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-fail/70" />
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-skip/70" />
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-pass/70" />
        <figcaption className="ml-2 truncate font-mono text-xs text-muted">{title}</figcaption>
      </div>
      {/* Lines are kept intact (as the CLI prints them) and scroll sideways on narrow screens. */}
      <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre sm:p-5 sm:text-[13px]" tabIndex={0} aria-label={title}>
        {lines.map((l, i) => (
          <span key={i} className={`block ${TONE[l.tone ?? "plain"]}`}>
            {l.tone === "cmd" ? <span className="select-none text-accent">$ </span> : null}
            {l.text || " "}
          </span>
        ))}
      </pre>
    </figure>
  );
}

type IconName = "inject" | "repeat" | "race" | "key" | "cpu" | "hash" | "layers" | "shield" | "plug" | "file" | "check" | "pending" | "arrow";

const PATHS: Record<IconName, ReactNode> = {
  inject: <path d="M4 7h10M4 12h7M4 17h10M17 9l3 3-3 3" />,
  repeat: <path d="M4 12a6 6 0 0 1 10-4.5L16 9M20 12a6 6 0 0 1-10 4.5L8 15M16 4v5h-5M8 20v-5h5" />,
  race: <path d="M4 7h11M4 12h14M4 17h8M18 4v6M15 7h6" />,
  key: <path d="M14 10a4 4 0 1 0-3.5 4L9 15.5V18H7v2H4v-3l6.1-6.1M15.5 8.5h.01" />,
  cpu: <path d="M8 8h8v8H8zM10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3" />,
  hash: <path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16" />,
  layers: <path d="m12 3 9 5-9 5-9-5 9-5zM3 13l9 5 9-5" />,
  shield: <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6zM9 12l2 2 4-4" />,
  plug: <path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0V8zM12 16v5" />,
  file: <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  pending: <path d="M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
};

export function Icon({ name, className = "h-5 w-5" }: { name: IconName; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {PATHS[name]}
    </svg>
  );
}
