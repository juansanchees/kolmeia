import "server-only";
import { sendStep, type Origins } from "./engine";
import type { TickStore } from "./scheduler-store";
import type { SmtpTransport } from "./transport";

// The clock (E1): one bounded tick, called by an external scheduler with no user session. SEND ONLY and REHEARSAL ONLY:
// the database refuses any campaign that is not in dry_run mode, and the transport below always throws, so this path
// cannot put a real message on the wire even if a rule failed. No AI calls, no replies, no mailbox access.
// Logs nothing; the only trace is the heartbeat row (run id, times, counts, one short error code) [R10].

export const TICK_MAX_CAMPAIGNS = 20;
export const TICK_MAX_SENDS = 10;
export const TICK_BUDGET_MS = 40_000;

const CODE = /^[a-z0-9_:]{1,60}$/;

/** The only SMTP transport of the scheduler path: it cannot send. */
export class NoSendSmtp implements SmtpTransport {
  async verify(): Promise<void> {
    throw new Error("scheduler_cannot_send");
  }
  async send(): Promise<{ response: string }> {
    throw new Error("scheduler_cannot_send");
  }
}

export type TickResult = { runId: string; outcome: "ok" | "error" | "busy"; campaigns: number; sent: number; failed: number };

/** A short, safe code for the heartbeat; anything else becomes the fallback. */
function codeOf(e: unknown, fallback: string): string {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return CODE.test(m) ? m : fallback;
}

/**
 * begin_run (busy: stop) -> due_work -> at most ONE sendStep per campaign, at most TICK_MAX_SENDS sends, no new item
 * after budgetMs -> finish_run (always). Per-item errors are counted; the first one is kept as a short code.
 * A failure of the clock itself is recorded and rethrown.
 * `smtp` is a test seam only; the route never passes it.
 */
export async function runTick(opts: {
  store: TickStore;
  origins: Origins;
  now?: () => number;
  budgetMs?: number;
  smtp?: SmtpTransport;
}): Promise<TickResult> {
  const { store, origins } = opts;
  const now = opts.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? TICK_BUDGET_MS;
  const smtp = opts.smtp ?? new NoSendSmtp();
  const begin = await store.beginRun();
  if (begin.busy) return { runId: begin.runId, outcome: "busy", campaigns: 0, sent: 0, failed: 0 };
  const runId = begin.runId;
  const started = now();
  let campaigns = 0;
  let sent = 0;
  let failed = 0;
  let attempts = 0;
  let firstError: string | null = null;
  const finish = () => store.finishRun(runId, { campaigns, sent, failed }, firstError);

  try {
    const ids = (await store.dueWork(runId)).slice(0, TICK_MAX_CAMPAIGNS);
    for (const id of ids) {
      if (attempts >= TICK_MAX_SENDS || now() - started >= budgetMs) break;
      campaigns++;
      try {
        const r = await sendStep({ store, smtp }, id, runId, origins);
        if (r.outcome === "dry_run") {
          sent++;
          attempts++;
        } else if (r.outcome === "failed") {
          failed++;
          attempts++;
          firstError ??= codeOf(r.error, "send_failed");
        }
        // gap, daily_limit, campaign_limit, outside_window, nothing_due, not_active, ...: the rules said "not now"; nothing to count
      } catch (e) {
        failed++;
        attempts++;
        firstError ??= codeOf(e, "step_error");
      }
    }
  } catch (e) {
    firstError ??= codeOf(e, "tick_error");
    await finish().catch(() => undefined);
    throw e;
  }
  await finish();
  return { runId, outcome: firstError ? "error" : "ok", campaigns, sent, failed };
}
