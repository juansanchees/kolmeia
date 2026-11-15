import { z } from "zod";
import { validDelays, type StepDelays } from "@/lib/email/schedule";
import { LEAD_STATUSES, type LeadStatus } from "@/lib/leads/types";
import { TEMPERATURES } from "@/lib/research/types";

// Client-safe: the answers of the E-mail agent's creation chat (spec §6.3). Stored as agents.config.

export const TONES = ["direct", "friendly", "consultive"] as const;
export type Tone = (typeof TONES)[number];

/** Leads the chat may pick from: new ones, the call list, and lost ones (others are blocked by C2/C3 anyway). */
export const PICKABLE_STATUSES = ["new", "call_list", "lost"] as const satisfies readonly LeadStatus[];

export const MAX_LEADS = 500;
export const MAX_MAILBOXES = 10;

export type LeadFilterConfig = { statuses: LeadStatus[]; agentId: string | null; temperature: string | null; approach: "email" | null };
export type EmailAgentConfig = { filter: LeadFilterConfig; tone: Tone; steps: 1 | 2 | 3; delays: StepDelays; mailboxIds: string[] };

export const leadFilterSchema = z.object({
  statuses: z.array(z.enum(LEAD_STATUSES)).min(1).max(LEAD_STATUSES.length),
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
