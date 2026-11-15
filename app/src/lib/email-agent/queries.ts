import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listLeads } from "@/lib/leads/queries";
import type { LeadListItem } from "@/lib/leads/types";
import type { SequenceInput } from "@/lib/ai/prompts/email-sequence";
import { SupabaseAgentStore } from "@/lib/agents/store";
import type { AgentRow } from "@/lib/agents/types";
import { SupabaseEmailStore } from "@/lib/email/supabase-store";
import { CAMPAIGN_COLUMNS, type CampaignRow, type SenderProfile } from "@/lib/email/types";
import type { SequenceStep } from "@/lib/email/template";
import { t } from "@/messages/pt";
import { MAX_LEADS, type EmailAgentMetrics, type LeadFilterConfig, type SequencePreview, type Tone } from "./types";

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

export type SequenceRow = {
  id: string;
  version: number;
  status: "draft" | "approved" | "superseded";
  tone: Tone;
  steps: SequenceStep[];
  step2_delay_days: number | null;
  step3_delay_days: number | null;
  human_edited: boolean;
  ai_model: string | null;
  approved_at: string | null;
};
const SEQUENCE_COLUMNS = "id, version, status, tone, steps, step2_delay_days, step3_delay_days, human_edited, ai_model, approved_at";

/** Head-only counts: no rows travel, whatever the campaign's size. */
async function headCount(q: PromiseLike<{ count: number | null; error: { message: string } | null }>): Promise<number> {
  const { count, error } = await q;
  if (error) throw new Error(`loadEmailAgent: ${error.message}`);
  return count ?? 0;
}

async function loadMetrics(db: SupabaseClient, campaignId: string): Promise<EmailAgentMetrics> {
  const msg = (status: string) => headCount(db.from("email_messages").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId).eq("kind", "sequence").eq("status", status));
  const rep = () => db.from("email_replies").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId);
  const [drafts, approved, sent, replies, unsubscribed, bounced] = await Promise.all([
    msg("draft"),
    msg("approved"),
    msg("sent"),
    headCount(rep().eq("is_bounce", false)),
    headCount(rep().eq("is_bounce", false).eq("classification", "unsubscribe")),
    headCount(rep().eq("is_bounce", true)),
  ]);
  return { drafts, approved, sent, replies, unsubscribed, bounced };
}

export type EmailAgentView = {
  agent: AgentRow;
  campaign: CampaignRow;
  sequence: SequenceRow | null;
  preview: SequencePreview | null;
  metrics: EmailAgentMetrics;
  sender: SenderProfile | null;
  /** C12: every item of the owner's checklist approved. While false, nothing leaves (rehearsal only). */
  c12Ready: boolean;
};

/** Read only, as the user (RLS). The newest sequence version is the one on screen; its 3 examples come from preview_sequence. */
export async function loadEmailAgent(db: SupabaseClient, agentId: string): Promise<EmailAgentView | null> {
  const agent = await new SupabaseAgentStore(db).getAgent(agentId);
  if (!agent || agent.type !== "email") return null;
  const { data: campaign } = await db.from("email_campaigns").select(CAMPAIGN_COLUMNS).eq("agent_id", agentId).maybeSingle();
  if (!campaign) return null;
  const c = campaign as unknown as CampaignRow;

  const { data: seq } = await db.from("email_sequences").select(SEQUENCE_COLUMNS).eq("campaign_id", c.id).order("version", { ascending: false }).limit(1).maybeSingle();
  const sequence = (seq as SequenceRow | null) ?? null;

  const [preview, metrics, sender, c12] = await Promise.all([
    sequence ? db.rpc("preview_sequence", { p_sequence: sequence.id }) : Promise.resolve({ data: null }),
    loadMetrics(db, c.id),
    new SupabaseEmailStore(db).getSender(c.workspace_id),
    db.from("c12_approvals").select("item").eq("workspace_id", c.workspace_id),
  ]);
  const done = new Set(((c12.data ?? []) as { item: string }[]).map((r) => r.item));
  return {
    agent,
    campaign: c,
    sequence,
    preview: (preview.data as SequencePreview | null) ?? null,
    metrics,
    sender,
    c12Ready: Object.keys(t.email.c12.items).every((i) => done.has(i)),
  };
}
