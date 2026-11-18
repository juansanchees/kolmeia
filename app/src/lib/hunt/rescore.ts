// Re-scoring a campaign's stored opportunities from their saved `facts` (no new search), and proposing a lasting
// preference from call results. Pure: the database only stores what comes out (hunt_round_finish, offer_preference_propose).
import type { CallOutcome } from "@/lib/calls/types";
import { labelOf } from "@/lib/learning/results";
import type { LeadStatus } from "@/lib/leads/types";
import { getOffer } from "@/lib/offers";
import type { BuildingKind, CampaignParams, OfferInput } from "@/lib/offers/types";

/** A lead_opportunities row as the app reads it (0041 + 0042). */
export type StoredOpp = { id: string; priority: number; facts: OfferInput | null };
export type Move = "up" | "down" | "same";
/** One element of hunt_round_finish's p_scores (`move` is read only by the app). */
export type Rescored = { opportunity_id: string; priority: number; priority_codes: string[]; open_questions: string[]; move: Move };

const KIND_KEYS = ["preferKinds", "deprioritizeKinds"] as const;

/**
 * The params after a new instruction: kind lists accumulate, a kind the new instruction puts in one list leaves the other
 * (the newest instruction wins), scalars are replaced. Every caller sends the result to hunt_campaign_apply, which stores it as is.
 */
export function mergeParams(current: CampaignParams, incoming: Partial<CampaignParams>): CampaignParams {
  const out: CampaignParams = { ...current, ...incoming };
  for (const [key, other] of [KIND_KEYS, [...KIND_KEYS].reverse()] as const) {
    const merged = [...new Set([...(current[key] ?? []), ...(incoming[key] ?? [])])].filter((k) => !incoming[other]?.includes(k));
    if (merged.length) out[key] = merged;
    else delete out[key];
  }
  return out;
}

/** Approved preferences of (workspace, offer) in order, then this campaign's params on top: on a conflict the campaign wins. */
export function effectiveParams(campaign: CampaignParams, approved: CampaignParams[]): CampaignParams {
  return [...approved, campaign].reduce<CampaignParams>(mergeParams, {});
}

/** Opportunities without stored facts (delivered before 0042) are left out: nothing to re-score them from. */
export function rescore(opps: StoredOpp[], offer: string, campaign: CampaignParams, approved: CampaignParams[], now: Date): Rescored[] {
  const o = getOffer(offer);
  const params = effectiveParams(campaign, approved);
  return opps.filter((x) => x.facts).map((x) => {
    const v = o.evaluate(x.facts!, now, params);
    return { opportunity_id: x.id, priority: v.priority, priority_codes: v.priorityCodes, open_questions: v.openQuestions, move: v.priority > x.priority ? "up" : v.priority < x.priority ? "down" : "same" };
  });
}

/** A call result or explicit feedback on one lead of one campaign, with the building kind of its opportunity. */
export type Outcome = { lead_id: string; kind: BuildingKind; status?: LeadStatus; call?: CallOutcome; feedback?: "good" | "bad" };
export type PreferenceProposal = { offer: string; rule: CampaignParams; example_lead_ids: string[]; expected_effect: { up: number; down: number } };

export const PREFERENCE_MIN_EXAMPLES = 3;

// Same mapping as lead_status_after_call (0020): what the lead's status becomes after this call.
const statusAfterCall = (c: CallOutcome): LeadStatus | null => (c === "meeting_booked" ? "meeting" : c === "not_interested" || c === "do_not_call" ? "lost" : null);

function label(o: Outcome): "positive" | "negative" | "neutral" {
  if (o.feedback) return o.feedback === "good" ? "positive" : "negative";
  const status = o.status ?? (o.call ? statusAfterCall(o.call) : null);
  return status ? labelOf({ status, interested: false }) : "neutral";
}

/**
 * When at least 3 different leads of one kind point the same way (refusals/discards or meetings/wins), proposes a
 * lasting rule with the leads that motivated it and how many queue items would move. Never applies anything.
 */
export function proposePreference(i: { offer: string; outcomes: Outcome[]; queue: StoredOpp[]; campaign: CampaignParams; approved: CampaignParams[]; now: Date }): PreferenceProposal | null {
  const votes = new Map<string, Set<string>>();
  for (const o of i.outcomes) {
    const l = label(o);
    if (l === "neutral") continue;
    const k = `${l === "negative" ? "down" : "up"}:${o.kind}`;
    votes.set(k, (votes.get(k) ?? new Set()).add(o.lead_id));
  }
  const already = (dir: string, kind: BuildingKind) => i.approved.some((p) => (dir === "down" ? p.deprioritizeKinds : p.preferKinds)?.includes(kind));
  // Most leads first; on a tie the refusal wins (a wasted call costs more than a missed one).
  const best = [...votes.entries()]
    .map(([k, ids]) => ({ dir: k.split(":")[0], kind: k.split(":")[1] as BuildingKind, ids: [...ids] }))
    .filter((v) => v.ids.length >= PREFERENCE_MIN_EXAMPLES && !already(v.dir, v.kind))
    .sort((a, b) => b.ids.length - a.ids.length || (a.dir === "down" ? -1 : 1))[0];
  if (!best) return null;
  const rule: CampaignParams = best.dir === "down" ? { deprioritizeKinds: [best.kind] } : { preferKinds: [best.kind] };
  const before = new Map(rescore(i.queue, i.offer, i.campaign, i.approved, i.now).map((r) => [r.opportunity_id, r.priority]));
  const after = rescore(i.queue, i.offer, i.campaign, [...i.approved, rule], i.now);
  const expected_effect = { up: 0, down: 0 };
  for (const r of after) {
    const b = before.get(r.opportunity_id)!;
    if (r.priority > b) expected_effect.up++;
    else if (r.priority < b) expected_effect.down++;
  }
  return { offer: i.offer, rule, example_lead_ids: best.ids.slice(0, 20), expected_effect };
}
