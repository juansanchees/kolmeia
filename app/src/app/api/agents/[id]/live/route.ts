import { loadAgentLive } from "@/lib/agents/live-query";
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
  const live = await loadAgentLive(session.supabase, id, new Date());
  return live ? Response.json(live, { headers: NO_STORE }) : notFound();
}
