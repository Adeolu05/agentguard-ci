import Link from "next/link";
import type { ReactNode } from "react";
import { LogoMark, Wordmark } from "@/components/brand";
import { GITHUB, docUrl } from "@/components/site";

const LINKS = [
  { href: "#problem", label: "Why" },
  { href: "#how", label: "How it works" },
  { href: "#features", label: "Features" },
  { href: "#near", label: "NEAR" },
];

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="sticky top-0 z-40 border-b border-border/70 bg-bg/75 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-2">
          <Wordmark />
          <nav aria-label="Sections" className="hidden md:block">
            <ul className="flex gap-1 text-sm">
              {LINKS.map((l) => (
                <li key={l.href}>
                  <a href={l.href} className="flex min-h-9 items-center rounded-lg px-3 text-muted transition-colors hover:bg-surface-2 hover:text-fg">
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <a
              href={GITHUB}
              className="hidden min-h-11 items-center rounded-lg px-3 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg sm:flex sm:min-h-9"
            >
              GitHub
            </a>
            <Link
              href="/dashboard"
              className="flex min-h-11 items-center rounded-lg bg-fg px-4 text-sm font-semibold text-bg transition-opacity hover:opacity-90 sm:min-h-9"
            >
              Open dashboard
            </Link>
          </div>
        </div>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
      <footer className="border-t border-border">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2.5 font-display font-semibold">
              <LogoMark className="h-6 w-6" /> AgentGuard CI
            </div>
            <p className="mt-3 max-w-sm text-sm text-muted">
              Passing the suite shows the tested properties hold under the tested conditions. It is not proof that an agent is secure in general.{" "}
              <a href={docUrl("limitations.md")} className="text-accent underline underline-offset-2">
                Read the limitations
              </a>
              .
            </p>
          </div>
          <nav aria-label="Project">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">Project</h2>
            <ul className="mt-3 space-y-1 text-sm">
              <li><a className="inline-flex min-h-8 items-center hover:text-accent" href={GITHUB}>Source on GitHub</a></li>
              <li><Link className="inline-flex min-h-8 items-center hover:text-accent" href="/dashboard">Dashboard</Link></li>
              <li><a className="inline-flex min-h-8 items-center hover:text-accent" href={docUrl("adoption.md")}>Use it in your project</a></li>
            </ul>
          </nav>
          <nav aria-label="Documentation">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">Docs</h2>
            <ul className="mt-3 space-y-1 text-sm">
              <li><a className="inline-flex min-h-8 items-center hover:text-accent" href={docUrl("policy-schema.md")}>Policy schema</a></li>
              <li><a className="inline-flex min-h-8 items-center hover:text-accent" href={docUrl("threat-model.md")}>Threat model</a></li>
              <li><a className="inline-flex min-h-8 items-center hover:text-accent" href={docUrl("integrations.md")}>NEAR integration</a></li>
            </ul>
          </nav>
        </div>
        <div className="border-t border-border px-4 py-4 text-center text-xs text-muted">Apache-2.0 · Open source</div>
      </footer>
    </>
  );
}
