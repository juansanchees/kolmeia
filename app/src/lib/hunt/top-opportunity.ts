import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type OppFacts = {
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

/** The next open opportunities of a lead after the top one (up to 3, best first) and how many others it has in all. */
export async function otherOpportunities(db: SupabaseClient, leadId: string): Promise<{ items: OtherOpp[]; total: number }> {
  const { data, count } = await db
    .from("lead_opportunities")
    .select("title, signal_date, source_url", { count: "exact" })
    .eq("lead_id", leadId)
    .eq("status", "open")
    .order("priority", { ascending: false })
    .range(1, 3);
  return { items: (data as OtherOpp[] | null) ?? [], total: Math.max(0, (count ?? 0) - 1) };
}

/** The highest-priority open opportunity of a lead (RLS: members of its workspace only), or null. */
export async function topOpportunity(db: SupabaseClient, leadId: string): Promise<OppFacts | null> {
  const { data } = await db
    .from("lead_opportunities")
    .select("title, signal_date, source, source_url, priority_codes, hook_en, checks, open_questions, contact_path, contact_value")
    .eq("lead_id", leadId)
    .eq("status", "open")
    .order("priority", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as OppFacts | null) ?? null;
}
