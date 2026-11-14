import Link from "next/link";
import { requireSender } from "@/lib/workspace";
import { hasAi } from "@/lib/ai/config";
import { createClient } from "@/lib/supabase/server";
import { SupabaseAgentStore } from "@/lib/agents/store";
import type { AgentRow } from "@/lib/agents/types";
import { AgentList } from "@/components/agents/AgentList";
import { NewResearchForm } from "@/components/research/NewResearchForm";
import { RunList, type RunListItem } from "@/components/research/RunList";
import { t } from "@/messages/pt";

export default async function AgentsPage() {
  const workspace = await requireSender();
  const ai = hasAi();
  const supabase = await createClient();
  let agents: AgentRow[] = [];
  let runs: RunListItem[] = [];
  if (supabase) {
    agents = await new SupabaseAgentStore(supabase).listAgents(workspace.id);
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
      <section aria-labelledby="mine" className="flex flex-col gap-3">
        <h2 id="mine" className="text-2xl">
          {t.agents.mine}
        </h2>
        {agents.length === 0 ? (
          <p className="text-sm">
            {t.agents.empty}{" "}
            <Link href="/agentes/novo" className="text-blue underline underline-offset-4">
              {t.agents.newAgent}
            </Link>
          </p>
        ) : (
          <AgentList agents={agents} />
        )}
      </section>
      <section aria-labelledby="one-off" className="flex flex-col gap-4">
        <h2 id="one-off" className="text-2xl">
          {t.agents.oneOff.title}
        </h2>
        <div className="flex flex-wrap items-start gap-6">
          <div className="flex min-w-0 flex-[999_1_420px] flex-col gap-4 border border-line bg-surface p-5">
            <h3 className="text-xl">{t.research.newForm.title}</h3>
            <p className="text-sm">{t.research.newForm.intro}</p>
            {!ai && (
              <p role="status" className="bg-warn-soft px-3 py-2.5 text-sm text-warn">
                {t.ai.notConfigured}
              </p>
            )}
            <NewResearchForm />
          </div>
          <aside aria-label={t.research.yourResearch} className="flex min-w-0 flex-[1_1_240px] flex-col gap-3">
            <RunList runs={runs} />
          </aside>
        </div>
      </section>
    </div>
  );
}
