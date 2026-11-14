import { randomUUID } from "node:crypto";
import { sendStep } from "@/lib/email/engine";
import { emailOrigins, emailSession } from "@/lib/email/session";

// Sends at most ONE due, approved message per call (the database claim enforces R1-R4), driven by the open page.
// Returns when the next one is allowed (gap / daily limit). One SMTP send fits well inside this limit.
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
    // unsubscribe links: APP_PUBLIC_ORIGIN only for real mail (never the Host header); rehearsal may fall back
    const r = await sendStep(s.deps, id, randomUUID(), await emailOrigins());
    // a mailbox that stopped working (password refused / unreadable) ends the loop instead of failing every message
    const more = !r.stop && (r.outcome === "sent" || r.outcome === "dry_run" || r.outcome === "failed" || r.outcome === "gap");
    return Response.json({ ...r, more });
  } catch {
    // never echo internals (addresses, bodies, secrets) to the browser (R10)
    return Response.json({ outcome: "error", more: false }, { status: 500 });
  }
}
