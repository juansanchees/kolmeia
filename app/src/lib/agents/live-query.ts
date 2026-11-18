import type { SupabaseClient } from "@supabase/supabase-js";
import { agentLiveView, type AgentLive } from "@/lib/agents/live";

/** Reads one Hunter's latest run and builds its live view (shared by the live route and the agent page). Null when the agent is not visible or not a hunter. */
export async function loadAgentLive(supabase: SupabaseClient, agentId: string, now: Date): Promise<AgentLive | null> {
  const { data: agent } = await supabase
    .from("agents")
    .select("status, next_run_at, paused_reason, type")
    .eq("id", agentId)
    .maybeSingle();
  if (!agent || agent.type !== "hunter") return null;

  const { data: run } = await supabase
    .from("research_runs")
    .select("id, status, started_at, finished_at, spent_cost_usd, max_cost_usd, max_candidates, progress, error")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let found = 0;
  let lastName: string | null = null;
  if (run) {
    const { count } = await supabase.from("research_candidates").select("id", { count: "exact", head: true }).eq("run_id", run.id);
    found = count ?? 0;
    const { data: last } = await supabase
      .from("research_candidates")
      .select("name")
      .eq("run_id", run.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    lastName = last?.name ?? null;
  }
  return agentLiveView({ agent, run, found, lastName, now });
}
