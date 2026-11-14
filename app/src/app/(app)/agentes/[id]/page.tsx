import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { hasAi } from "@/lib/ai/config";
import { defaultAgentName, hunterSetupSchema } from "@/lib/agents/hunter";
import { SupabaseAgentStore } from "@/lib/agents/store";
import { hunterStep } from "@/lib/agents/steps";
import { needsAdvance } from "@/lib/research/engine";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { AgentDetail } from "@/components/agents/AgentDetail";
import { HunterReviewCard } from "@/components/agents/HunterReviewCard";
import { QuestionsForm } from "@/components/research/QuestionsForm";
import { RunDriver } from "@/components/research/RunDriver";
import { RestartButton } from "@/components/agents/RestartButton";
import { t } from "@/messages/pt";

// The step route runs up to 300 s; keep the same ceiling as the research page.
export const maxDuration = 300;

const H = t.agents.hunter;

function UserBubble({ children }: { children: React.ReactNode }) {
  return <div className="max-w-[80%] self-end bg-blue px-3.5 py-3 text-[15px] leading-normal text-white">{children}</div>;
}

function AiBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex max-w-full flex-col gap-3.5 self-start border border-[#c9d8f7] bg-blue-wash p-4 sm:max-w-[92%]">
      <span className="font-mono text-[11px] uppercase text-blue-ink">{t.ai.suggestion}</span>
      {children}
    </div>
  );
}

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const workspace = await requireSender();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const supabase = await createClient();
  if (!supabase) notFound();
  const store = new SupabaseAgentStore(supabase);
  const agent = await store.getAgent(id);
  if (!agent || agent.workspace_id !== workspace.id) notFound();
  if (agent.archived_at) redirect("/agentes");
  const run = await store.getSetupRun(id);

  const ai = hasAi();
  const step = hunterStep(agent, run, ai);
  const setup = hunterSetupSchema.safeParse(agent.config);

  if (step === "created") return <AgentDetail agent={agent} setupRun={run} />;

  const profile = setup.success ? (setup.data.profileSource === "saved" ? H.profileSaved : H.profileDescribe) : "";
  const audience = setup.success ? (setup.data.audience === "other" ? setup.data.audienceText : H.audiences[setup.data.audience]) : "";

  return (
    <section aria-label={agent.name} className="flex flex-col border border-line bg-surface">
      <div className="border-b border-ink px-5 py-3.5">
        <h2 className="text-2xl">{agent.name}</h2>
      </div>
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        {setup.success && (
          <UserBubble>
            <span className="block">{audience}</span>
            <span className="mt-1 block text-[13px] opacity-90">{setup.data.region}</span>
            <span className="mt-1 block text-[13px] opacity-90">{profile}</span>
          </UserBubble>
        )}

        {ai && run && needsAdvance(run) && <RunDriver runId={run.id} status={run.status} />}

        {(step === "thinking" || step === "planning") && (
          <p role="status" className="font-mono text-xs text-muted">
            {step === "thinking" ? t.research.conversation.thinking : t.research.conversation.planning}
          </p>
        )}

        {step === "no_ai" && (
          <p role="status" className="bg-warn-soft px-3 py-2.5 text-sm text-warn">
            {t.ai.notConfigured} {H.noAi}
          </p>
        )}

        {step === "questions" && run && (
          <AiBubble>
            <p className="text-[15px] leading-normal">
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
            <p role="status" className="bg-warn-soft px-3 py-2.5 text-sm text-warn">
              {H.setupFailed}
            </p>
            <RestartButton agentId={agent.id} />
          </div>
        )}
      </div>
    </section>
  );
}
