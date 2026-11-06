import Link from "next/link";
import { useId } from "react";

/** Drainproof mark: a shield with a check, stroked with the brand gradient. */
export function LogoMark({ className = "h-7 w-7" }: { className?: string }) {
  const id = useId();
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" className={className}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--brand-1)" />
          <stop offset="0.5" stopColor="var(--brand-2)" />
          <stop offset="1" stopColor="var(--brand-3)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" className="fill-surface-2" />
      <path d="M16 5.5l8.5 3.2v6.1c0 5.4-3.6 9.9-8.5 11.7-4.9-1.8-8.5-6.3-8.5-11.7V8.7z" fill="none" stroke={`url(#${id})`} strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M12.4 16.2l2.6 2.6 4.8-5.2" fill="none" stroke={`url(#${id})`} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex min-h-11 items-center gap-2.5 font-display text-[1.05rem] font-semibold tracking-tight sm:min-h-9">
      <LogoMark />
      Drainproof
    </Link>
  );
}
