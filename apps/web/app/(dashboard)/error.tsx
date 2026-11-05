"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-fail bg-fail-bg p-6 text-sm text-fail">
      <h1 className="text-base font-semibold">The dashboard could not load its data</h1>
      <p className="mt-2">{error.message || "Unknown error"}</p>
      <p className="mt-2">No results are shown rather than partial or possibly incorrect ones.</p>
      <button type="button" onClick={reset} className="mt-4 rounded border border-fail px-3 py-1.5 font-medium">
        Try again
      </button>
    </div>
  );
}
