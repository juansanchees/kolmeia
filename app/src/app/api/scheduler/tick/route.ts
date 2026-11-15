import { clockImap } from "@/lib/email/clock-replies";
import { configuredPublicOrigin, hasMailboxKey, realClockEnabled } from "@/lib/email/config";
import { NoSendSmtp, runTick, TICK_BUDGET_MS, TICK_REAL_BUDGET_MS } from "@/lib/email/scheduler";
import { createSchedulerStore } from "@/lib/email/scheduler-store";
import { CLOCK_SMTP_TIMEOUTS, GmailSmtp } from "@/lib/email/transport";

// The clock (E1). An external scheduler (pg_cron + pg_net) posts here every 5 minutes with
// `Authorization: Bearer <64 hex chars>`. No session and no secret on this host: the token is forwarded to the
// database, which checks its hash (scheduler_authorized). Sends, then (real mode only, 0026 E5) reads replies with rules
// only (see lib/email/scheduler.ts and clock-replies.ts).
// Rehearsal only unless the server switch is on (realClockEnabled, off by default) and the mailbox key is configured;
// even then the database sends real mail only for a workspace whose C12 gate is open, whose owner turned the clock's
// real sending on (set_clock_real) and whose emergency stop is off (0025, D4).
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const BEARER = /^Bearer ([0-9a-f]{64})$/;

export async function POST(request: Request) {
  // shape first: nothing is created for a request that cannot hold a token
  const m = BEARER.exec(request.headers.get("authorization") ?? "");
  if (!m) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    // the switch is read once: it decides the store's mode, the transport and the budget. Without the mailbox key a
    // real send could only fail, so it counts as off (nothing real is claimed).
    const real = realClockEnabled() && hasMailboxKey();
    const store = createSchedulerStore(m[1], real);
    if (!store) return Response.json({ outcome: "error" }, { status: 500 });
    const smtp = real ? new GmailSmtp(CLOCK_SMTP_TIMEOUTS) : new NoSendSmtp();
    // E5: replies are read behind the same switch; without it there is no IMAP reader at all
    const imap = real ? clockImap() : null;
    // footer links: real mail only with the configured public https origin (the engine refuses otherwise); a rehearsal
    // falls back to this request's origin (nothing leaves)
    const origins = { publicOrigin: configuredPublicOrigin(), requestOrigin: new URL(request.url).origin };
    const r = await runTick({ store, origins, smtp, imap, budgetMs: real ? TICK_REAL_BUDGET_MS : TICK_BUDGET_MS });
    return Response.json({ outcome: r.outcome, campaigns: r.campaigns, sent: r.sent, failed: r.failed });
  } catch (e) {
    if (e instanceof Error && e.name === "SchedulerAuthError") return Response.json({ error: "unauthorized" }, { status: 401 });
    // never echo internals (addresses, bodies, tokens) (R10)
    return Response.json({ outcome: "error" }, { status: 500 });
  }
}
