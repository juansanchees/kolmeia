"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeHref, type NavItem } from "@/lib/nav";

/** An area's own sub-navigation. Wraps on narrow screens (no horizontal scroll at 390 px). */
export function SubNav({ label, items }: { label: string; items: readonly NavItem[] }) {
  const active = activeHref(usePathname(), items.map((i) => i.href));
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1.5">
      {items.map((l) => {
        const current = l.href === active;
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={current ? "page" : undefined}
            className={`inline-flex min-h-11 items-center border px-3.5 text-sm no-underline ${current ? "border-ink bg-ink font-semibold text-white" : "border-edge bg-surface text-ink hover:border-ink"}`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
