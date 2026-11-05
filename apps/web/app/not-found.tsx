import Link from "next/link";
import { EmptyState } from "@/components/ui";

export default function NotFound() {
  return (
    <EmptyState title="Not found" level={1}>
      <p>That run, scenario or finding does not exist in the configured reports directory.</p>
      <Link
        href="/runs"
        className="mt-4 inline-flex min-h-11 items-center rounded-md border border-border px-4 font-medium text-accent hover:bg-surface-2"
      >
        Back to test runs
      </Link>
    </EmptyState>
  );
}
