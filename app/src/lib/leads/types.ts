// Lead vocabulary (migration 0009). Safe for client and server.
import type { CandidateRow } from "@/lib/research/rows";
import type { CheckWithEvidence } from "@/lib/research/store";

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
};

export const LEAD_COLUMNS = "id, workspace_id, best_candidate_id, status, origin_kind, origin_agent_id, origin_run_id, origin_import_id, owner_id, first_seen_at, last_seen_at, level, level_note";

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
  source: "import" | "site" | "places" | "ai" | "research";
  source_ref: string | null;
  status: "unverified" | "confirmed" | "refuted";
  excerpt: string | null;
  seen_at: string;
};

export const LEAD_FIELD_COLUMNS = "id, lead_id, field, value, source, source_ref, status, excerpt, seen_at";

/** What the LEADS list shows for a lead: the best candidate's values, else the lead's own (imported) fields. */
export type LeadDisplay = { name: string; city: string | null; phone: string | null; website: string | null; email: string | null };

export type LeadListItem = { lead: LeadRow; best: CandidateRow | null; display: LeadDisplay; agentName: string | null; importName: string | null; proofOk: number };

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
