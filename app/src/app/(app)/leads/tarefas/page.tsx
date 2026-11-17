import Link from "next/link";
import { TaskButtons } from "@/components/tasks/TaskButtons";
import { listLeads } from "@/lib/leads/queries";
import { createClient } from "@/lib/supabase/server";
import { openTasks } from "@/lib/tasks/queries";
import { TASK_TABS, taskTab, type TaskTab } from "@/lib/tasks/view";
import { getCurrentWorkspace } from "@/lib/workspace";
import { getT } from "@/lib/i18n/server";
import { Paged } from "@/components/Pager";
import { SectionIntro } from "@/components/leads/SectionIntro";
import { Badge, CountPill, EmptyState, HexPanel, segItemCls, segWrapCls } from "@/components/ui";

const when = (iso: string, intl: string) =>
  new Date(iso).toLocaleString(intl, { timeZone: "America/New_York", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// Open tasks by New York day: Hoje / Atrasadas / Próximas. Read as the user (RLS: the closer sees those of her leads).
export default async function TasksPage({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const t = await getT();
  const T = t.tasks;
  const supabase = await createClient();
  const workspace = await getCurrentWorkspace();
  if (!supabase || !workspace) return null;
  const pick = (await searchParams).aba;
  const tab: TaskTab = TASK_TABS.includes(pick as TaskTab) ? (pick as TaskTab) : "today";
  const now = new Date();
  const all = await openTasks(supabase, workspace.id);
  const by: Record<TaskTab, typeof all> = { today: [], late: [], next: [] };
  for (const x of all) by[taskTab(x.due_at, now)].push(x);
  const rows = by[tab];
  const leads = rows.length > 0 ? await listLeads(supabase, workspace.id, { ids: [...new Set(rows.map((r) => r.lead_id))] }) : [];
  const lead = new Map(leads.map((i) => [i.lead.id, i]));

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <SectionIntro title={T.title} subtitle={T.subtitle} />
      <nav aria-label={T.tabs.label} className={`k-in ${segWrapCls} [animation-delay:.15s]`}>
        {TASK_TABS.map((x) => (
          <Link key={x} href={`/leads/tarefas?aba=${x}`} aria-current={x === tab ? "page" : undefined} className={segItemCls(x === tab)}>
            {T.tabs[x]}
            {x === "late" && by.late.length > 0 ? (
              <span className="inline-flex min-w-7 items-center justify-center rounded-full bg-[#fde8e7] px-2 py-px font-mono text-sm text-danger">{by[x].length}</span>
            ) : (
              <CountPill tone={x === tab ? "honey" : "cold"}>{by[x].length}</CountPill>
            )}
          </Link>
        ))}
      </nav>
      <div key={tab} className="k-fade flex min-w-0 flex-col gap-3">
        {rows.length === 0 ? (
          <EmptyState title={T.empty[tab]} />
        ) : (
          <HexPanel as="section" aria-label={T.tabs[tab]} c={18} cSm={10} className="py-3">
            <Paged as="ul" resetKey={tab} className="m-0 flex list-none flex-col p-0">
              {rows.map((r) => {
                const l = lead.get(r.lead_id);
                return (
                  <li key={r.id} className="k-row flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[#eef0f3] px-3 py-4 last:border-b-0">
                    <Badge tone="honey">{T.kinds[r.kind]}</Badge>
                    <span className="flex min-w-0 flex-[1_1_240px] flex-col gap-0.5">
                      {l ? (
                        <Link href={`/leads/${r.lead_id}`} className="k-link truncate text-[17px] font-semibold underline-offset-4 hover:underline">{l.display.name}</Link>
                      ) : (
                        <span className="text-[17px] font-semibold">{T.lead}</span>
                      )}
                      <span className="text-[15px] text-[#4a5361]">{r.title || T.defaultTitle[r.kind]}</span>
                    </span>
                    <span className={`font-mono text-sm ${tab === "late" ? "font-semibold text-danger" : "text-[#4a5361]"}`}>{when(r.due_at, t.intl)}</span>
                    <TaskButtons id={r.id} />
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
