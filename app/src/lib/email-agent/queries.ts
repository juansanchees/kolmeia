import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listLeads } from "@/lib/leads/queries";
import type { LeadListItem } from "@/lib/leads/types";
import type { SequenceInput } from "@/lib/ai/prompts/email-sequence";
import { MAX_LEADS, type LeadFilterConfig } from "./types";

/** The leads a filter picks (as the user: RLS applies), newest first, at most 500. Ids go to add_leads_to_campaign. */
export async function pickLeads(db: SupabaseClient, ws: string, filter: LeadFilterConfig): Promise<LeadListItem[]> {
  const items = await listLeads(db, ws, { statuses: filter.statuses });
  return items
    .filter(({ lead, best }) => {
      if (filter.agentId && lead.origin_agent_id !== filter.agentId) return false;
      if (filter.temperature && best?.temperature !== filter.temperature) return false;
      if (filter.approach && best?.approach !== filter.approach) return false;
      return true;
    })
    .slice(0, MAX_LEADS);
}

export async function selectLeads(db: SupabaseClient, ws: string, filter: LeadFilterConfig): Promise<{ ids: string[]; withEmail: number; withoutEmail: number }> {
  const items = await pickLeads(db, ws, filter);
  const withEmail = items.filter((i) => Boolean(i.display.email)).length;
  return { ids: items.map((i) => i.lead.id), withEmail, withoutEmail: items.length - withEmail };
}

/** Most common first; ties keep first-seen order. */
function top(values: (string | null | undefined)[], n: number): string[] {
  const count = new Map<string, number>();
  for (const v of values) {
    const s = v?.replace(/\s+/g, " ").trim();
    if (s) count.set(s, (count.get(s) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([s]) => s);
}

/** What the AI may know about the audience: a count, up to 10 types and 10 towns. Never one lead's data. */
export function audienceOf(items: LeadListItem[]): SequenceInput["audience"] {
  return {
    count: items.length,
    types: top(items.map((i) => (i.best?.company_type === "other" ? null : i.best?.company_type)), 10),
    towns: top(items.map((i) => i.display.city), 10),
  };
}
