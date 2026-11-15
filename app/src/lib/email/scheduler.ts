import "server-only";
import { clockReplies, type ReplyStore } from "./clock-replies";
import { sendStep, type Origins } from "./engine";
import type { TickStore } from "./scheduler-store";
import type { ImapTransport, SmtpTransport } from "./transport";

// The clock (E1): one bounded tick, called by an external scheduler with no user session. No AI calls.
// It sends, then (0026, E5, real mode only) reads replies of at most 5 mailboxes with rules only (clock-replies.ts).
// Rehearsal by default: the store asks the database for dry_run work only, and the route passes NoSendSmtp (always throws).
// Real mail (0025, D4) needs BOTH locks: the server switch (the route builds a real store and the Gmail transport only
// when realClockEnabled()) AND, in the database, the workspace's C12 gate open with the emergency stop off. The engine
// reads the stop again right before SMTP. Logs nothing; the only trace is the heartbeat row (run id, times, counts, one
// short error code) [R10].

export const TICK_MAX_CAMPAIGNS = 20;
export const TICK_MAX_SENDS = 10;
export const TICK_BUDGET_MS = 40_000;
/** Real mode: no new item after 30 s; one send takes at most 20 s of SMTP (CLOCK_SMTP_TIMEOUTS), inside maxDuration 60. */
export const TICK_REAL_BUDGET_MS = 30_000;
/** E5: the reply phase starts only if the sends ended before this (its own budget, CLOCK_REPLY_BUDGET_MS, then applies). */
export const TICK_REPLY_START_MS = 25_000;
/** E5: the hard stop of the reply phase, from the tick's start (IMAP raced against it), inside maxDuration 60. */
export const TICK_DEADLINE_MS = 50_000;

const CODE = /^[a-z0-9_:]{1,60}$/;

/** The scheduler's SMTP transport while the server switch is off (and the default of runTick): it cannot send. */
export class NoSendSmtp implements SmtpTransport {
  async verify(): Promise<void> {
    throw new Error("scheduler_cannot_send");
  }
  async send(): Promise<{ response: string }> {
    throw new Error("scheduler_cannot_send");
  }
}

export type TickResult = { runId: string; outcome: "ok" | "error" | "busy"; campaigns: number; sent: number; failed: number; replies: number };

/** A short, safe code for the heartbeat; anything else becomes the fallback. */
function codeOf(e: unknown, fallback: string): string {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return CODE.test(m) ? m : fallback;
}

/**
 * begin_run (busy: stop) -> due_work -> at most ONE sendStep per campaign, at most TICK_MAX_SENDS sends, no new item
 * after budgetMs -> finish_run (always). Per-item errors are counted; the first one is kept as a short code.
 * A failure of the clock itself is recorded and rethrown.
 * `smtp`: the route passes NoSendSmtp, or the Gmail transport only behind realClockEnabled(); tests pass a spy.
 * `key`: test seam only (production decrypts with the configured MAILBOX key ring, lazily, inside the engine).
 * `imap` (E5): the route passes the clock's IMAP reader only behind the real switch; null/absent = no reply phase.
 */
export async function runTick(opts: {
  store: TickStore | (TickStore & ReplyStore);
  origins: Origins;
  now?: () => number;
  budgetMs?: number;
  smtp?: SmtpTransport;
  imap?: ImapTransport | null;
  key?: Buffer;
}): Promise<TickResult> {
  const { store, origins } = opts;
  const now = opts.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? TICK_BUDGET_MS;
  const smtp = opts.smtp ?? new NoSendSmtp();
  const begin = await store.beginRun();
  if (begin.busy) return { runId: begin.runId, outcome: "busy", campaigns: 0, sent: 0, failed: 0, replies: 0 };
  const runId = begin.runId;
  const started = now();
  let campaigns = 0;
  let sent = 0;
  let failed = 0;
  let attempts = 0;
  let replies = 0;
  let firstError: string | null = null;
  const finish = () => store.finishRun(runId, { campaigns, sent, failed }, firstError);

  try {
    const ids = (await store.dueWork(runId)).slice(0, TICK_MAX_CAMPAIGNS);
    for (const id of ids) {
      if (attempts >= TICK_MAX_SENDS || now() - started >= budgetMs) break;
      campaigns++;
      try {
        const r = await sendStep({ store, smtp, key: opts.key }, id, runId, origins);
        if (r.outcome === "dry_run" || r.outcome === "sent") {
          sent++;
          attempts++;
        } else if (r.outcome === "sending_paused" && r.messageId) {
          // claimed, then the stop was found on right before SMTP: not sent, failed and retryable by a person
          failed++;
          attempts++;
          firstError ??= "sending_paused";
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
    // E5: replies after the sends, only with an IMAP reader (real switch) and a store that can list reply mailboxes
    if (opts.imap && "replyMailboxes" in store && now() - started < TICK_REPLY_START_MS) {
      const r = await clockReplies(store, opts.imap, now, { key: opts.key, deadline: started + TICK_DEADLINE_MS });
      replies = r.recorded;
      failed += r.failed;
      if (r.error) firstError ??= codeOf(r.error, "reply_error");
    }
  } catch (e) {
    firstError ??= codeOf(e, "tick_error");
    await finish().catch(() => undefined);
    throw e;
  }
  await finish();
  return { runId, outcome: firstError ? "error" : "ok", campaigns, sent, failed, replies };
}
