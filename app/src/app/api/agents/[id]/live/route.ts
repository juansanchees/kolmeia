import { agentLiveView } from "@/lib/agents/live";
import { researchSession } from "@/lib/research/session";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const notFound = () => Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

/** Live view of one Hunter for the agent page to poll. Reads with the user session (RLS decides visibility). */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return notFound();
  const session = await researchSession();
  if (!session) return notFound();
  const { supabase } = session;

  const { data: agent } = await supabase
    .from("agents")
    .select("status, next_run_at, paused_reason, type")
    .eq("id", id)
    .maybeSingle();
  if (!agent || agent.type !== "hunter") return notFound();

  const { data: run } = await supabase
    .from("research_runs")
    .select("id, status, started_at, finished_at, spent_cost_usd, max_cost_usd, max_candidates, progress, error")
    .eq("agent_id", id)
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

  return Response.json(agentLiveView({ agent, run, found, lastName, now: new Date() }), { headers: NO_STORE });
}
