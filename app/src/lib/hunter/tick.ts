import "server-only";
import type { AiTransport } from "@/lib/ai/types";
import { advance, needsAdvance, type StepOutcome } from "@/lib/research/engine";
import type { ResearchStore } from "@/lib/research/store";
import type { HunterCounts, HunterPauseReason, HunterTickStore } from "./tick-store";

// The Caçador clock (C7): one bounded tick, called by pg_cron through the route. It advances due agent runs with the
// unchanged engine, one bounded step at a time, while this tick holds the run's step lease. Logs nothing; the only
// trace is the heartbeat row (ids, times, counts, one short error code) [R10].

export const HUNTER_TICK_BUDGET_MS = 120_000;
export const HUNTER_MAX_RUNS = 3;
export const HUNTER_MAX_STEPS = 12;

const CODE = /^[a-z0-9_:]{1,60}$/;
const PAUSE_CODES: ReadonlySet<string> = new Set<HunterPauseReason>(["daily_cap", "user_cap", "global_cap", "no_access"]);

export type HunterTickResult = { tickId: string; outcome: "ok" | "busy" | "error" } & HunterCounts;

function codeOf(e: unknown, fallback: string): string {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return CODE.test(m) ? m : fallback;
}

/**
 * begin (busy: stop) -> due work (oldest first, at most HUNTER_MAX_RUNS) -> per run, step while it needs advancing, the
 * budget is not spent and fewer than HUNTER_MAX_STEPS steps ran -> finish (always).
 * A refusal while the token was already accepted (HunterAuthError inside a step: the run left the hunter path) aborts
 * THAT run only. A token refusal at begin or due work propagates (the route answers 401).
 * `step` is a test seam only; the route never passes it.
 */
export async function runHunterTick(opts: {
  store: HunterTickStore;
  transport: AiTransport | null;
  now?: () => number;
  budgetMs?: number;
  batchSize?: number;
  step?: (research: ResearchStore, runId: string, holder: string) => Promise<StepOutcome>;
}): Promise<HunterTickResult> {
  const { store, transport } = opts;
  const now = opts.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? HUNTER_TICK_BUDGET_MS;
  const begin = await store.beginTick();
  if (begin.busy) return { tickId: begin.tickId, outcome: "busy", runs: 0, steps: 0, paused: 0, failed: 0 };
  const tickId = begin.tickId;
  const started = now();
  const counts: HunterCounts = { runs: 0, steps: 0, paused: 0, failed: 0 };
  let firstError: string | null = null;
  // The budget never blocks the first step of a tick (budget 0 = exactly one step per tick).
  const spent = () => counts.steps > 0 && now() - started >= budgetMs;
  const finish = () => store.finishTick(tickId, counts, firstError);

  try {
    const research = store.research(tickId);
    const step = opts.step ?? ((r, runId, holder) => advance({ store: r, transport, batchSize: opts.batchSize }, runId, holder));
    const ids = (await store.dueWork(tickId)).slice(0, HUNTER_MAX_RUNS);
    let stop = false;
    for (const runId of ids) {
      if (stop || counts.steps >= HUNTER_MAX_STEPS || spent()) break;
      counts.runs++;
      try {
        while (counts.steps < HUNTER_MAX_STEPS && !spent()) {
          const r = await step(research, runId, tickId);
          if (r.kind === "ai_error") {
            if (r.code === "not_configured") {
              stop = true;
              break;
            }
            if (PAUSE_CODES.has(r.code)) {
              await store.pauseAgent(tickId, runId, r.code as HunterPauseReason);
              counts.paused++;
            }
            break;
          }
          if (r.kind !== "stepped") break;
          counts.steps++;
          if (!needsAdvance(r.run)) break;
        }
      } catch (e) {
        counts.failed++;
        firstError ??= codeOf(e, e instanceof Error && e.name === "HunterAuthError" ? "run_refused" : "step_error");
      }
    }
  } catch (e) {
    firstError ??= codeOf(e, "tick_error");
    await finish().catch(() => undefined);
    throw e;
  }
  await finish();
  return { tickId, outcome: firstError ? "error" : "ok", ...counts };
}
