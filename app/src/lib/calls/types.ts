// Call vocabulary (migration 0020 part B). Safe for client and server.
import { z } from "zod";
import { TEMPERATURES, type Temperature } from "@/lib/research/types";

/** Spec §7.4, in this order (the SQL check on call_logs.outcome lists the same values). */
export const CALL_OUTCOMES = ["no_answer", "voicemail", "gatekeeper", "talked", "meeting_booked", "not_interested", "wrong_number", "do_not_call"] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/** "Atendeu" (spec §6.6): someone picked up. */
export const ANSWERED: readonly CallOutcome[] = ["gatekeeper", "talked", "meeting_booked", "not_interested", "do_not_call"];

/** One call as stored by log_call. There is no recording: `recorded` is always false. */
export type CallLogRow = {
  id: string;
  workspace_id: string;
  lead_id: string;
  agent_id: string | null;
  called_by: string | null;
  called_at: string;
  phone_used: string;
  outcome: CallOutcome;
  spoke_to: string;
  notes: string;
  next_step: string;
  next_step_at: string | null;
  recorded: false;
  created_at: string;
};

export const CALL_LOG_COLUMNS = "id, workspace_id, lead_id, agent_id, called_by, called_at, phone_used, outcome, spoke_to, notes, next_step, next_step_at, recorded, created_at";

/** The 3 questions of the call agent (spec §6.3): who calls, how many a day, which leads. Keys exact (SQL call_agent_config_ok). */
export type CallAgentConfig = { caller_id: string; per_day: number; min_level: number; temperatures: Temperature[] };

export const callAgentConfigSchema = z.strictObject({
  caller_id: z.uuid(),
  per_day: z.number().int().min(1).max(50).default(20),
  min_level: z.number().int().min(0).max(4).default(1),
  temperatures: z
    .array(z.enum(TEMPERATURES))
    .default([])
    .refine((a) => new Set(a).size === a.length, "duplicate temperature"),
});

/** One row of a day's call list (list_date is the New York day). `manual`: added by hand, not counted against per_day. */
export type CallListItemRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  lead_id: string;
  caller_id: string;
  list_date: string;
  position: number;
  manual: boolean;
  created_at: string;
};
