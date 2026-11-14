import { randomUUID } from "node:crypto";
import { sendReplyAnswer } from "@/lib/email/engine";
import { emailOrigins, emailSession } from "@/lib/email/session";

// "Enviar resposta": sends ONE approved answer to a reply (the message id), whatever the campaign state (paused,
// done, archived), still under approval, limits, gap, suppression and the campaign's mode (claim_next_email).
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return Response.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "not_found" }, { status: 404 });
  const s = await emailSession();
  if (!s) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!s.canSend) return Response.json({ error: "forbidden" }, { status: 403 });
  try {
    const r = await sendReplyAnswer(s.deps, id, randomUUID(), await emailOrigins());
    return Response.json({ ...r, more: r.outcome === "gap" });
  } catch {
    return Response.json({ outcome: "error", more: false }, { status: 500 });
  }
}
