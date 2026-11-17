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
          ? "fixed inset-x-0 bottom-0 z-20 grid grid-flow-col auto-cols-fr border-t border-line bg-surface md:hidden pb-[env(safe-area-inset-bottom)]"
          : "hidden md:flex mx-auto max-w-6xl gap-1 px-4"
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
                ? `flex min-h-14 items-center justify-center px-2 text-center font-mono text-xs uppercase tracking-wide ${current ? "text-blue" : ""}`
                : `border-b-2 px-3 py-2 font-mono text-xs uppercase tracking-wide ${current ? "border-honey text-blue" : "border-transparent"}`
            }
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
