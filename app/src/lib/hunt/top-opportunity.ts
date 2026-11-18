import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type OppFacts = {
  id?: string;
  title: string | null;
  signal_date: string | null;
  source: string | null;
  source_url: string | null;
  priority_codes: string[];
  hook_en: string | null;
  checks: { contact?: { path?: string; value_source_url?: string | null } } | null;
  open_questions: string[];
  contact_path: "phone" | "bids" | "vendor_portal" | "none";
  contact_value: string | null;
};

export type OtherOpp = Pick<OppFacts, "title" | "signal_date" | "source_url">;

// Same stable order for both queries: the top job never reappears among the others and ties never swap jobs.
const ordered = <T extends { order: (c: string, o: { ascending: boolean; nullsFirst?: boolean }) => T }>(q: T): T =>
  q.order("priority", { ascending: false }).order("signal_date", { ascending: false, nullsFirst: false }).order("id", { ascending: true });

/** The next open opportunities of a lead after the top one (up to 3, best first) and how many others it has in all. */
export async function otherOpportunities(db: SupabaseClient, leadId: string, topId: string | null | undefined): Promise<{ items: OtherOpp[]; total: number }> {
  if (!topId) return { items: [], total: 0 };
  const { data, count } = await ordered(db
    .from("lead_opportunities")
    .select("title, signal_date, source_url", { count: "exact" })
    .eq("lead_id", leadId)
    .eq("status", "open")
    .neq("id", topId))
    .limit(3);
  return { items: (data as OtherOpp[] | null) ?? [], total: count ?? 0 };
}

/** The highest-priority open opportunity of a lead (RLS: members of its workspace only), or null. */
export async function topOpportunity(db: SupabaseClient, leadId: string): Promise<OppFacts | null> {
  const { data } = await ordered(db
    .from("lead_opportunities")
    .select("id, title, signal_date, source, source_url, priority_codes, hook_en, checks, open_questions, contact_path, contact_value")
    .eq("lead_id", leadId)
    .eq("status", "open"))
    .limit(1)
    .maybeSingle();
  return (data as OppFacts | null) ?? null;
}
