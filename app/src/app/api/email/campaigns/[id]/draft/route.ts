import { randomUUID } from "node:crypto";
import { draftStep } from "@/lib/email/engine";
import { emailSession } from "@/lib/email/session";

// One bounded drafting step (a couple of prospects), driven by the open page. No background worker.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  // Same-origin only: a cross-site page must not spend this workspace's AI budget.
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return Response.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "not_found" }, { status: 404 });
  const s = await emailSession();
  if (!s) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!s.canSend) return Response.json({ error: "forbidden" }, { status: 403 });

  const out = await draftStep(s.deps, id, randomUUID(), s.workspace.name);
  switch (out.kind) {
    case "not_found":
      return Response.json({ error: "not_found" }, { status: 404 });
    case "busy":
      return Response.json({ outcome: "busy", more: true });
    case "ai_error":
      return Response.json({ outcome: "ai_error", code: out.code, remaining: out.remaining, more: !out.stop && out.remaining > 0 });
    default:
      return Response.json({ outcome: "drafted", drafted: out.drafted, remaining: out.remaining, more: out.remaining > 0 });
  }
}
