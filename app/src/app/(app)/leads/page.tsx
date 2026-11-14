import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace } from "@/lib/workspace";
import { when } from "@/components/email/format";
import { t } from "@/messages/pt";

type Run = { id: string; title: string; is_partial: boolean; created_at: string };

// Placeholder until the unified list (F3): the finished searches, each linking to its result. Read as the user (RLS).
export default async function LeadsPage() {
  const supabase = await createClient();
  const workspace = await getCurrentWorkspace();
  let runs: Run[] = [];
  if (supabase && workspace) {
    const { data } = await supabase
      .from("research_runs")
      .select("id, title, is_partial, created_at")
      .eq("workspace_id", workspace.id)
      .eq("status", "done")
      .order("created_at", { ascending: false })
      .limit(50);
    runs = (data ?? []) as Run[];
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-sm">{t.leads.soon}</p>
      {runs.length === 0 ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted">{t.leads.none}</p>
          <Link
            href="/agentes"
            className="inline-flex min-h-11 items-center border border-blue bg-surface px-4 text-sm font-semibold text-blue no-underline hover:bg-blue-wash"
          >
            {t.leads.start}
          </Link>
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col border border-line bg-surface p-0">
          {runs.map((r) => (
            <li key={r.id} className="border-b border-line last:border-b-0">
              <Link href={`/agentes/pesquisa/${r.id}`} className="block px-3.5 py-3 text-ink no-underline hover:bg-ground">
                <span className="block text-sm font-semibold">{r.title}</span>
                <span className="block text-[13px] text-muted">
                  {r.is_partial ? `${t.research.partialTag} · ` : ""}
                  {when(r.created_at)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
