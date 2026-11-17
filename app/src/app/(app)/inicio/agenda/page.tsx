import { HomeTabs } from "@/components/home/HomeTabs";
import { AgendaView } from "@/components/tasks/AgendaView";
import { addDays, monthGrid, parseAgenda } from "@/lib/agenda/view";
import { nyLocalToIso } from "@/lib/calls/call-input";
import { stageOf } from "@/lib/leads/classify";
import { listLeads } from "@/lib/leads/queries";
import { isSender } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { tasksBetween } from "@/lib/tasks/queries";
import type { Person } from "@/lib/team/types";
import { getCurrentWorkspace, getUser } from "@/lib/workspace";
import { getT } from "@/lib/i18n/server";

// Início > Agenda: the tasks of the shown month by New York day (RLS: the closer sees those of her leads).
export default async function AgendaPage({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const t = await getT();
  const supabase = await createClient();
  const workspace = await getCurrentWorkspace();
  const user = await getUser();
  if (!supabase || !workspace || !user) return null;
  const sender = isSender(workspace.role);
  const now = new Date();
  const state = parseAgenda(await searchParams, now);
  const grid = monthGrid(state.year, state.month);
  const from = nyLocalToIso(`${grid[0][0]}T00:00`)!;
  const to = nyLocalToIso(`${addDays(grid[grid.length - 1][6], 1)}T00:00`)!;

  const [tasks, items, people] = await Promise.all([
    tasksBetween(supabase, workspace.id, from, to),
    listLeads(supabase, workspace.id),
    sender ? supabase.rpc("list_workspace_people", { p_ws: workspace.id }).then((r) => (r.data ?? []) as Person[]) : null,
  ]);
  const lead = new Map(items.map((i) => [i.lead.id, i]));
  const rows = tasks.map((x) => ({ ...x, name: lead.get(x.lead_id)?.display.name ?? t.tasks.lead }));
  // the dialog's search: leads that are still open
  const leads = items
    .filter((i) => stageOf(i.lead) !== "closed")
    .map((i) => ({ id: i.lead.id, name: i.display.name, city: i.display.city?.trim() || null }))
    .sort((a, b) => a.name.localeCompare(b.name, t.intl));

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-[1240px] flex-col gap-5">
      <HomeTabs current="agenda" t={t} />
      <AgendaView state={state} grid={grid} items={rows} people={people} me={user.id} leads={leads} />
    </div>
  );
}
