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
  origin_kind: "agent" | "one_off";
  origin_agent_id: string | null;
  origin_run_id: string | null;
  owner_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
};

export const LEAD_COLUMNS = "id, workspace_id, best_candidate_id, status, origin_kind, origin_agent_id, origin_run_id, owner_id, first_seen_at, last_seen_at";

export type LeadListItem = { lead: LeadRow; best: CandidateRow; agentName: string | null; proofOk: number };

export type LeadDetail = {
  lead: LeadRow;
  agentName: string | null;
  candidates: (CandidateRow & { run_title: string; run_created_at: string })[];
  checks: CheckWithEvidence[];
};
