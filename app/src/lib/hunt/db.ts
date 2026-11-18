import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoverageRow } from "@/lib/kb/coverage";
import type { CampaignParams, OfferInput } from "@/lib/offers/types";
import { classifyBuilding } from "@/lib/offers/hvac-new-construction";
import type { CallOutcome } from "@/lib/calls/types";
import type { LeadStatus } from "@/lib/leads/types";
import type { HuntDb } from "./flow";
import type { StoredOpp } from "./rescore";

const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

/** HuntDb over the signed-in user's client: every read and write goes through RLS and the 0042 functions (no service key). */
export function supabaseHuntDb(db: SupabaseClient): HuntDb {
  return {
    async rpc<T>(fn: string, args: Record<string, unknown>) {
      return must(await db.rpc(fn, args), fn) as T;
    },
    async openRound(campaignId) {
      const r = must(await db.from("hunt_rounds").select("id, n").eq("campaign_id", campaignId).is("ended_at", null).order("n", { ascending: false }).limit(1).maybeSingle(), "openRound");
      if (!r) throw new Error("openRound: no open round");
      return r as { id: string; n: number };
    },
    async campaignOpps(campaignId) {
      return must(await db.from("lead_opportunities").select("id, priority, facts").eq("campaign_id", campaignId).eq("status", "open").limit(2000), "campaignOpps") as StoredOpp[];
    },
    async approvedRules(ws, offer) {
      const rows = must(await db.from("offer_preferences").select("rule").eq("workspace_id", ws).eq("offer", offer).eq("status", "approved").order("proposed_at"), "approvedRules");
      return (rows ?? []).map((r) => r.rule as CampaignParams);
    },
    async coverage(ws) {
      return must(await db.rpc("kb_coverage", { p_ws: ws }), "kb_coverage") as CoverageRow[];
    },
    async outcomes(campaignId) {
      const opps = must(await db.from("lead_opportunities").select("lead_id, facts").eq("campaign_id", campaignId), "outcomes opps") as { lead_id: string; facts: OfferInput | null }[];
      const ids = [...new Set(opps.map((o) => o.lead_id))];
      if (!ids.length) return [];
      const [leads, calls] = await Promise.all([
        db.from("leads").select("id, status").in("id", ids),
        db.from("call_logs").select("lead_id, outcome, called_at").in("lead_id", ids).order("called_at", { ascending: false }),
      ]);
      const status = new Map((must(leads, "outcomes leads") as { id: string; status: LeadStatus }[]).map((l) => [l.id, l.status]));
      const lastCall = new Map<string, CallOutcome>();
      for (const c of must(calls, "outcomes calls") as { lead_id: string; outcome: CallOutcome }[]) if (!lastCall.has(c.lead_id)) lastCall.set(c.lead_id, c.outcome);
      return opps.filter((o) => o.facts).map((o) => ({ lead_id: o.lead_id, kind: classifyBuilding(o.facts!.signal), status: status.get(o.lead_id), call: lastCall.get(o.lead_id) }));
    },
  };
}
