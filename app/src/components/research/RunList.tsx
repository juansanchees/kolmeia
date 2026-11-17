"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { RunStatus } from "@/lib/research/types";
import { useT } from "@/lib/i18n/client";
import { Paged } from "@/components/Pager";
import { buttonClass, CountPill } from "@/components/ui";

export type RunListItem = { id: string; title: string; status: RunStatus; is_partial: boolean; created_at: string };

export function RunList({ runs }: { runs: RunListItem[] }) {
  const t = useT();
  const M = t.research;
  const pathname = usePathname();
  return (
    <>
      <Link href="/agentes" className={`${buttonClass("secondary")} w-full`}>
        {M.newResearch}
      </Link>
      <nav aria-label={M.yourResearch} className="flex flex-col gap-1 rounded-2xl border border-[#e3e6ec] bg-surface p-2 shadow-[0_6px_14px_-8px_rgba(15,27,61,0.12)]">
        <div className="flex items-center gap-2 px-2.5 pb-1 pt-1.5 font-mono text-[13px] uppercase tracking-wide text-[#4a5361]">
          {M.yourResearch} {runs.length > 0 && <CountPill tone="cold">{runs.length}</CountPill>}
        </div>
        {runs.length === 0 && <p className="m-0 px-2.5 pb-2 text-base text-[#4a5361]">{M.empty}</p>}
        <Paged as="ul" className="m-0 flex list-none flex-col gap-1 p-0">
          {runs.map((r) => {
            const current = pathname === `/agentes/pesquisa/${r.id}`;
            return (
              <li key={r.id}>
                <Link
                  href={`/agentes/pesquisa/${r.id}`}
                  aria-current={current ? "page" : undefined}
                  className={`flex min-h-12 flex-col justify-center rounded-[12px] px-3 py-2.5 text-ink no-underline ${current ? "bg-honey-light shadow-[inset_4px_0_0_var(--color-honey)]" : "k-row"}`}
                >
                  <span className="block text-base font-semibold">{r.title}</span>
                  <span className="block text-[15px] text-[#4a5361]">
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
