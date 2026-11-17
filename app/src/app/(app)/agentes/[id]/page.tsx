import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { hasAi } from "@/lib/ai/config";
import { defaultAgentName, hunterSetupSchema } from "@/lib/agents/hunter";
import { SupabaseAgentStore } from "@/lib/agents/store";
import { hunterStep } from "@/lib/agents/steps";
import { needsAdvance } from "@/lib/research/engine";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { CallAgentDetail, type CallDetailRow } from "@/components/agents/CallAgentDetail";
import { effectiveTemperature } from "@/lib/leads/classify";
import { agentCallStats, todayList } from "@/lib/calls/list-queries";
import type { Person } from "@/lib/team/types";
import { AgentDetail } from "@/components/agents/AgentDetail";
import { HunterReviewCard } from "@/components/agents/HunterReviewCard";
import { QuestionsForm } from "@/components/research/QuestionsForm";
import { RunDriver } from "@/components/research/RunDriver";
import { AgentSources } from "@/components/sources/AgentSources";
import { DEFAULT_AGENT_SOURCES } from "@/lib/sources/view";
import { agentSourceSettings, connectedSources } from "@/lib/sources/queries";
import { EmailAgentDetail } from "@/components/agents/EmailAgentDetail";
import { loadEmailAgent } from "@/lib/email-agent/queries";
import { reserveFor } from "@/lib/ai/gateway";
import { sequenceDef } from "@/lib/ai/email-tasks";
import { RestartButton } from "@/components/agents/RestartButton";
import { getT } from "@/lib/i18n/server";
import { AiBubble, UserBubble } from "@/components/research/controls";
import { HexPanel, Notice } from "@/components/ui";
import { AgentHead } from "@/components/agents/AgentHead";

// The step route runs up to 300 s; keep the same ceiling as the research page.
export const maxDuration = 300;

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const t = await getT();
  const H = t.agents.hunter;
  const workspace = await requireSender();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const supabase = await createClient();
  if (!supabase) notFound();
  const store = new SupabaseAgentStore(supabase);
  const agent = await store.getAgent(id);
  if (!agent || agent.workspace_id !== workspace.id) notFound();
  if (agent.archived_at) redirect("/agentes");
  if (agent.type === "call") {
    const [{ data: team }, stats, list] = await Promise.all([
      supabase.rpc("list_workspace_people", { p_ws: workspace.id }),
      agentCallStats(supabase, id),
      todayList(supabase, { agentId: id }),
    ]);
    const callerId = typeof agent.config.caller_id === "string" ? agent.config.caller_id : "";
    const caller = ((team ?? []) as Person[]).find((p) => p.user_id === callerId);
    const rows: CallDetailRow[] = list.map((r) => ({
      leadId: r.lead.lead.id,
      name: r.lead.display.name,
      temperature: effectiveTemperature(r.lead.lead.level, r.lead.best?.temperature ?? null),
      level: r.lead.lead.level,
      phone: r.lead.display.phone,
      outcome: r.calledToday ? (r.lastCall?.outcome ?? null) : null,
    }));
    return <CallAgentDetail agent={agent} callerLabel={caller?.label ?? "?"} stats={stats} rows={rows} />;
  }
  if (agent.type === "email") {
    const view = await loadEmailAgent(supabase, id);
    if (!view) notFound();
    return (
      <EmailAgentDetail
        agent={view.agent}
        campaignId={view.campaign.id}
        sequence={view.sequence}
        preview={view.preview}
        metrics={view.metrics}
        sender={view.sender}
        c12Ready={view.c12Ready}
        sendMode={view.campaign.send_mode}
        isOwner={workspace.role === "owner"}
        estimateUsd={reserveFor(sequenceDef)}
      />
    );
  }
  const run = await store.getSetupRun(id);

  const ai = hasAi();
  const step = hunterStep(agent, run, ai);
  const setup = hunterSetupSchema.safeParse(agent.config);

  if (step === "created") {
    const runs = await store.listRuns(id);
    const conn = await connectedSources(supabase, workspace.id);
    const settings = (await agentSourceSettings(supabase, id)) ?? DEFAULT_AGENT_SOURCES;
    return (
      <div className="flex min-w-0 flex-col gap-5">
        <AgentDetail agent={agent} setupRun={run} runs={runs} now={new Date()} />
        <AgentSources agentId={agent.id} connected={{ maps: conn.maps, apollo: conn.apollo }} settings={settings} />
      </div>
    );
  }

  const profile = setup.success ? (setup.data.profileSource === "saved" ? H.profileSaved : H.profileDescribe) : "";
  const audience = setup.success ? (setup.data.audience === "other" ? setup.data.audienceText : H.audiences[setup.data.audience]) : "";

  return (
    <HexPanel as="section" aria-labelledby="agent-title" raised wrapClassName="k-in" className="flex flex-col gap-5 py-7">
      <AgentHead id="agent-title" name={agent.name} type={agent.type} typeLabel={t.agents.types[agent.type]} status={agent.status} statusLabel={t.agents.statuses[agent.status]} />
      <div className="flex flex-col gap-4">
        {setup.success && (
          <UserBubble>
            <span className="block">{audience}</span>
            <span className="mt-1 block text-[15px] text-honey-glow">{setup.data.region}</span>
            <span className="mt-1 block text-[15px] text-honey-glow">{profile}</span>
          </UserBubble>
        )}

        {ai && run && needsAdvance(run) && <RunDriver runId={run.id} status={run.status} />}

        {(step === "thinking" || step === "planning") && (
          <p role="status" className="m-0 font-mono text-sm text-[#4a5361]">
            {step === "thinking" ? t.research.conversation.thinking : t.research.conversation.planning}
          </p>
        )}

        {step === "no_ai" && (
          <Notice tone="warn">
            {t.ai.notConfigured} {H.noAi}
          </Notice>
        )}

        {step === "questions" && run && (
          <AiBubble label={t.ai.suggestion}>
            <p className="m-0 text-base leading-normal">
              <span className="font-semibold">{t.research.conversation.understood}</span> {run.progress.understood ?? ""}{" "}
              {t.research.conversation.askIntro}
            </p>
            <QuestionsForm
              runId={run.id}
              questions={run.questions ?? []}
              answers={run.answers}
              region={run.region_text}
              places={run.progress.places ?? []}
              disabled={false}
            />
          </AiBubble>
        )}

        {step === "choose" && run && setup.success && (
          <HunterReviewCard agentId={agent.id} run={run} defaultName={defaultAgentName(setup.data)} />
        )}

        {step === "setup_failed" && (
          <div className="flex flex-col items-start gap-3">
            <Notice tone="warn">{H.setupFailed}</Notice>
            <RestartButton agentId={agent.id} />
          </div>
        )}
      </div>
    </HexPanel>
  );
}
