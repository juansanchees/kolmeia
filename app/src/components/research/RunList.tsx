"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { RunStatus } from "@/lib/research/types";
import { useT } from "@/lib/i18n/client";
import { Paged } from "@/components/Pager";

export type RunListItem = { id: string; title: string; status: RunStatus; is_partial: boolean; created_at: string };

export function RunList({ runs }: { runs: RunListItem[] }) {
  const t = useT();
  const M = t.research;
  const pathname = usePathname();
  return (
    <>
      <Link
        href="/agentes"
        className="flex min-h-[46px] items-center justify-center border border-blue bg-surface text-[15px] font-semibold text-blue hover:bg-blue-wash"
      >
        {M.newResearch}
      </Link>
      <nav aria-label={M.yourResearch} className="border border-line bg-surface">
        <div className="border-b border-ink px-3.5 py-2.5 font-mono text-xs text-muted">{M.yourResearch}</div>
        {runs.length === 0 && <p className="px-3.5 py-3 text-sm text-muted">{M.empty}</p>}
        <Paged as="ul" className="m-0 list-none p-0">
          {runs.map((r) => {
            const current = pathname === `/agentes/pesquisa/${r.id}`;
            return (
              <li key={r.id} className="border-b border-line last:border-b-0">
                <Link
                  href={`/agentes/pesquisa/${r.id}`}
                  aria-current={current ? "page" : undefined}
                  className={`block px-3.5 py-3 text-ink no-underline ${current ? "bg-blue-wash shadow-[inset_3px_0_0_var(--color-blue)]" : "hover:bg-ground"}`}
                >
                  <span className="block text-sm font-semibold">{r.title}</span>
                  <span className="block text-[13px] text-muted">
                    {M.status[r.status]}
                    {r.is_partial ? ` · ${M.partialTag}` : ""}
                  </span>
                </Link>
              </li>
            );
          })}
        </Paged>
      </nav>
    </>
  );
}
