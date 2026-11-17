// Lead vocabulary (migration 0009). Safe for client and server.
import type { CandidateRow } from "@/lib/research/rows";
import type { CheckWithEvidence } from "@/lib/research/store";
import type { AiCell } from "@/lib/ai-questions/types";
import type { EmailQuality } from "./email-quality";

export const LEAD_STATUSES = ["new", "call_list", "in_campaign", "replied", "with_closer", "meeting", "won", "lost", "discarded"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const SEGMENTS = ["residential", "small", "large"] as const;
export type Segment = (typeof SEGMENTS)[number];

export const LEAD_STAGES = ["new", "contacted", "replied", "meeting", "closed"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export type LeadRow = {
  id: string;
  workspace_id: string;
  best_candidate_id: string | null;
  status: LeadStatus;
  origin_kind: "agent" | "one_off" | "import";
  origin_agent_id: string | null;
  origin_run_id: string | null;
  origin_import_id: string | null;
  owner_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  /** 0-4, computed by the database (migration 0014). */
  level: number;
  /** Shown until the sender says "Ok": the level fell for this field. */
  level_note: { from: number; to: number; field: string } | null;
  /** Hand-off to a closer (migration 0020): when, by whom, and the brief she reads. */
  handed_off_at: string | null;
  handed_off_by: string | null;
  closer_brief: unknown;
  /** C2: never called again; set by a do_not_call outcome. */
  do_not_call: boolean;
  do_not_call_at: string | null;
  /** Set by the database (migration 0027) on the first call, real e-mail or hand-off; null = never contacted. */
  first_contacted_at: string | null;
  last_touch_at: string | null;
  /** Migration 0030. Unused since 16/11 (archive removed: a finished lead is lost or discarded); the column stays. */
  archived_at: string | null;
  /** Migration 0030: the sender's manual type; null = automatic (classify.ts). */
  segment: Segment | null;
};

export const LEAD_COLUMNS = "id, workspace_id, best_candidate_id, status, origin_kind, origin_agent_id, origin_run_id, origin_import_id, owner_id, first_seen_at, last_seen_at, level, level_note, handed_off_at, handed_off_by, closer_brief, do_not_call, do_not_call_at, first_contacted_at, last_touch_at, archived_at, segment";

export const LEAD_FIELD_NAMES = [
  "name", "phone", "email", "website", "address", "city", "state", "zip", "contact_name", "contact_title", "company_type", "note", "active_project", "place_id",
] as const;
export type LeadFieldName = (typeof LEAD_FIELD_NAMES)[number];

/** One value of a lead with where it came from (migration 0011). */
export type LeadFieldRow = {
  id: string;
  lead_id: string;
  field: LeadFieldName;
  value: string;
  /** 'pattern' = an e-mail guess from the contact's name and the site's domain (0028): never a fact, never sent unverified. */
  source: "import" | "site" | "places" | "ai" | "research" | "apify_maps" | "apollo" | "shovels" | "rapidapi_b2b" | "apify_contact" | "rapidapi_contact" | "pattern";
  source_ref: string | null;
  status: "unverified" | "confirmed" | "refuted";
  excerpt: string | null;
  seen_at: string;
};

export const LEAD_FIELD_COLUMNS = "id, lead_id, field, value, source, source_ref, status, excerpt, seen_at";

/** What the LEADS list shows for a lead: the best candidate's values, else the lead's own (imported) fields. */
export type LeadDisplay = { name: string; city: string | null; phone: string | null; website: string | null; email: string | null; companyType?: string | null };

/** A list (or import) a lead came from; `at` = ISO date the lead entered it. */
export type OriginList = { name: string; at: string; kind: "import" | "list" };

/** The research columns the leads table needs from the best candidate. */
export const TABLE_BEST_COLUMNS = [
  "id", "name", "temperature", "approach", "company_type", "total_value_usd", "biggest_job_value_usd", "biggest_job_type",
  "biggest_job_address", "permit_count", "entry_path", "second_pass",
] as const;
export type TableBest = Pick<CandidateRow, (typeof TABLE_BEST_COLUMNS)[number]>;

export type TableLead = Pick<LeadRow, "id" | "status" | "level" | "origin_kind" | "origin_agent_id" | "first_contacted_at" | "last_touch_at" | "segment">;

export type LeadTableRow = {
  lead: TableLead;
  best: TableBest | null;
  display: LeadDisplay;
  agentName: string | null;
  importName: string | null;
  emailQuality?: EmailQuality | null;
  ai?: Record<string, AiCell>;
  origins: OriginList[];
  /** The effective type: the manual one, else the derived one. */
  segment: Segment | null;
  profileMatch?: boolean;
};

export type LeadListItem = {
  lead: LeadRow;
  best: CandidateRow | null;
  display: LeadDisplay;
  agentName: string | null;
  importName: string | null;
  proofOk: number;
  /** The checked quality of display.email (0028 email_checks); absent = never checked. */
  emailQuality?: EmailQuality | null;
  /** AI-question answers of this lead, by question id (0029); absent = none loaded. */
  ai?: Record<string, AiCell>;
  /** It fits the approved profile's filter (qualifier_queue.profile_match, 0015); absent = not loaded. */
  profileMatch?: boolean;
};

export type LeadDetail = {
  lead: LeadRow;
  agentName: string | null;
  candidates: (CandidateRow & { run_title: string; run_created_at: string })[];
  checks: CheckWithEvidence[];
  fields: LeadFieldRow[];
  /** import id -> list name, for the imports the fields cite. */
  importNames: Record<string, string>;
  /** The Qualificador's queue row (sender only: null for the closer, whom RLS hides it from). */
  queue: { next_step: string; done_reason: string | null } | null;
};
