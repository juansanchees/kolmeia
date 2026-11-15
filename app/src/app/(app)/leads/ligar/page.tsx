import Link from "next/link";
import { Pill } from "@/components/research/controls";
import { todayList, type TodayRow } from "@/lib/calls/list-queries";
import { createClient } from "@/lib/supabase/server";
import { isSender } from "@/lib/roles";
import { getCurrentWorkspace } from "@/lib/workspace";
import { t } from "@/messages/pt";

const C = t.calls;

function Row({ r, done }: { r: TodayRow; done?: boolean }) {
  const best = r.lead.best;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
        <Link href={`/leads/${r.lead.lead.id}`} className="font-semibold text-ink underline-offset-4 hover:underline">
          {r.lead.display.name}
        </Link>
        <span className="font-mono text-xs text-muted">{r.lead.display.phone ?? t.callAgent.noPhone}</span>
      </div>
      {best?.temperature && <Pill tone={best.temperature}>{t.research.labels.temperature[best.temperature]}</Pill>}
      <span className="font-mono text-xs text-muted">N{r.lead.lead.level}</span>
      {done ? (
        <span className="font-mono text-xs">{r.lastCall ? C.outcomes[r.lastCall.outcome] : ""}</span>
      ) : (
        <Link
          href={`/leads/ligar/${r.lead.lead.id}`}
          className="inline-flex min-h-11 items-center border border-edge bg-surface px-4 text-[15px] font-medium text-ink no-underline hover:border-ink"
        >
          {C.call} ▸
        </Link>
      )}
    </li>
  );
}

// Today's call list. Built for the signed-in caller on load (errors ignored), then read as the user: RLS decides the rows.
export default async function CallPage({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const supabase = await createClient();
  const workspace = await getCurrentWorkspace();
  if (!supabase || !workspace) return null;
  await supabase.rpc("build_my_call_lists");

  const sender = isSender(workspace.role);
  const pick = (await searchParams).agente;
  let agents: { id: string; name: string }[] = [];
  if (sender) {
    const { data } = await supabase.from("agents").select("id, name").eq("workspace_id", workspace.id).eq("type", "call").is("archived_at", null).order("created_at");
    agents = (data ?? []) as { id: string; name: string }[];
  }
  const agentId = typeof pick === "string" && agents.some((a) => a.id === pick) ? pick : undefined;
  const rows = await todayList(supabase, { agentId });
  const todo = rows.filter((r) => !r.calledToday);
  const done = rows.filter((r) => r.calledToday);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {sender && agents.length > 0 && (
        <nav aria-label={t.callAgent.agentLists} className="flex flex-wrap gap-2 text-sm">
          <Link href="/leads/ligar" aria-current={agentId ? undefined : "page"} className="border border-line px-3 py-1.5 no-underline aria-[current=page]:border-ink">
            {t.callAgent.allAgents}
          </Link>
          {agents.map((a) => (
            <Link key={a.id} href={`/leads/ligar?agente=${a.id}`} aria-current={agentId === a.id ? "page" : undefined} className="border border-line px-3 py-1.5 no-underline aria-[current=page]:border-ink">
              {a.name}
            </Link>
          ))}
        </nav>
      )}
      <h2 className="text-2xl">{C.today}</h2>
      {rows.length === 0 && <p className="text-sm text-muted">{C.empty}</p>}
      {todo.length > 0 && <ul className="m-0 flex list-none flex-col border border-line bg-surface p-0">{todo.map((r) => <Row key={r.item.id} r={r} />)}</ul>}
      {done.length > 0 && (
        <section aria-labelledby="done-title" className="flex flex-col gap-2">
          <h3 id="done-title" className="text-base font-semibold">
            {C.done}
          </h3>
          <ul className="m-0 flex list-none flex-col border border-line bg-surface p-0">{done.map((r) => <Row key={r.item.id} r={r} done />)}</ul>
        </section>
      )}
      <p className="text-sm text-muted">{C.b2bOnly}</p>
    </div>
  );
}
