import "server-only";
import type { AiTransport } from "@/lib/ai/types";
import { qualifyLead } from "./cascade";
import { nodeRawHttp, type RawHttp } from "./site/net";
import type { QualifierTickStore } from "./store";
import type { PlacesClient, QualifierCounts, QualifierPauseReason } from "./types";

// The Qualificador clock: begin -> claim a lead -> cascade it -> next, within the budget -> finish (always). A lead is
// never left locked: a lead that stays in the queue is released (a pause frees it first), a finished one is already free.
// Logs nothing; the only trace is the heartbeat row (counts and one short error code).

export const QUALIFIER_TICK_BUDGET_MS = 60_000;
export const QUALIFIER_MAX_LEADS = 10;
/** A lead can take up to SITE_LIMITS.totalMs (30 s) in P2: no new claim with less than that plus a margin left. */
export const QUALIFIER_CLAIM_FLOOR_MS = 35_000;

const CODE = /^[a-z0-9_:]{1,60}$/;
export type QualifierTickResult = { tickId: string; outcome: "ok" | "busy" | "error" } & QualifierCounts;

/** The database refused one lead (42501) or the path refused the token. */
function isRefusal(e: unknown): boolean {
  return e instanceof Error && (e.name === "HunterAuthError" || (e as { code?: unknown }).code === "42501");
}

function codeOf(e: unknown, fallback: string): string {
  if (e instanceof Error && e.name === "HunterAuthError") return "refused";
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return CODE.test(m) ? m : fallback;
}

export async function runQualifierTick(opts: {
  store: QualifierTickStore;
  transport: AiTransport | null;
  http?: RawHttp;
  places?: PlacesClient | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  budgetMs?: number;
  maxLeads?: number;
}): Promise<QualifierTickResult> {
  const { store } = opts;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const budgetMs = opts.budgetMs ?? QUALIFIER_TICK_BUDGET_MS;
  const maxLeads = opts.maxLeads ?? QUALIFIER_MAX_LEADS;
  const begin = await store.beginTick();
  const zero: QualifierCounts = { leads: 0, steps: 0, paused: 0, failed: 0 };
  if (begin.busy) return { tickId: begin.tickId, outcome: "busy", ...zero };
  const tickId = begin.tickId;
  const started = now();
  const counts: QualifierCounts = { ...zero };
  let firstError: string | null = null;
  const gaps = new Map<string, number>();
  const paused = new Set<string>();
  // leads that failed in this tick stay out of it (their lock is held until finishTick), so retries spread across ticks
  let lostLead = false;

  try {
    // no budget, nothing claimed; otherwise a lead is claimed only while enough time is left to finish it
    while (counts.leads < maxLeads && budgetMs > 0 && budgetMs - (now() - started) >= QUALIFIER_CLAIM_FLOOR_MS) {
      const lead = await store.claimNext(tickId);
      if (!lead) break;
      if (lostLead) {
        // the next claim works: the refusal belonged to that one lead
        firstError ??= "lead_gone";
        lostLead = false;
      }
      counts.leads++;
      // a pause is already recorded for this workspace in this tick: give the lead back and look no further
      if (paused.has(lead.workspaceId)) {
        await store.release(tickId, lead.leadId).catch(() => undefined);
        continue;
      }
      let keep = false;
      let pauseReason: QualifierPauseReason | undefined;
      try {
        const r = await qualifyLead(lead, {
          store,
          tickId,
          transport: opts.transport,
          http: opts.http ?? nodeRawHttp,
          places: opts.places ?? null,
          sleep,
          now,
          gaps,
        });
        counts.steps += r.steps;
        // a failed lead is not released: it stays locked until finishTick frees it, out of the rest of this tick
        keep = r.result === "requeued" && !r.errored;
        if (r.result === "paused") pauseReason = r.pauseReason;
      } catch (e) {
        counts.failed++;
        if (isRefusal(e)) lostLead = true;
        else firstError ??= codeOf(e, "lead_error");
      }
      if (pauseReason) {
        // pause first (it needs the lead's lock, and frees this tick's locks in the workspace), then nothing to release
        try {
          await store.pause(tickId, lead.workspaceId, pauseReason);
          counts.paused++;
          paused.add(lead.workspaceId);
        } catch (e) {
          counts.failed++;
          firstError ??= codeOf(e, "pause_error");
          await store.release(tickId, lead.leadId).catch(() => undefined);
        }
      } else if (keep) {
        await store.release(tickId, lead.leadId).catch(() => undefined);
      }
    }
    if (lostLead) firstError ??= "refused"; // no later claim proved the token fine
  } catch (e) {
    firstError ??= codeOf(e, "tick_error");
    await store.finishTick(tickId, counts, firstError).catch(() => undefined);
    throw e;
  }
  await store.finishTick(tickId, counts, firstError);
  return { tickId, outcome: firstError ? "error" : "ok", ...counts };
}
