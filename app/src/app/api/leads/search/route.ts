import { z } from "zod";
import { defaultTransport } from "@/lib/ai/gateway";
import { isAiError } from "@/lib/ai/errors";
import { searchLeadsWithAi } from "@/lib/ai/lead-search-tasks";
import { sessionLedger } from "@/lib/ai/session-ledger";
import { isSender } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const body = z.object({ text: z.string().trim().min(1).max(200), cities: z.array(z.string().trim().min(1).max(120)).max(300) });

// Layer 2 of "Descreva quem você quer": one small AI call in the clicking user's session (caps, allowlist and ledger
// in reserve_ai_call). A route (not a server action) so the page can abort it on the next keystroke.
export async function POST(request: Request) {
  // Same-origin only: a cross-site page must not spend this workspace's AI budget.
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return Response.json({ error: "forbidden" }, { status: 403 });
  const workspace = await getCurrentWorkspace();
  if (!workspace) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!isSender(workspace.role)) return Response.json({ error: "forbidden" }, { status: 403 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_input" }, { status: 400 });
  const db = await createClient();
  if (!db) return Response.json({ error: "unauthenticated" }, { status: 401 });
  // shortcut: an abort after this point does not stop the model call (the transport takes no signal); it is still billed and recorded.
  if (request.signal.aborted) return Response.json({ error: "aborted" }, { status: 499 });
  try {
    const r = await searchLeadsWithAi({ workspaceId: workspace.id, runId: null, ledger: sessionLedger(db), transport: defaultTransport(), deadlineMs: 20_000 }, parsed.data);
    return Response.json({ filters: r.data });
  } catch (e) {
    return Response.json({ error: isAiError(e) ? e.code : "failed" }, { status: 200 });
  }
}
