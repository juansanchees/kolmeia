import Link from "next/link";
import { PagedTable } from "@/components/Pager";
import { NewListForm } from "@/components/lists/NewListForm";
import { listStats } from "@/lib/lists/queries";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { t } from "@/messages/pt";

const L = t.lists;
const pct = (n: number, of: number) => (of > 0 ? `${Math.round((100 * n) / of)}%` : "—");

// Named lists of leads. Owner/sdr only (the closer is sent back to LEADS; RLS gives her no list rows anyway).
export default async function ListsPage() {
  const workspace = await requireSender();
  const supabase = await createClient();
  const rows = supabase ? await listStats(supabase, workspace.id) : [];
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-2xl">{L.title}</h2>
        <p className="text-sm text-muted">{L.subtitle}</p>
      </header>
      <NewListForm />
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{L.empty}</p>
      ) : (
        <PagedTable
          wrapClassName="overflow-x-auto border border-line bg-surface"
          className="w-full min-w-[640px] border-collapse text-sm"
          head={
        <tr className="border-b border-line text-left font-mono text-xs uppercase tracking-wide text-muted">
          <th scope="col" className="px-3 py-2 font-normal">{L.columns.name}</th>
          <th scope="col" className="px-3 py-2 text-right font-normal">{L.columns.leads}</th>
          <th scope="col" className="px-3 py-2 text-right font-normal">{L.columns.contacted}</th>
          <th scope="col" className="px-3 py-2 text-right font-normal">{L.columns.phone}</th>
          <th scope="col" className="px-3 py-2 font-normal">{L.columns.actions}</th>
        </tr>
          }
        >
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-line last:border-b-0">
              <th scope="row" className="px-3 py-2 text-left font-semibold">{r.name}</th>
              <td className="px-3 py-2 text-right font-mono">{r.leads}</td>
              <td className="px-3 py-2 text-right font-mono">{pct(r.contacted, r.leads)}</td>
              <td className="px-3 py-2 text-right font-mono">{r.with_phone}</td>
              <td className="px-3 py-2">
                <span className="flex flex-wrap gap-3">
                  <Link href={`/leads?lista=${r.id}`} className="inline-flex min-h-11 items-center text-blue underline underline-offset-4">{L.open}</Link>
                  <a href={`/api/leads/lists/${r.id}/csv`} download className="inline-flex min-h-11 items-center text-blue underline underline-offset-4">{L.csv}</a>
                </span>
              </td>
            </tr>
          ))}
        </PagedTable>
      )}
      <p className="text-sm text-muted">{L.csvNote}</p>
    </div>
  );
}
