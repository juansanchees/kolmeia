// Lead vocabulary (migration 0009). Safe for client and server.
import type { CandidateRow } from "@/lib/research/rows";
import type { CheckWithEvidence } from "@/lib/research/store";
import type { AiCell } from "@/lib/ai-questions/types";
import type { EmailQuality } from "./email-quality";

export const LEAD_STATUSES = ["new", "call_list", "in_campaign", "replied", "with_closer", "meeting", "won", "lost", "discarded"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

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
};

export const LEAD_COLUMNS = "id, workspace_id, best_candidate_id, status, origin_kind, origin_agent_id, origin_run_id, origin_import_id, owner_id, first_seen_at, last_seen_at, level, level_note, handed_off_at, handed_off_by, closer_brief, do_not_call, do_not_call_at, first_contacted_at, last_touch_at";

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
  source: "import" | "site" | "places" | "ai" | "research" | "apify_maps" | "apollo" | "apify_contact" | "pattern";
  source_ref: string | null;
  status: "unverified" | "confirmed" | "refuted";
  excerpt: string | null;
  seen_at: string;
};

export const LEAD_FIELD_COLUMNS = "id, lead_id, field, value, source, source_ref, status, excerpt, seen_at";

/** What the LEADS list shows for a lead: the best candidate's values, else the lead's own (imported) fields. */
export type LeadDisplay = { name: string; city: string | null; phone: string | null; website: string | null; email: string | null; companyType?: string | null };

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
