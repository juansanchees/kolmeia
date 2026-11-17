"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { areasFor, activeHref } from "@/lib/nav";
import type { Role } from "@/lib/roles";

export function NavLinks({ variant, role }: { variant: "top" | "bottom"; role: Role }) {
  const t = useT();
  const pathname = usePathname();
  const items = areasFor(role, t);
  const active = activeHref(pathname, items.map((a) => a.href));
  const bottom = variant === "bottom";
  return (
    <nav
      aria-label={t.nav.label}
      className={
        bottom
          ? "fixed inset-x-0 bottom-0 z-20 grid grid-flow-col auto-cols-fr border-t border-[#e3e6ec] bg-surface shadow-[0_-6px_16px_-10px_rgba(15,27,61,0.18)] md:hidden pb-[env(safe-area-inset-bottom)]"
          : "hidden md:flex flex-wrap gap-1"
      }
    >
      {items.map((l) => {
        const current = l.href === active;
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={current ? "page" : undefined}
            className={
              bottom
                ? `flex min-h-14 items-center justify-center border-t-4 px-2 text-center font-mono text-xs uppercase tracking-wide text-ink ${current ? "border-honey bg-honey-soft font-medium" : "border-transparent"}`
                : `flex min-h-12 items-center border-b-4 px-3.5 font-mono text-[15px] uppercase tracking-wide text-ink no-underline transition-colors hover:border-honey-edge ${current ? "border-honey font-medium" : "border-transparent"}`
            }
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
