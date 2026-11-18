// One round of a campaign: what changed in the queue, which sources were tried, what still blocks, and why it stopped.
// Codes only; the words are P5's messages.
import type { CoverageRow } from "@/lib/kb/coverage";

export type StopReason = "fulfilled" | "limit" | "exhausted" | "waiting";
/** A thing that keeps the round from a conclusion. `ask` = only the person can unblock it (login, a document, a choice). */
export type Blocker = { code: string; ask?: boolean };
export type RoundSummary = {
  new: number;
  updated: number;
  demoted: number;
  sources: { source: string; town: string; outcome: string; reason?: string }[];
  blockers: string[];
  asks: string[];
};

/** `before`: priorities at the start of the round; `after`: after it (new rows and re-scored ones). */
export function summarizeRound(before: { id: string; priority: number }[], after: { id: string; priority: number }[], coverage: CoverageRow[], blockers: Blocker[]): RoundSummary {
  const prev = new Map(before.map((b) => [b.id, b.priority]));
  const s: RoundSummary = { new: 0, updated: 0, demoted: 0, sources: [], blockers: [], asks: [] };
  for (const a of after) {
    const p = prev.get(a.id);
    if (p === undefined) s.new++;
    else if (a.priority < p) s.demoted++;
    else if (a.priority > p) s.updated++;
  }
  s.sources = coverage.map((c) => ({ source: c.source, town: c.town, outcome: c.outcome, ...(c.reason ? { reason: c.reason } : {}) }));
  s.blockers = [...new Set(blockers.filter((b) => !b.ask).map((b) => b.code))];
  s.asks = [...new Set(blockers.filter((b) => b.ask).map((b) => b.code))];
  return s;
}

/**
 * Why a round stops, or null when it should keep going (the last pass found new evidence and nothing ran out).
 * `waitingSteps` = steps left that need the person or live access; everything else keeps running without them.
 */
export function stopReason(i: { fulfilled: boolean; spentUsd: number; limitUsd: number; elapsedMs: number; limitMs: number; newEvidence: boolean; waitingSteps: number }): StopReason | null {
  if (i.fulfilled) return "fulfilled";
  if (i.spentUsd >= i.limitUsd || i.elapsedMs >= i.limitMs) return "limit";
  if (i.newEvidence) return null;
  return i.waitingSteps > 0 ? "waiting" : "exhausted";
}
