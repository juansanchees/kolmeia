import { randomUUID } from "node:crypto";
import { STOP_CODES } from "@/lib/ai/errors";
import { defaultTransport } from "@/lib/ai/gateway";
import { advance, needsAdvance } from "@/lib/research/engine";
import { researchSession } from "@/lib/research/session";

// One bounded step of a research run, driven by the open page (no background worker in this phase).
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  // Same-origin only: a cross-site page must not be able to spend this workspace's AI budget.
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "not_found" }, { status: 404 });

  const session = await researchSession();
  if (!session) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const out = await advance({ store: session.store, transport: defaultTransport() }, id, randomUUID());
  switch (out.kind) {
    case "not_found":
      return Response.json({ error: "not_found" }, { status: 404 });
    case "busy":
      return Response.json({ outcome: "busy", more: true });
    case "ai_error":
      return Response.json({
        outcome: "ai_error",
        code: out.code,
        status: out.run.status,
        more: !STOP_CODES.has(out.code) && needsAdvance(out.run),
      });
    default:
      return Response.json({ outcome: out.kind, status: out.run.status, more: needsAdvance(out.run) });
  }
}
