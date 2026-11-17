import Link from "next/link";
import { Paged } from "@/components/Pager";
import { callResultLogs } from "@/lib/calls/call-queries";
import { OUTCOME_GROUPS, latestOutcomeGroups, type OutcomeGroup } from "@/lib/calls/outcome-groups";
import { listLeads } from "@/lib/leads/queries";
import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace, getUser } from "@/lib/workspace";
import { getT } from "@/lib/i18n/server";
import { SectionIntro } from "@/components/leads/SectionIntro";
import { Badge, CountPill, EmptyState, HexPanel, segItemCls, segWrapCls } from "@/components/ui";

const when = (iso: string, intl: string) => new Date(iso).toLocaleString(intl, { timeZone: "America/New_York", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// Leads by the result of their last registered contact. Read as the user (RLS: the closer sees only her own leads and calls).
export default async function ResultsPage({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const t = await getT();
  const R = t.results;
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
    <div className="flex min-w-0 flex-col gap-5">
      <SectionIntro title={R.title} subtitle={R.subtitle} />
      <nav aria-label={R.tabs.label} className={`k-in ${segWrapCls} [animation-delay:.15s]`}>
        {OUTCOME_GROUPS.map((g) => (
          <Link key={g} href={`/leads/resultados?aba=${g}`} aria-current={g === tab ? "page" : undefined} className={segItemCls(g === tab)}>
            {R.tabs[g]}
            <CountPill tone={g === tab ? "honey" : "cold"}>{groups[g].length}</CountPill>
          </Link>
        ))}
      </nav>
      <div key={tab} className="k-fade flex min-w-0 flex-col gap-3">
        {total === 0 ? (
          <EmptyState title={R.empty} />
        ) : rows.length === 0 ? (
          <EmptyState title={R.emptyGroup} />
        ) : (
          <HexPanel as="section" aria-label={R.tabs[tab]} c={18} cSm={10} className="py-5">
            <Paged as="ul" resetKey={tab} className="m-0 flex list-none flex-col p-0">
              {rows.map((r) => {
                const l = lead.get(r.lead_id);
                return (
                  <li key={r.id} className="k-row flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[#eef0f3] px-3 py-4 last:border-b-0">
                    <span className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
                      <Link href={`/leads?lead=${r.lead_id}`} className="k-link truncate text-[17px] font-semibold underline-offset-4 hover:underline">{l?.display.name ?? t.tasks.lead}</Link>
                      {l?.display.city && <span className="text-[15px] text-[#4a5361]">{l.display.city}</span>}
                    </span>
                    <Badge tone="honey" dot>{r.outcome === "gatekeeper" ? t.calls.outcomes.gatekeeper : R.tabs[tab]}</Badge>
                    <span title={r.notes} className="min-w-0 flex-[2_1_220px] truncate text-[15px] text-[#4a5361]">{r.notes || R.unknown}</span>
                    <span className="text-[15px]">{who(r.called_by)}</span>
                    <span className="flex flex-col font-mono text-sm text-[#4a5361]">
                      <span>{when(r.called_at, t.intl)}</span>
                      {tab === "call_back" && r.next_step_at && <span className="font-semibold text-ink">{R.callBack} {when(r.next_step_at, t.intl)}</span>}
                    </span>
                  </li>
                );
              })}
            </Paged>
          </HexPanel>
        )}
      </div>
    </div>
  );
}
