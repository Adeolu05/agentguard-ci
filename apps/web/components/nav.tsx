"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/runs", label: "Test runs" },
  { href: "/scenarios", label: "Scenarios" },
  { href: "/policy", label: "Policy" },
];

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** Main navigation: equal-width 44px touch targets on phones, compact tabs from `sm` up. */
export function MainNav() {
  const pathname = usePathname() ?? "/";
  return (
    <nav aria-label="Main" className="w-full sm:w-auto">
      <ul className="grid grid-cols-4 gap-1 text-sm sm:flex">
        {NAV.map((n) => {
          const active = isActive(pathname, n.href);
          return (
            <li key={n.href}>
              <Link
                href={n.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-11 items-center justify-center rounded-md px-2 text-center whitespace-nowrap sm:min-h-9 sm:px-3 ${
                  active ? "bg-surface-2 font-medium text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"
                }`}
              >
                {n.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
