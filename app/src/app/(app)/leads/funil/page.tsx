import { requireSender } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { listLeads } from "@/lib/leads/queries";
import { FUNNEL_STATUSES, funnelByOrigin } from "@/lib/leads/funnel";
import { t } from "@/messages/pt";

// Funnel by origin: numbers only, from the same list as LEADS (owner and sdr).
export default async function FunnelPage() {
  const workspace = await requireSender();
  const supabase = await createClient();
  const rows = supabase ? funnelByOrigin(await listLeads(supabase, workspace.id)) : [];
  const totals = Object.fromEntries([...FUNNEL_STATUSES, "discarded", "all"].map((k) => [k, 0])) as Record<string, number>;
  for (const r of rows) {
    for (const k of [...FUNNEL_STATUSES, "discarded"] as const) totals[k] += r.counts[k];
    totals.all += r.total;
  }
  const th = "border-b border-ink px-3 py-2 text-left font-mono text-xs font-semibold uppercase";
  const td = "border-b border-line px-3 py-2 text-right font-mono text-sm tabular-nums";
  return (
    <div className="min-w-0 overflow-x-auto border border-line bg-surface">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th scope="col" className={th}>{t.funnel.origin}</th>
            {[...FUNNEL_STATUSES, "discarded"].map((k) => (
              <th key={k} scope="col" className={`${th} text-right`}>{t.leads.statuses[k as keyof typeof t.leads.statuses]}</th>
            ))}
            <th scope="col" className={`${th} text-right`}>{t.funnel.total}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.origin}>
              <th scope="row" className="border-b border-line px-3 py-2 text-left text-sm font-medium">{r.origin}</th>
              {[...FUNNEL_STATUSES, "discarded"].map((k) => (
                <td key={k} className={td}>{r.counts[k as keyof typeof r.counts]}</td>
              ))}
              <td className={`${td} font-semibold`}>{r.total}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="px-3 py-2 text-left text-sm font-semibold">{t.funnel.total}</th>
            {[...FUNNEL_STATUSES, "discarded"].map((k) => (
              <td key={k} className={`${td} border-b-0`}>{totals[k]}</td>
            ))}
            <td className={`${td} border-b-0 font-semibold`}>{totals.all}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
