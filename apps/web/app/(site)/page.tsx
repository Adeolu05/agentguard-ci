import Link from "next/link";
import { GITHUB, Icon, SectionHeading, Terminal, docUrl } from "@/components/site";

// Every number and output on this page is a property of the code in this repository.
const STATS = [
  { value: "40", label: "adversarial scenarios out of the box" },
  { value: "10", label: "policy rules, enforced without an LLM" },
  { value: "0", label: "floating-point numbers in money maths" },
  { value: "1", label: "broadcast at most, per authorised NEAR payment" },
];

const PROBLEMS = [
  {
    icon: "inject" as const,
    title: "Injected payees",
    body: "A poisoned tool response swaps the recipient. The amount stays under every limit, so only the allowlist stands in the way.",
    scenario: "instruction-injection-in-memo",
  },
  {
    icon: "repeat" as const,
    title: "Double payments",
    body: "A timeout, a retry, and the same invoice is paid twice. Idempotency has to hold even under concurrent retries.",
    scenario: "concurrent-duplicates-single-reservation",
  },
  {
    icon: "race" as const,
    title: "Budget races",
    body: "Ten parallel requests each pass the daily-limit check. Together they spend twice the budget.",
    scenario: "concurrent-requests-respect-daily-limit",
  },
  {
    icon: "key" as const,
    title: "Stretched approvals",
    body: "An approval for 15 USDC quietly authorises 24 USDC, or the same amount to someone else.",
    scenario: "approval-amount-tampering",
  },
];

const FEATURES = [
  {
    icon: "cpu" as const,
    title: "Deterministic engine",
    body: "ALLOW, BLOCK or REQUIRE_APPROVAL from explicit rules with stable reason codes. Ledger outages and unexpected errors fail closed.",
    wide: true,
  },
  { icon: "hash" as const, title: "Exact amounts", body: "BigInt atomic units, from 6-decimal USDC to 24-decimal yoctoNEAR. Numeric JSON is rejected outright." },
  { icon: "layers" as const, title: "Atomic ledger", body: "Check-and-reserve is one atomic step per agent; retries replay instead of paying twice." },
  { icon: "key" as const, title: "Bound approvals", body: "Signed grants tied to the exact proposal and policy version. Single use, and they expire." },
  { icon: "plug" as const, title: "Test your own guard", body: "Point the suite at your existing spending checks. The naive example guard fails 16 scenarios." },
  {
    icon: "file" as const,
    title: "Reports that explain themselves",
    body: "JSON, Markdown and this dashboard: expected versus observed, severity with its rationale, and the command to reproduce.",
    wide: true,
  },
];

const NEAR_STATUS = [
  { done: true, text: "NEAR account-ID rules: named, implicit, ETH-like, plus cross-network checks" },
  { done: true, text: "Exact yoctoNEAR limits (one yocto over is blocked)" },
  { done: true, text: "Mainnet refused by policy, by signer and by the RPC's reported network" },
  { done: true, text: "Testnet executor behind the execution gate: at most one broadcast, verified against near-api-js and a local RPC" },
  { done: false, text: "Live testnet transfer: not yet run. The procedure is documented; no transaction hash is claimed." },
];

const POLICY = [
  { text: "assets:", tone: "plain" as const },
  { text: "  - id: USDC", tone: "plain" as const },
  { text: "    decimals: 6", tone: "plain" as const },
  { text: '    max_transaction_amount: "25"', tone: "plain" as const },
  { text: '    max_daily_spend: "100"', tone: "plain" as const },
  { text: '    approval_required_above: "10"', tone: "plain" as const },
  { text: "recipients:", tone: "plain" as const },
  { text: "  mode: allowlist", tone: "plain" as const },
  { text: "  allowed: [merchant-example]", tone: "plain" as const },
];

const CI = [
  { text: "- run: npx --no-install agentguard test", tone: "plain" as const },
  { text: "", tone: "plain" as const },
  { text: "# exit 0  all required scenarios passed", tone: "pass" as const },
  { text: "# exit 1  a security scenario failed", tone: "fail" as const },
  { text: "# exit 2  invalid policy or scenario", tone: "warn" as const },
  { text: "# exit 3  incomplete: never a pass", tone: "muted" as const },
];

function PrimaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="group inline-flex min-h-12 items-center gap-2 rounded-xl bg-fg px-6 font-semibold text-bg shadow-lg shadow-black/10 transition-transform hover:-translate-y-0.5 dark:bg-gradient-brand dark:text-black"
    >
      {children}
      <Icon name="arrow" className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

function SecondaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="inline-flex min-h-12 items-center gap-2 rounded-xl border border-border-strong bg-surface/60 px-6 font-semibold backdrop-blur transition-colors hover:bg-surface-2"
    >
      {children}
    </a>
  );
}

export default function LandingPage() {
  return (
    <>
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="relative isolate overflow-hidden">
        <div aria-hidden="true" className="absolute inset-0 -z-10 bg-grid [mask-image:radial-gradient(70%_60%_at_50%_0%,black,transparent)]" />
        <div aria-hidden="true" className="absolute inset-0 -z-10 bg-glow animate-drift" />
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pt-14 pb-16 sm:pt-20 lg:grid-cols-[1.1fr_1fr] lg:gap-10 lg:pt-28 lg:pb-24 [&>*]:min-w-0">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-border-strong bg-surface/70 px-3 py-1 text-xs font-medium text-muted backdrop-blur">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-gradient-brand" />
              Open source · Apache-2.0 · Built for agents on NEAR
            </p>
            <h1 className="mt-6 font-display text-[2.6rem] leading-[1.02] font-semibold tracking-tight text-balance sm:text-6xl lg:text-7xl">
              Know what your AI agent <span className="text-gradient">can spend</span> before it does.
            </h1>
            <p className="mt-6 max-w-xl text-lg text-muted">
              AgentGuard CI is a security test suite for AI agents with wallets. Write a transaction policy, attack it with 40 adversarial
              scenarios, and fail the pull request the moment a guardrail regresses.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <PrimaryLink href="/dashboard">Open the dashboard</PrimaryLink>
              <SecondaryLink href={GITHUB}>View on GitHub</SecondaryLink>
            </div>
            <p className="mt-4 text-sm text-muted">
              No account, no LLM and no blockchain needed to run it.{" "}
              <a href="#quickstart" className="text-accent underline underline-offset-2">
                Quick start
              </a>
            </p>
          </div>
          <div className="relative lg:translate-y-4">
            <div aria-hidden="true" className="absolute -inset-4 -z-10 rounded-[2rem] bg-gradient-brand opacity-25 blur-3xl dark:opacity-30" />
            <Terminal
            title="after someone allowlisted attacker-wallet"
            lines={[
              { text: "agentguard test --quiet", tone: "cmd" },
              { text: "Running 40 scenarios", tone: "muted" },
              { text: "" },
              { text: "FAIL    instruction-injection-in-memo", tone: "fail" },
              { text: "        step 1: expected BLOCK, observed ALLOW", tone: "muted" },
              { text: "" },
              { text: "Findings", tone: "plain" },
              { text: "  [CRITICAL] Instruction injection cannot override", tone: "fail" },
              { text: "             deterministic policy rules", tone: "fail" },
              { text: "" },
              { text: "Result: FAILED  (exit code 1)", tone: "fail" },
            ]}
            />
          </div>
        </div>
      </section>

      {/* ── Stats ────────────────────────────────────────────────────────── */}
      <section aria-label="At a glance" className="border-y border-border bg-surface/60">
        <dl className="mx-auto grid max-w-6xl grid-cols-2 gap-px px-4 lg:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.label} className="flex flex-col py-8 sm:py-10 lg:px-6">
              <dt className="text-sm text-muted">{s.label}</dt>
              <dd className="order-first font-display text-4xl font-semibold tracking-tight sm:text-5xl">
                <span className="text-gradient">{s.value}</span>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {/* ── Problem ──────────────────────────────────────────────────────── */}
      <section id="problem" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:py-28">
        <SectionHeading eyebrow="The problem" title="Agents follow instructions. Including the wrong ones.">
          A payment agent can be talked into paying the wrong account, paying twice or blowing its budget. Unit tests rarely cover any of
          it, so AgentGuard ships the attacks as executable scenarios.
        </SectionHeading>
        <div className="mt-12 grid gap-4 sm:grid-cols-2">
          {PROBLEMS.map((p) => (
            <article key={p.title} className="group rounded-2xl border border-border bg-surface p-6 transition-colors hover:border-border-strong">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-2 text-accent">
                <Icon name={p.icon} />
              </div>
              <h3 className="mt-4 font-display text-xl font-semibold">{p.title}</h3>
              <p className="mt-2 text-muted">{p.body}</p>
              <p className="mt-4 font-mono text-xs text-muted">
                tested by <span className="text-fg">{p.scenario}</span>
              </p>
            </article>
          ))}
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────────────── */}
      <section id="how" className="scroll-mt-20 border-y border-border bg-surface/40">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:py-28">
          <SectionHeading eyebrow="How it works" title="Policy in, verdict out.">
            Three steps, all in your repository and all deterministic.
          </SectionHeading>
          <ol className="mt-12 grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
            <li className="flex flex-col">
              <span className="font-mono text-sm text-accent">01</span>
              <h3 className="mt-2 font-display text-xl font-semibold">Write the policy</h3>
              <p className="mt-2 text-muted">Limits, allowlists and approval thresholds in strict, reviewable YAML. Quoted decimal amounts only.</p>
              <Terminal className="mt-5 flex-1" title="policies/default.yaml" lines={POLICY} />
            </li>
            <li className="flex flex-col">
              <span className="font-mono text-sm text-accent">02</span>
              <h3 className="mt-2 font-display text-xl font-semibold">Attack it</h3>
              <p className="mt-2 text-muted">
                Limits, recipients, networks, approvals, concurrency and malformed input, against the engine or your own guard.
              </p>
              <Terminal
                className="mt-5 flex-1"
                title="terminal"
                lines={[
                  { text: "agentguard test", tone: "cmd" },
                  { text: "PASS    approval-not-transferable", tone: "pass" },
                  { text: "PASS    concurrent-requests-respect-daily-limit", tone: "pass" },
                  { text: "PASS    negative-amount", tone: "pass" },
                  { text: "…", tone: "muted" },
                  { text: "Result: PASSED  (exit code 0)", tone: "pass" },
                ]}
              />
            </li>
            <li className="flex flex-col">
              <span className="font-mono text-sm text-accent">03</span>
              <h3 className="mt-2 font-display text-xl font-semibold">Gate every change</h3>
              <p className="mt-2 text-muted">
                One CI step. A loosened limit or a new payee fails the pull request with a finding that explains why.
              </p>
              <Terminal className="mt-5 flex-1" title=".github/workflows/agentguard.yml" lines={CI} />
            </li>
          </ol>
        </div>
      </section>

      {/* ── Features ─────────────────────────────────────────────────────── */}
      <section id="features" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:py-28">
        <SectionHeading eyebrow="What's inside" title="Built like security tooling, because it is." />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <article key={f.title} className={`rounded-2xl border border-border bg-surface p-6 ${f.wide ? "sm:col-span-2" : ""}`}>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-brand text-black">
                <Icon name={f.icon} />
              </div>
              <h3 className="mt-4 font-display text-lg font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-muted">{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ── NEAR ─────────────────────────────────────────────────────────── */}
      <section id="near" className="scroll-mt-20 px-4 pb-20 sm:pb-28">
        <div className="relative isolate mx-auto max-w-6xl overflow-hidden rounded-3xl border-gradient p-6 sm:p-12">
          <div aria-hidden="true" className="absolute inset-0 -z-10 bg-glow opacity-80" />
          <div className="grid gap-10 lg:grid-cols-2">
            <SectionHeading eyebrow="Built for NEAR" title="From policy decision to testnet transfer, behind one gate.">
              The NEAR package validates account IDs, handles 24-decimal yoctoNEAR exactly, and executes only reservations that AgentGuard
              authorised, with a single broadcast and no automatic re-signing.
            </SectionHeading>
            <div>
              <ul className="space-y-3">
                {NEAR_STATUS.map((s) => (
                  <li key={s.text} className="flex gap-3 rounded-xl border border-border bg-surface/80 p-4 backdrop-blur">
                    <span
                      className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${s.done ? "bg-pass-bg text-pass" : "bg-skip-bg text-skip"}`}
                    >
                      <Icon name={s.done ? "check" : "pending"} className="h-4 w-4" />
                    </span>
                    <span className="text-sm">
                      <span className="sr-only">{s.done ? "Done: " : "Pending: "}</span>
                      {s.text}
                    </span>
                  </li>
                ))}
              </ul>
              <a href={docUrl("integrations.md")} className="mt-5 inline-flex min-h-11 items-center gap-2 font-medium text-accent">
                Read the integration notes <Icon name="arrow" className="h-4 w-4" />
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── Quick start ──────────────────────────────────────────────────── */}
      <section id="quickstart" className="scroll-mt-20 border-t border-border bg-surface/40">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-20 sm:py-28 lg:grid-cols-2 [&>*]:min-w-0">
          <div>
            <SectionHeading eyebrow="Quick start" title={<>Your first verdict in <span className="text-gradient">under a minute</span>.</>}>
              Node 22 and pnpm. Everything runs locally. Nothing is signed or sent.
            </SectionHeading>
            <div className="mt-8 flex flex-wrap gap-3">
              <PrimaryLink href="/dashboard">See the dashboard</PrimaryLink>
              <SecondaryLink href={docUrl("adoption.md")}>Use it in your project</SecondaryLink>
            </div>
          </div>
          <Terminal
            title="quick start"
            lines={[
              { text: `git clone ${GITHUB}.git`, tone: "cmd" },
              { text: "cd agentguard-ci && pnpm install && pnpm build", tone: "cmd" },
              { text: 'alias agentguard="node $PWD/packages/cli/dist/bin.js"', tone: "cmd" },
              { text: "mkdir ~/my-agent && cd ~/my-agent && agentguard init", tone: "cmd" },
              { text: "agentguard test", tone: "cmd" },
              { text: "" },
              { text: "Result: PASSED  (exit code 0)", tone: "pass" },
            ]}
          />
        </div>
      </section>
    </>
  );
}
