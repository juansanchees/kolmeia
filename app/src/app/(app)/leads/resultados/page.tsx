import Link from "next/link";
import { Paged } from "@/components/Pager";
import { callResultLogs } from "@/lib/calls/call-queries";
import { OUTCOME_GROUPS, latestOutcomeGroups, type OutcomeGroup } from "@/lib/calls/outcome-groups";
import { listLeads } from "@/lib/leads/queries";
import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace, getUser } from "@/lib/workspace";
import { t } from "@/messages/pt";

const R = t.results;
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/New_York", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

// Leads by the result of their last registered contact. Read as the user (RLS: the closer sees only her own leads and calls).
export default async function ResultsPage({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const supabase = await createClient();
  const workspace = await getCurrentWorkspace();
  if (!supabase || !workspace) return null;
  const pick = (await searchParams).aba;
  const tab: OutcomeGroup = OUTCOME_GROUPS.includes(pick as OutcomeGroup) ? (pick as OutcomeGroup) : OUTCOME_GROUPS[0];
  const user = await getUser();

  const groups = latestOutcomeGroups(await callResultLogs(supabase, workspace.id));
  const total = OUTCOME_GROUPS.reduce((n, g) => n + groups[g].length, 0);
  const rows = groups[tab];
  // closers cannot list people (sender-only RPC): they only see their own calls anyway
  const [leads, people] = await Promise.all([
    rows.length > 0 ? listLeads(supabase, workspace.id, { ids: rows.map((r) => r.lead_id) }) : [],
    workspace.role === "closer" ? null : supabase.rpc("list_workspace_people", { p_ws: workspace.id }),
  ]);
  const lead = new Map(leads.map((i) => [i.lead.id, i]));
  const person = new Map(((people?.data ?? []) as { user_id: string; role: keyof typeof t.team.roles; label: string }[]).map((p) => [p.user_id, p]));
  // the RPC's label is the invited name, or the raw role when there is none: show the Portuguese role then, never "owner"
  const who = (id: string | null) => {
    if (id && id === user?.id) return R.you;
    const p = id ? person.get(id) : undefined;
    // a closer cannot list people: the other calls are the team's
    return p ? (p.label === p.role ? t.team.roles[p.role] : p.label) : people === null && id ? R.team : R.unknown;
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-2xl">{R.title}</h2>
        <p className="text-sm text-muted">{R.subtitle}</p>
      </header>
      <nav aria-label={R.tabs.label} className="flex flex-wrap border-b border-line">
        {OUTCOME_GROUPS.map((g) => (
          <Link
            key={g}
            href={`/leads/resultados?aba=${g}`}
            aria-current={g === tab ? "page" : undefined}
            className={`-mb-px inline-flex min-h-11 items-center border-b-[3px] px-4 text-[15px] no-underline ${g === tab ? "border-blue font-semibold text-ink" : "border-transparent text-muted hover:text-ink"}`}
          >
            {R.tabs[g]}
            <span className="ml-1.5 bg-ground px-1.5 font-mono text-[13px]">{groups[g].length}</span>
          </Link>
        ))}
      </nav>
      {total === 0 ? (
        <p className="text-sm text-muted">{R.empty}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">{R.emptyGroup}</p>
      ) : (
        <Paged as="ul" resetKey={tab} className="m-0 flex list-none flex-col border border-line bg-surface p-0">
          {rows.map((r) => {
            const l = lead.get(r.lead_id);
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 last:border-b-0">
                <span className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
                  <Link href={`/leads?lead=${r.lead_id}`} className="font-semibold text-ink underline-offset-4 hover:underline">{l?.display.name ?? t.tasks.lead}</Link>
                  {l?.display.city && <span className="text-sm text-muted">{l.display.city}</span>}
                </span>
                <span className="min-w-[96px] bg-blue-wash px-2.5 py-1 text-center font-mono text-xs uppercase tracking-wide">
                  {r.outcome === "gatekeeper" ? t.calls.outcomes.gatekeeper : R.tabs[tab]}
                </span>
                <span title={r.notes} className="min-w-0 flex-[2_1_220px] truncate text-sm text-muted">{r.notes || R.unknown}</span>
                <span className="text-sm">{who(r.called_by)}</span>
                <span className="flex flex-col font-mono text-[13px] text-muted">
                  <span>{when(r.called_at)}</span>
                  {tab === "call_back" && r.next_step_at && <span className="text-ink">{R.callBack} {when(r.next_step_at)}</span>}
                </span>
              </li>
            );
          })}
        </Paged>
      )}
    </div>
  );
}
