import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoverageRow } from "@/lib/kb/coverage";
import type { CampaignParams, OfferInput } from "@/lib/offers/types";
import { classifyBuilding } from "@/lib/offers/hvac-new-construction";
import type { CallOutcome } from "@/lib/calls/types";
import type { LeadStatus } from "@/lib/leads/types";
import type { HuntDb } from "./flow";
import type { StoredOpp } from "./rescore";

/** Ids per request for `.in()` filters (~200 uuids = ~7 KB of URL). */
export const ID_CHUNK = 200;

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
      const status = new Map<string, LeadStatus>();
      const lastCall = new Map<string, { outcome: CallOutcome; at: string }>();
      // ids go in the URL: chunk them so a big campaign does not exceed its length limit
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const part = ids.slice(i, i + ID_CHUNK);
        const [leads, calls] = await Promise.all([
          db.from("leads").select("id, status").in("id", part),
          db.from("call_logs").select("lead_id, outcome, called_at").in("lead_id", part),
        ]);
        for (const l of must(leads, "outcomes leads") as { id: string; status: LeadStatus }[]) status.set(l.id, l.status);
        for (const c of must(calls, "outcomes calls") as { lead_id: string; outcome: CallOutcome; called_at: string }[]) {
          const prev = lastCall.get(c.lead_id);
          if (!prev || c.called_at > prev.at) lastCall.set(c.lead_id, { outcome: c.outcome, at: c.called_at });
        }
      }
      return opps.filter((o) => o.facts).map((o) => ({ lead_id: o.lead_id, kind: classifyBuilding(o.facts!.signal), status: status.get(o.lead_id), call: lastCall.get(o.lead_id)?.outcome }));
    },
  };
}
