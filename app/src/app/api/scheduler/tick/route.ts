import { configuredPublicOrigin } from "@/lib/email/config";
import { runTick } from "@/lib/email/scheduler";
import { createSchedulerStore } from "@/lib/email/scheduler-store";

// The clock (E1). An external scheduler (pg_cron + pg_net) posts here every 5 minutes with
// `Authorization: Bearer <64 hex chars>`. No session and no secret on this host: the token is forwarded to the
// database, which checks its hash (scheduler_authorized). Rehearsal campaigns only, send only (see lib/email/scheduler.ts).
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const BEARER = /^Bearer ([0-9a-f]{64})$/;

export async function POST(request: Request) {
  // shape first: nothing is created for a request that cannot hold a token
  const m = BEARER.exec(request.headers.get("authorization") ?? "");
  if (!m) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const store = createSchedulerStore(m[1]);
    if (!store) return Response.json({ outcome: "error" }, { status: 500 });
    // footer links of a rehearsal: the configured public origin, else this request's origin (nothing leaves)
    const origins = { publicOrigin: configuredPublicOrigin(), requestOrigin: new URL(request.url).origin };
    const r = await runTick({ store, origins });
    return Response.json({ outcome: r.outcome, campaigns: r.campaigns, sent: r.sent, failed: r.failed });
  } catch (e) {
    if (e instanceof Error && e.name === "SchedulerAuthError") return Response.json({ error: "unauthorized" }, { status: 401 });
    // never echo internals (addresses, bodies, tokens) (R10)
    return Response.json({ outcome: "error" }, { status: 500 });
  }
}
