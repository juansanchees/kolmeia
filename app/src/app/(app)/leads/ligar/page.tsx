import Link from "next/link";
import { Pill } from "@/components/research/controls";
import { effectiveTemperature } from "@/lib/leads/classify";
import { todayList, type TodayRow } from "@/lib/calls/list-queries";
import { createClient } from "@/lib/supabase/server";
import { isSender } from "@/lib/roles";
import { getCurrentWorkspace } from "@/lib/workspace";
import { getT } from "@/lib/i18n/server";
import { Paged } from "@/components/Pager";
import { SectionIntro } from "@/components/leads/SectionIntro";
import { Badge, buttonClass, Chevron, CountPill, EmptyState, HexPanel, Icon, segItemCls, segWrapCls } from "@/components/ui";

const PHONE =
  "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z";

async function Row({ r, done }: { r: TodayRow; done?: boolean }) {
  const t = await getT();
  const C = t.calls;
  const best = r.lead.best;
  const temp = effectiveTemperature(r.lead.lead.level, best?.temperature ?? null);
  return (
    <li className="k-row flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[#eef0f3] px-3 py-4 last:border-b-0">
      <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
        <Link href={`/leads/${r.lead.lead.id}`} className="k-link truncate text-[17px] font-semibold underline-offset-4 hover:underline">
          {r.lead.display.name}
        </Link>
        <span className="font-mono text-[15px] text-[#4a5361]">{r.lead.display.phone ?? t.callAgent.noPhone}</span>
      </div>
      {temp && <Pill tone={temp}>{t.research.labels.temperature[temp]}</Pill>}
      <span className="font-mono text-sm text-[#4a5361]">N{r.lead.lead.level}</span>
      {done ? (
        r.lastCall ? <Badge tone="honey">{C.outcomes[r.lastCall.outcome]}</Badge> : null
      ) : (
        <Link href={`/leads/ligar/${r.lead.lead.id}`} className={buttonClass("primary", "sm")}>
          <Icon d={PHONE} size={18} />
          {C.call}
          <Chevron size={16} className="k-arrow" />
        </Link>
      )}
    </li>
  );
}

// Today's call list. Built for the signed-in caller on load (errors ignored), then read as the user: RLS decides the rows.
export default async function CallPage({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const t = await getT();
  const C = t.calls;
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
      <SectionIntro id="today-title" title={<span className="inline-flex items-center gap-3">{C.today} <CountPill tone="honey" className="text-base">{todo.length}</CountPill></span>} subtitle={C.queueSubtitle} />
      {sender && agents.length > 0 && (
        <nav aria-label={t.callAgent.agentLists} className={`k-in ${segWrapCls} [animation-delay:.15s]`}>
          <Link href="/leads/ligar" aria-current={agentId ? undefined : "page"} className={segItemCls(!agentId)}>
            {t.callAgent.allAgents}
          </Link>
          {agents.map((a) => (
            <Link key={a.id} href={`/leads/ligar?agente=${a.id}`} aria-current={agentId === a.id ? "page" : undefined} className={segItemCls(agentId === a.id)}>
              {a.name}
            </Link>
          ))}
        </nav>
      )}
      {rows.length === 0 && (
        <EmptyState icon={PHONE} title={C.empty}>
          {C.emptyHint}
        </EmptyState>
      )}
      {todo.length > 0 && (
        <HexPanel as="section" aria-labelledby="today-title" c={18} cSm={10} className="py-5" wrapClassName="k-in [animation-delay:.2s]">
          <Paged as="ul" className="m-0 flex list-none flex-col p-0">{todo.map((r) => <Row key={r.item.id} r={r} />)}</Paged>
        </HexPanel>
      )}
      {done.length > 0 && (
        <section aria-labelledby="done-title" className="k-in flex flex-col gap-3 [animation-delay:.28s]">
          <h3 id="done-title" className="flex items-center gap-2.5 text-lg font-semibold">
            {C.done} <CountPill tone="cold">{done.length}</CountPill>
          </h3>
          <Paged as="ul" className="m-0 flex list-none flex-col rounded-2xl border border-[#e3e6ec] bg-surface px-2">{done.map((r) => <Row key={r.item.id} r={r} done />)}</Paged>
        </section>
      )}
      <p className="m-0 text-base text-[#4a5361]">{C.b2bOnly}</p>
    </div>
  );
}
