import { requireSender } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { listLeads } from "@/lib/leads/queries";
import { FUNNEL_STATUSES, funnelByOrigin } from "@/lib/leads/funnel";
import { getT } from "@/lib/i18n/server";
import { BlockTitle, SectionIntro } from "@/components/leads/SectionIntro";
import { EmptyState, HexPanel } from "@/components/ui";

const FUNNEL_ICON = "M3 4h18l-7 8v6l-4 2v-8L3 4z";

// Funnel by origin: numbers only, from the same list as LEADS (owner and sdr).
export default async function FunnelPage() {
  const t = await getT();
  const F = t.funnel;
  const workspace = await requireSender();
  const supabase = await createClient();
  const rows = supabase ? funnelByOrigin(await listLeads(supabase, workspace.id), t) : [];
  const keys = [...FUNNEL_STATUSES, "discarded"] as const;
  const totals = Object.fromEntries([...keys, "all"].map((k) => [k, 0])) as Record<string, number>;
  for (const r of rows) {
    for (const k of keys) totals[k] += r.counts[k];
    totals.all += r.total;
  }
  const label = (k: string) => t.leads.statuses[k as keyof typeof t.leads.statuses];
  const top = Math.max(1, ...keys.map((k) => totals[k]));
  const th = "border-b-2 border-[#e3e6ec] px-3 py-3 text-left text-[15px] font-semibold text-[#4a5361]";
  const td = "border-b border-[#eef0f3] px-3 py-3 text-right font-mono text-[15px] tabular-nums";

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <SectionIntro title={F.title} subtitle={F.subtitle} />
      {rows.length === 0 ? (
        <EmptyState icon={FUNNEL_ICON} title={F.empty}>{F.emptyHint}</EmptyState>
      ) : (
        <>
          <HexPanel as="section" aria-labelledby="funnel-all" c={20} cSm={10} className="flex flex-col gap-4 py-6" wrapClassName="k-in [animation-delay:.15s]">
            <BlockTitle id="funnel-all">{F.overall}</BlockTitle>
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {keys.map((k) => (
                <li key={k} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3 text-base md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]">
                  <span className="truncate font-medium">{label(k)}</span>
                  <span aria-hidden className="h-4 overflow-hidden rounded-full bg-cold">
                    <span className="block h-full rounded-full bg-honey" style={{ width: `${(100 * totals[k]) / top}%` }} />
                  </span>
                  <span className="min-w-10 text-right font-mono font-semibold tabular-nums">{totals[k]}</span>
                </li>
              ))}
            </ul>
          </HexPanel>

          <section aria-labelledby="funnel-origin" className="k-in flex min-w-0 flex-col gap-3 [animation-delay:.22s]">
            <BlockTitle id="funnel-origin">{F.byOrigin}</BlockTitle>
            <div className="min-w-0 overflow-x-auto rounded-2xl border border-[#e3e6ec] bg-surface px-2">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th scope="col" className={th}>{F.origin}</th>
                    {keys.map((k) => (
                      <th key={k} scope="col" className={`${th} text-right`}>{label(k)}</th>
                    ))}
                    <th scope="col" className={`${th} text-right`}>{t.funnel.total}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.origin} className="k-row">
                      <th scope="row" className="border-b border-[#eef0f3] px-3 py-3 text-left text-base font-medium">{r.origin}</th>
                      {keys.map((k) => (
                        <td key={k} className={`${td} ${r.counts[k] === 0 ? "text-[#4a5361]" : ""}`}>{r.counts[k]}</td>
                      ))}
                      <td className={`${td} font-semibold`}>{r.total}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-honey-soft">
                    <th scope="row" className="px-3 py-3 text-left text-base font-semibold">{t.funnel.total}</th>
                    {keys.map((k) => (
                      <td key={k} className={`${td} border-b-0 font-semibold`}>{totals[k]}</td>
                    ))}
                    <td className={`${td} border-b-0 font-semibold`}>{totals.all}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
