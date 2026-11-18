// The in-app part of a campaign round (controller ruling): save the instruction, merge it into the campaign params,
// start the next round, re-score this campaign's opportunities from their stored facts, finish the round with its summary
// and stop reason, and answer from codes. Base and network work (permits, sites) is the pilot runner's, so a round that
// still needs it stops as `waiting`. The database is behind HuntDb so the order of calls is testable.
import type { Messages } from "@/lib/i18n";
import type { CoverageRow } from "@/lib/kb/coverage";
import { reduceCoverage } from "@/lib/kb/coverage";
import type { CampaignParams } from "@/lib/offers/types";
import { interpretInstruction } from "./interpret";
import { mergeParams, proposePreference, rescore, type Outcome, type StoredOpp } from "./rescore";
import { stopReason, summarizeRound, type Blocker } from "./rounds";
import { agentReply } from "./text";

export type Campaign = { id: string; workspace_id: string; offer: string; params: CampaignParams };

export interface HuntDb {
  /** Calls a database function as the signed-in user; throws on error. */
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T>;
  openRound(campaignId: string): Promise<{ id: string; n: number }>;
  campaignOpps(campaignId: string): Promise<StoredOpp[]>;
  approvedRules(ws: string, offer: string): Promise<CampaignParams[]>;
  coverage(ws: string): Promise<CoverageRow[]>;
  outcomes(campaignId: string): Promise<Outcome[]>;
}

type M = Messages["hunt"];
const now = () => new Date();

/** "Começar por esta": the campaign plus round 1, finished as `waiting` (the operator's pilot script runs the search). */
export async function startCampaign(db: HuntDb, M: M, i: { ws: string; offer: string; region: string; request: string; params: CampaignParams; understood?: string[]; unknown?: string[] }): Promise<string> {
  const id = await db.rpc<string>("hunt_campaign_create", { p_ws: i.ws, p_offer: i.offer, p_region: i.region, p_request: i.request, p_params: i.params });
  const round = await db.openRound(id);
  const summary = summarizeRound([], [], reduceCoverage(await db.coverage(i.ws)), [{ code: "run_pilot", ask: true }]);
  await db.rpc("hunt_round_finish", { p_round: round.id, p_scores: [], p_summary: summary, p_stop_reason: "waiting" });
  const body = agentReply(M, { understood: i.understood ?? [], unknown: i.unknown ?? [], summary, stop: "waiting", head: M.reply.started });
  await db.rpc("hunt_message_add", { p_campaign: id, p_role: "agent", p_body: body, p_round: round.id });
  return id;
}

/** The pilot runner's round. The app closes every round it opens, so the runner opens its own (stored params kept). */
export async function openRunnerRound(db: HuntDb, campaignId: string): Promise<{ id: string; n: number }> {
  const r = await db.rpc<{ round_id: string; n: number }>("hunt_campaign_apply", { p_campaign: campaignId, p_params: null, p_message: null });
  return { id: r.round_id, n: r.n };
}

async function runRound(db: HuntDb, M: M, c: Campaign, params: CampaignParams, reply: { understood: string[]; unknown: string[]; head?: string }, extra: Blocker[] = []) {
  const applied = await db.rpc<{ round_id: string; n: number }>("hunt_campaign_apply", { p_campaign: c.id, p_params: params, p_message: null });
  const opps = await db.campaignOpps(c.id);
  const scores = rescore(opps, c.offer, params, await db.approvedRules(c.workspace_id, c.offer), now());
  const after = new Map(scores.map((s) => [s.opportunity_id, s.priority]));
  const blockers: Blocker[] = [...extra];
  if (!opps.length) blockers.push({ code: "run_pilot", ask: true });
  else if (params.wantBidPath && opps.some((o) => o.facts && !o.facts.contacts.bids_url && !o.facts.contacts.vendor_portal_url)) blockers.push({ code: "need_bid_path" });
  const summary = summarizeRound(opps.map((o) => ({ id: o.id, priority: o.priority })), opps.map((o) => ({ id: o.id, priority: after.get(o.id) ?? o.priority })), reduceCoverage(await db.coverage(c.workspace_id)), blockers);
  const stop = stopReason({ fulfilled: blockers.length === 0, spentUsd: 0, limitUsd: 1, elapsedMs: 0, limitMs: 1, newEvidence: false, waitingSteps: blockers.length }) ?? "waiting";
  await db.rpc("hunt_round_finish", { p_round: applied.round_id, p_scores: scores, p_summary: summary, p_stop_reason: stop });
  await db.rpc("hunt_message_add", { p_campaign: c.id, p_role: "agent", p_body: agentReply(M, { ...reply, summary, stop }), p_round: applied.round_id });
}

/** An instruction in the campaign chat: it applies to this campaign at once. */
export async function applyInstruction(db: HuntDb, M: M, lang: "pt" | "en", c: Campaign, text: string): Promise<void> {
  const it = interpretInstruction(text, lang);
  await db.rpc("hunt_message_add", { p_campaign: c.id, p_role: "user", p_body: text, p_round: null });
  // nothing understood: never "fulfilled"; the round waits on a simple question instead
  const ask: Blocker[] = it.understoodCodes.length ? [] : [{ code: "say_what_to_change", ask: true }];
  await runRound(db, M, c, mergeParams(c.params, it.params), { understood: it.understoodCodes, unknown: it.unknown }, ask);
}

/** Approve a proposed rule, or undo one (proposed or approved). Either way the queue is re-scored in a new round. */
export async function decidePreference(db: HuntDb, M: M, c: Campaign, prefId: string, decision: "approved" | "undone"): Promise<void> {
  await db.rpc("offer_preference_decide", { p_pref: prefId, p_decision: decision });
  await runRound(db, M, c, c.params, { understood: [], unknown: [], head: decision === "approved" ? M.reply.approved : M.reply.undone });
}

/** Proposes a lasting rule from the call results of this campaign (the database returns the same row for the same rule). */
export async function refreshPreference(db: HuntDb, c: Campaign): Promise<void> {
  const [outcomes, queue, approved] = await Promise.all([db.outcomes(c.id), db.campaignOpps(c.id), db.approvedRules(c.workspace_id, c.offer)]);
  const p = proposePreference({ offer: c.offer, outcomes, queue, campaign: c.params, approved, now: now() });
  if (p) await db.rpc("offer_preference_propose", { p_ws: c.workspace_id, p_offer: c.offer, p_rule: p.rule, p_example_lead_ids: p.example_lead_ids, p_expected_effect: p.expected_effect });
}
