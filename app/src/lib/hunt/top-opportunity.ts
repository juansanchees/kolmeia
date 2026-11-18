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
