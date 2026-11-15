import { z } from "zod";
import { validDelays, type StepDelays } from "@/lib/email/schedule";
import type { LeadStatus } from "@/lib/leads/types";
import { TEMPERATURES } from "@/lib/research/types";

// Client-safe: the answers of the E-mail agent's creation chat (spec §6.3). Stored as agents.config.

export const TONES = ["direct", "friendly", "consultive"] as const;
export type Tone = (typeof TONES)[number];

/** Leads the chat may pick from: new ones and the call list (lost ones are blocked by D5, the rest by C2/C3). */
export const PICKABLE_STATUSES = ["new", "call_list"] as const satisfies readonly LeadStatus[];

export const MAX_LEADS = 500;
export const MAX_MAILBOXES = 10;

export type LeadFilterConfig = { statuses: LeadStatus[]; agentId: string | null; temperature: string | null; approach: "email" | null };
export type EmailAgentConfig = { filter: LeadFilterConfig; tone: Tone; steps: 1 | 2 | 3; delays: StepDelays; mailboxIds: string[] };

export const leadFilterSchema = z.object({
  statuses: z.array(z.enum(PICKABLE_STATUSES)).min(1).max(PICKABLE_STATUSES.length),
  agentId: z.string().uuid().nullable(),
  temperature: z.enum(TEMPERATURES).nullable(),
  approach: z.literal("email").nullable(),
});

export const emailAgentConfigSchema = z.object({
  filter: leadFilterSchema,
  tone: z.enum(TONES),
  steps: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  delays: z.object({ step2: z.number().int(), step3: z.number().int() }).refine(validDelays),
  mailboxIds: z.array(z.string().uuid()).min(1).max(MAX_MAILBOXES),
});

export type LeadCounts = { total: number; withEmail: number; withoutEmail: number };

/** What the agent page counts (spec §6.6). approved = queued and waiting for the clock. */
export type EmailAgentMetrics = { drafts: number; approved: number; sent: number; replies: number; unsubscribed: number; bounced: number };

/** Pure: message statuses and the campaign's inbound rows. A bounce is not a reply; an unsubscribe is a reply. */
export function emailAgentMetrics(messages: { status: string }[], replies: { is_bounce: boolean; classification: string | null }[]): EmailAgentMetrics {
  const m = (s: string) => messages.filter((x) => x.status === s).length;
  return {
    drafts: m("draft"),
    approved: m("approved"),
    sent: m("sent"),
    replies: replies.filter((r) => !r.is_bounce).length,
    unsubscribed: replies.filter((r) => !r.is_bounce && r.classification === "unsubscribe").length,
    bounced: replies.filter((r) => r.is_bounce).length,
  };
}

export type SequenceExample = { prospect_id: string; company: string; to: string; steps: { step: number; subject: string; body: string }[] };
export type SequencePreview = { digest: string; examples: SequenceExample[] };
