import Link from "next/link";
import { requireSender } from "@/lib/workspace";
import { hasAi } from "@/lib/ai/config";
import { hasPlaces } from "@/lib/qualifier/places-config";
import { createClient } from "@/lib/supabase/server";
import { SupabaseAgentStore } from "@/lib/agents/store";
import type { AgentRow } from "@/lib/agents/types";
import type { LastRun } from "@/lib/agents/view";
import { listSizesToday } from "@/lib/calls/list-queries";
import { AgentList } from "@/components/agents/AgentList";
import { buttonClass, CountPill, EmptyState, HexPanel, Notice } from "@/components/ui";
import { QualifierCard } from "@/components/qualifier/QualifierCard";
import type { QualifierStatus } from "@/lib/qualifier/view";
import { NewResearchForm } from "@/components/research/NewResearchForm";
import { RunList, type RunListItem } from "@/components/research/RunList";
import { getT } from "@/lib/i18n/server";

export default async function AgentsPage() {
  const t = await getT();
  const workspace = await requireSender();
  const ai = hasAi();
  const supabase = await createClient();
  let agents: AgentRow[] = [];
  let listSizes: Record<string, number> = {};
  let lastRuns: Record<string, LastRun> = {};
  let runs: RunListItem[] = [];
  let qualifier: QualifierStatus | null = null;
  let qualifierFailed = false;
  if (supabase) {
    const { data: q, error: qErr } = await supabase.rpc("qualifier_status", { p_ws: workspace.id });
    qualifier = (q as QualifierStatus | null) ?? null;
    qualifierFailed = Boolean(qErr) || !qualifier;
    agents = await new SupabaseAgentStore(supabase).listAgents(workspace.id);
    if (agents.some((a) => a.type === "call")) listSizes = await listSizesToday(supabase);
    lastRuns = await loadLastRuns(supabase, agents.filter((a) => a.type === "hunter").map((a) => a.id));
    const { data } = await supabase
      .from("research_runs")
      .select("id, title, status, is_partial, created_at")
      .eq("workspace_id", workspace.id)
      .is("setup_agent_id", null)
      .order("created_at", { ascending: false })
      .limit(50);
    runs = (data ?? []) as RunListItem[];
  }
  return (
    <div className="flex flex-col gap-8">
      {qualifierFailed && <Notice tone="warn">{t.qualifier.statusFailed}</Notice>}
      {qualifier && <QualifierCard status={qualifier} placesOn={hasPlaces()} isOwner={workspace.role === "owner"} />}
      <section aria-labelledby="mine" className="k-in flex flex-col gap-3 [animation-delay:.06s]">
        <h2 id="mine" className="flex items-center gap-2.5 text-2xl">
          {t.agents.mine}
          {agents.length > 0 && <CountPill>{agents.length}</CountPill>}
        </h2>
        {agents.length === 0 ? (
          <EmptyState
            icon={SPARK}
            title={t.agents.empty}
            action={
              <Link href="/agentes/novo" className={buttonClass("primary")}>
                {t.agents.newAgent}
              </Link>
            }
          >
            {t.agents.emptyHint}
          </EmptyState>
        ) : (
          <AgentList agents={agents} listSizes={listSizes} lastRuns={lastRuns} />
        )}
      </section>
      <section aria-labelledby="one-off" className="k-in flex flex-col gap-4 [animation-delay:.12s]">
        <div className="flex flex-col gap-1">
          <h2 id="one-off" className="text-2xl">
            {t.agents.oneOff.title}
          </h2>
          <p className="m-0 text-base text-[#4a5361]">{t.agents.oneOff.hint}</p>
        </div>
        <div className="flex flex-wrap items-start gap-6">
          <HexPanel wrapClassName="min-w-0 flex-[999_1_420px]" className="flex flex-col gap-4 py-6">
            <h3 className="font-body text-xl font-semibold normal-case tracking-normal">{t.research.newForm.title}</h3>
            <p className="m-0 text-base text-[#4a5361]">{t.research.newForm.intro}</p>
            {!ai && <Notice tone="warn">{t.ai.notConfigured}</Notice>}
            <NewResearchForm />
          </HexPanel>
          <aside aria-label={t.research.yourResearch} className="flex min-w-0 flex-[1_1_240px] flex-col gap-3">
            <RunList runs={runs} />
          </aside>
        </div>
      </section>
    </div>
  );
}

/** Latest run per hunter: one query for all ids, never one per agent. */
async function loadLastRuns(supabase: NonNullable<Awaited<ReturnType<typeof createClient>>>, ids: string[]): Promise<Record<string, LastRun>> {
  if (ids.length === 0) return {};
  // shortcut: newest 200 runs overall, so a very chatty agent could hide another's latest; page by agent if lists grow
  const { data } = await supabase.from("research_runs").select("id, agent_id, status, finished_at, progress").in("agent_id", ids).order("created_at", { ascending: false }).limit(200);
  const latest = new Map<string, { status: string; finished_at: string | null; progress: { counts?: { candidates?: number } } | null }>();
  for (const r of data ?? []) if (!latest.has(r.agent_id)) latest.set(r.agent_id, r);
  const out: Record<string, LastRun> = {};
  for (const [agentId, r] of latest) out[agentId] = { status: r.status, finishedAt: r.finished_at, found: r.progress?.counts?.candidates ?? 0 };
  return out;
}

// a spark: "an agent does it for you"
const SPARK = "M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8";
