import Link from "next/link";
import { Paged } from "@/components/Pager";
import { NewListForm } from "@/components/lists/NewListForm";
import { SectionIntro } from "@/components/leads/SectionIntro";
import { buttonClass, Chevron, EmptyState } from "@/components/ui";
import { listStats } from "@/lib/lists/queries";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { getT } from "@/lib/i18n/server";

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((100 * n) / of)}%` : "—");
const LIST_ICON = "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01";

// Named lists of leads. Owner/sdr only (the closer is sent back to LEADS; RLS gives her no list rows anyway).
export default async function ListsPage() {
  const t = await getT();
  const L = t.lists;
  const workspace = await requireSender();
  const supabase = await createClient();
  const rows = supabase ? await listStats(supabase, workspace.id) : [];
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <SectionIntro title={L.title} subtitle={L.subtitle} />
      <NewListForm />
      {rows.length === 0 ? (
        <EmptyState icon={LIST_ICON} title={L.empty} />
      ) : (
        <Paged as="ul" className="m-0 grid list-none gap-3.5 p-0 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
          {rows.map((r) => (
            <li key={r.id} className="k-in flex min-w-0 flex-col gap-4 rounded-2xl border border-[#e3e6ec] bg-surface p-5 shadow-[0_6px_14px_-8px_rgba(15,27,61,0.12)]">
              <h3 className="m-0 flex min-w-0 items-center gap-2.5 text-lg font-semibold">
                <span aria-hidden className="hxv inline-flex h-[38px] w-[34px] shrink-0 items-center justify-center bg-honey-soft text-ink">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={LIST_ICON} /></svg>
                </span>
                <span className="min-w-0 break-words">{r.name}</span>
              </h3>
              <dl className="m-0 grid grid-cols-3 gap-2 rounded-[14px] bg-ground px-3 py-2.5">
                {[
                  [L.columns.leads, String(r.leads)],
                  [L.columns.contacted, pct(r.contacted, r.leads)],
                  [L.columns.phone, String(r.with_phone)],
                ].map(([k, v]) => (
                  <div key={k} className="flex min-w-0 flex-col">
                    <dt className="truncate text-[13px] text-[#4a5361]">{k}</dt>
                    <dd className="m-0 font-mono text-xl font-semibold">{v}</dd>
                  </div>
                ))}
              </dl>
              <span className="mt-auto flex flex-wrap gap-2">
                <Link href={`/leads?lista=${r.id}`} className={buttonClass("primary", "sm")}>
                  {L.open} <Chevron size={16} className="k-arrow" />
                </Link>
                <a href={`/api/leads/lists/${r.id}/csv`} download className={buttonClass("secondary", "sm")}>{L.csv}</a>
              </span>
            </li>
          ))}
        </Paged>
      )}
      <p className="m-0 text-base text-[#4a5361]">{L.csvNote}</p>
    </div>
  );
}
