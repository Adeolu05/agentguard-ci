import Link from "next/link";
import { Wordmark } from "@/components/brand";

export default function NotFound() {
  return (
    <main id="main" className="relative isolate flex flex-1 flex-col items-center justify-center px-4 py-20 text-center">
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-glow" />
      <Wordmark />
      <p className="mt-10 font-mono text-sm text-accent">404</p>
      <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight sm:text-4xl">Not found</h1>
      <p className="mt-3 max-w-md text-muted">That page, run, scenario or finding does not exist in the configured reports directory.</p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link href="/dashboard" className="inline-flex min-h-11 items-center rounded-xl bg-fg px-5 font-semibold text-bg">
          Open the dashboard
        </Link>
        <Link href="/runs" className="inline-flex min-h-11 items-center rounded-xl border border-border-strong px-5 font-semibold">
          Back to test runs
        </Link>
      </div>
    </main>
  );
}
