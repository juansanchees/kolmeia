"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeHref, type NavItem } from "@/lib/nav";
import { segItemCls, segWrapCls } from "./ui";

/** An area's own sub-navigation: a rounded segmented tab bar (selected = navy). Wraps on narrow screens. */
export function SubNav({ label, items }: { label: string; items: readonly NavItem[] }) {
  const active = activeHref(usePathname(), items.map((i) => i.href));
  return (
    <nav aria-label={label} className={`${segWrapCls} self-start`}>
      {items.map((l) => {
        const current = l.href === active;
        return (
          <Link key={l.href} href={l.href} aria-current={current ? "page" : undefined} className={segItemCls(current)}>
            {current && (
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden className="shrink-0">
                <path className="fill-honey" d="M12 2 20.7 7v10L12 22 3.3 17V7Z" />
              </svg>
            )}
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
