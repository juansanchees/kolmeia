import Link from "next/link";
import { TaskButtons } from "@/components/tasks/TaskButtons";
import { listLeads } from "@/lib/leads/queries";
import { createClient } from "@/lib/supabase/server";
import { openTasks } from "@/lib/tasks/queries";
import { TASK_TABS, taskTab, type TaskTab } from "@/lib/tasks/view";
import { getCurrentWorkspace } from "@/lib/workspace";
import { t } from "@/messages/pt";

const T = t.tasks;
const when = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { timeZone: "America/New_York", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

// Open tasks by New York day: Hoje / Atrasadas / Próximas. Read as the user (RLS: the closer sees those of her leads).
export default async function TasksPage({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
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
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-2xl">{T.title}</h2>
        <p className="text-sm text-muted">{T.subtitle}</p>
      </header>
      <nav aria-label={T.tabs.label} className="flex flex-wrap border-b border-line">
        {TASK_TABS.map((x) => (
          <Link
            key={x}
            href={`/leads/tarefas?aba=${x}`}
            aria-current={x === tab ? "page" : undefined}
            className={`-mb-px inline-flex min-h-11 items-center border-b-[3px] px-4 text-[15px] no-underline ${x === tab ? "border-blue font-semibold text-ink" : "border-transparent text-muted hover:text-ink"}`}
          >
            {T.tabs[x]}
            <span className={`ml-1.5 px-1.5 font-mono text-[13px] ${x === "late" && by.late.length > 0 ? "bg-warn-soft text-danger" : "bg-ground"}`}>{by[x].length}</span>
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{T.empty[tab]}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col border border-line bg-surface p-0">
          {rows.map((r) => {
            const l = lead.get(r.lead_id);
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 last:border-b-0">
                <span className="min-w-[76px] bg-blue-wash px-2.5 py-1 text-center font-mono text-xs uppercase tracking-wide">{T.kinds[r.kind]}</span>
                <span className="flex min-w-0 flex-[1_1_240px] flex-col gap-0.5">
                  {l ? (
                    <Link href={`/leads/${r.lead_id}`} className="font-semibold text-ink underline-offset-4 hover:underline">{l.display.name}</Link>
                  ) : (
                    <span className="font-semibold">{T.lead}</span>
                  )}
                  <span className="text-sm text-muted">{r.title || T.defaultTitle[r.kind]}</span>
                </span>
                <span className={`font-mono text-[13px] ${tab === "late" ? "font-medium text-danger" : "text-muted"}`}>{when(r.due_at)}</span>
                <TaskButtons id={r.id} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
