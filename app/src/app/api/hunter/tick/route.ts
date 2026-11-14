import { hasAi } from "@/lib/ai/config";
import { defaultTransport } from "@/lib/ai/gateway";
import { runHunterTick } from "@/lib/hunter/tick";
import { createHunterTickStore } from "@/lib/hunter/tick-store";

// The Caçador clock (C7). pg_cron + pg_net post here every 2 minutes with `Authorization: Bearer <64 hex chars>`
// (the same token as /api/scheduler/tick). No session: the token is forwarded to the database, which checks its hash.
// maxDuration 300 needs a plan that allows it (Hobby with Fluid compute: ? verify on the project); fallback in
// supabase/manual/hunter_cron.sql.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const BEARER = /^Bearer ([0-9a-f]{64})$/;

export async function POST(request: Request) {
  // shape first: nothing is created for a request that cannot hold a token
  const m = BEARER.exec(request.headers.get("authorization") ?? "");
  if (!m) return Response.json({ error: "unauthorized" }, { status: 401 });
  // no AI key: nothing to do, and no database call at all
  if (!hasAi()) return Response.json({ outcome: "no_ai" });
  try {
    const store = createHunterTickStore(m[1]);
    if (!store) return Response.json({ outcome: "error" }, { status: 500 });
    const r = await runHunterTick({ store, transport: defaultTransport() });
    return Response.json({ outcome: r.outcome, runs: r.runs, steps: r.steps, paused: r.paused, failed: r.failed });
  } catch (e) {
    if (e instanceof Error && e.name === "HunterAuthError") return Response.json({ error: "unauthorized" }, { status: 401 });
    // never echo internals (R10)
    return Response.json({ outcome: "error" }, { status: 500 });
  }
}
