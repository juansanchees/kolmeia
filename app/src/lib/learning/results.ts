// Client-safe rules of the learning loop (migration 0032): which leads count as a good or a bad result, when a new
// results proposal is due, and the sample the AI reads.
import type { LeadStatus } from "@/lib/leads/types";
import type { LearnedProfile } from "@/lib/profile/types";

/** One lead with a result, as results_rows_core returns it (newest result first). */
export type ResultRow = {
  lead_id: string;
  status: LeadStatus;
  /** An e-mail reply of this lead was classified "interested". */
  interested: boolean;
  labeled_at: string;
  name: string | null;
  city: string | null;
  company_type: string | null;
  segment: string | null;
  size_note: string | null;
  biggest_job: string | null;
  biggest_job_usd: number | null;
  permits: number | null;
  origin: string | null;
  note: string | null;
};

/** What results_rows_core returns around the rows. */
export type ResultsData = { last_at: string | null; open_id: string | null; current: unknown; rows: ResultRow[] };

export type ResultLabel = "positive" | "negative" | "neutral";

export const RESULTS_MIN_LABELED = 10;
export const RESULTS_MIN_POSITIVE = 3;
export const RESULTS_EVERY_MS = 7 * 24 * 3_600_000;
/** At most this many good and this many bad leads go to the AI. */
export const RESULTS_SAMPLE_EACH = 40;
/** The room the rows get inside the untrusted wrapper (20 000 characters), minus a margin. */
export const RESULTS_BUDGET_CHARS = 19_000;

/** Positive: meeting, won, or an interested reply on a lead still open. Negative: lost, discarded ("Sem interesse", "Não ligar mais"). Else neutral. */
export function labelOf(r: Pick<ResultRow, "status" | "interested">): ResultLabel {
  if (r.status === "won" || r.status === "meeting") return "positive";
  if (r.status === "lost" || r.status === "discarded") return "negative";
  return r.interested ? "positive" : "neutral";
}

/** Labeled leads (and the good ones among them) whose result came after `since` (all of them when null). */
export function resultCounts(rows: Pick<ResultRow, "status" | "interested" | "labeled_at">[], since: string | null = null): { labeled: number; positive: number } {
  const from = since ? Date.parse(since) : -Infinity;
  let labeled = 0;
  let positive = 0;
  for (const r of rows) {
    const l = labelOf(r);
    if (l === "neutral" || !(Date.parse(r.labeled_at) > from)) continue;
    labeled++;
    if (l === "positive") positive++;
  }
  return { labeled, positive };
}

/** Why learning cannot run yet (null = it can). */
export function learnBlock(c: { labeled: number; positive: number }): "few_labeled" | "few_positive" | null {
  if (c.labeled < RESULTS_MIN_LABELED) return "few_labeled";
  if (c.positive < RESULTS_MIN_POSITIVE) return "few_positive";
  return null;
}

/** The clock's rule: at most once every 7 days, and only with enough new results since the last results proposal. */
export function resultsDue(i: { lastAt: string | null; now: number; rows: Pick<ResultRow, "status" | "interested" | "labeled_at">[] }): boolean {
  if (i.lastAt !== null && i.now - Date.parse(i.lastAt) < RESULTS_EVERY_MS) return false;
  return learnBlock(resultCounts(i.rows, i.lastAt)) === null;
}

export type ResultSample = { n: number; good: boolean; row: ResultRow };

export const RESULT_HEADER = "n|result|name|city|company_type|segment|size|biggest_job|biggest_job_usd|permits|origin|call_note";

const clip = (v: string | number | null, n: number) => String(v ?? "").replace(/[|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

/** One sample as one line (fields clipped, no `|` or newline inside). */
export function resultLine(s: ResultSample): string {
  const r = s.row;
  return [s.n, s.good ? "good" : "bad", clip(r.name, 60), clip(r.city, 30), clip(r.company_type, 20), clip(r.segment, 12), clip(r.size_note, 60), clip(r.biggest_job, 40), clip(r.biggest_job_usd, 12), clip(r.permits, 6), clip(r.origin, 40), clip(r.note, 120)].join("|");
}

/**
 * Up to 40 good and 40 bad leads, newest first, taken in turns (good, bad, good...) while the lines fit `maxChars`.
 * Numbered 1..n in that order: the AI cites these numbers.
 */
export function sampleResults(rows: ResultRow[], each = RESULTS_SAMPLE_EACH, maxChars = RESULTS_BUDGET_CHARS): ResultSample[] {
  const good = rows.filter((r) => labelOf(r) === "positive").slice(0, each);
  const bad = rows.filter((r) => labelOf(r) === "negative").slice(0, each);
  const out: ResultSample[] = [];
  let used = RESULT_HEADER.length;
  for (let i = 0; i < Math.max(good.length, bad.length); i++) {
    for (const [row, isGood] of [[good[i], true], [bad[i], false]] as const) {
      if (!row) continue;
      const s = { n: out.length + 1, good: isGood, row };
      const cost = resultLine(s).length + 1;
      if (used + cost > maxChars) return out;
      used += cost;
      out.push(s);
    }
  }
  return out;
}

/** The approved profile the database returned, or null (it only goes into the prompt as untrusted data). */
export function currentProfileOf(v: unknown): LearnedProfile | null {
  return v && typeof v === "object" && Array.isArray((v as LearnedProfile).points) ? (v as LearnedProfile) : null;
}
