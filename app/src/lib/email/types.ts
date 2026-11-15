// Shapes of the E-mail area as stored in Postgres (migration 0003). Client-safe: no secrets here.

export const CAMPAIGN_STATUSES = ["draft", "active", "paused", "done", "archived"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const SEND_MODES = ["dry_run", "real"] as const;
export type SendMode = (typeof SEND_MODES)[number];

export const PROSPECT_STATUSES = ["active", "skipped", "replied", "stopped", "done", "handed_off"] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

export const MESSAGE_STATUSES = ["draft", "approved", "rejected", "sending", "sent", "dry_run", "failed", "cancelled"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const REPLY_CLASSES = ["interested", "not_now", "not_interested", "unsubscribe", "out_of_office", "wrong_person", "other"] as const;
export type ReplyClass = (typeof REPLY_CLASSES)[number];

export const SUPPRESSION_REASONS = ["unsubscribed", "bounced", "manual", "asked_to_stop"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export type MailboxStatus = "unverified" | "ok" | "error";

export type SenderProfile = { legal_name: string; postal_address: string; sender_name: string };

export type MailboxRow = {
  id: string;
  workspace_id: string;
  email: string;
  status: MailboxStatus;
  last_error: string | null;
  verified_at: string | null;
  daily_limit: number;
  created_at: string;
};
export const MAILBOX_COLUMNS = "id, workspace_id, email, status, last_error, verified_at, daily_limit, created_at";

export type CampaignRow = {
  id: string;
  workspace_id: string;
  list_id: string | null;
  name: string;
  status: CampaignStatus;
  send_mode: SendMode;
  mailbox_id: string | null;
  step2_delay_days: number;
  step3_delay_days: number;
  real_enabled_at: string | null;
  timezone: string;
  window_start: string;
  window_end: string;
  send_days: number[];
  daily_limit: number;
  min_gap_minutes: number;
  random_gap_minutes: number;
  created_at: string;
};
export const CAMPAIGN_COLUMNS =
  "id, workspace_id, list_id, name, status, send_mode, mailbox_id, step2_delay_days, step3_delay_days, real_enabled_at, created_at, timezone, window_start, window_end, send_days, daily_limit, min_gap_minutes, random_gap_minutes";

export type Evidence = { kind?: string; url: string; title: string; excerpt: string; seen_at?: string };

export type CloserBrief = { who: string; what_they_said: string; next_step: string; evidence_urls: string[]; model: string };

export type ProspectRow = {
  id: string;
  workspace_id: string;
  campaign_id: string;
  candidate_id: string | null;
  /** F4: the lead this prospect belongs to (from the candidate, or put into the campaign from LEADS). */
  lead_id: string | null;
  company_name: string;
  contact_name: string | null;
  contact_title: string | null;
  email: string | null;
  email_source: "research" | "manual" | "lead" | null;
  email_source_url: string | null;
  /** R18 for 'lead' addresses: "<lead_fields.source>:<source_ref or field id>". */
  email_source_ref: string | null;
  email_confirmed_by: string | null;
  /** E3: the mailbox this person stays on (set by the first claim); null until then. */
  mailbox_id: string | null;
  /** Address the research saw without an evidence excerpt that contains it: not sendable until a person confirms it (R18). */
  suggested_email: string | null;
  suggested_email_url: string | null;
  website: string | null;
  hook: string | null;
  evidence: Evidence[];
  status: ProspectStatus;
  stop_reason: string | null;
  unsub_token: string;
  replied_at: string | null;
  handed_off_at: string | null;
  handed_off_by: string | null;
  /** Stored jsonb: always read through parseCloserBrief() (brief.ts), never trusted as is. */
  closer_brief: unknown;
  closer_brief_at: string | null;
  created_at: string;
};
export const PROSPECT_COLUMNS =
  "id, workspace_id, campaign_id, candidate_id, lead_id, company_name, contact_name, contact_title, email, email_source, email_source_url, email_source_ref, email_confirmed_by, mailbox_id, suggested_email, suggested_email_url, website, hook, evidence, status, stop_reason, unsub_token, replied_at, handed_off_at, handed_off_by, closer_brief, closer_brief_at, created_at";

export type MessageRow = {
  id: string;
  workspace_id: string;
  campaign_id: string;
  prospect_id: string;
  kind: "sequence" | "reply";
  step: number | null;
  reply_to_id: string | null;
  subject: string;
  body: string;
  ai_drafted: boolean;
  ai_model: string | null;
  /** What the AI said it used (shown to the reviewer, never sent). */
  ai_facts: string[];
  ai_no_fact: boolean | null;
  human_edited: boolean;
  status: MessageStatus;
  approved_by: string | null;
  approved_at: string | null;
  /** The recipient address the person approved (R1). */
  approved_to: string | null;
  due_at: string | null;
  cancel_reason: string | null;
  /** The mailbox the claim recorded: the one this message leaves through (E3). Null until claimed. */
  mailbox_id: string | null;
  from_address: string | null;
  to_address: string | null;
  send_mode: SendMode | null;
  claimed_at: string | null;
  rfc_message_id: string | null;
  in_reply_to: string | null;
  sent_at: string | null;
  error: string | null;
  created_at: string;
  /** Version the screen sends back with an approval: a row changed since is skipped (R1). */
  updated_at: string;
};
export const MESSAGE_COLUMNS =
  "id, workspace_id, campaign_id, prospect_id, kind, step, reply_to_id, subject, body, ai_drafted, ai_model, ai_facts, ai_no_fact, human_edited, status, approved_by, approved_at, approved_to, due_at, cancel_reason, mailbox_id, from_address, to_address, send_mode, claimed_at, rfc_message_id, in_reply_to, sent_at, error, created_at, updated_at";

export type ReplyRow = {
  id: string;
  workspace_id: string;
  mailbox_id: string | null;
  campaign_id: string | null;
  prospect_id: string | null;
  message_id: string | null;
  from_address: string;
  subject: string;
  body_text: string;
  received_at: string;
  rfc_message_id: string;
  is_bounce: boolean;
  /** A delivery report that only names an address we mailed: a person confirms it or not. */
  possible_bounce: boolean;
  bounced_address: string | null;
  classification: ReplyClass | null;
  class_source: "ai" | "human" | null;
  class_reason: string | null;
  created_at: string;
};
export const REPLY_COLUMNS =
  "id, workspace_id, mailbox_id, campaign_id, prospect_id, message_id, from_address, subject, body_text, received_at, rfc_message_id, is_bounce, possible_bounce, bounced_address, classification, class_source, class_reason, created_at";

export type SuppressionRow = {
  id: string;
  kind: "address" | "domain";
  value: string;
  reason: SuppressionReason;
  note: string;
  created_at: string;
};

/** What claim_next_email() answers. */
export type ClaimOutcome =
  | "claimed"
  | "not_active"
  | "no_mailbox"
  | "mailbox_not_verified"
  | "no_sender_profile"
  | "daily_limit"
  | "gap"
  | "outside_window"
  | "campaign_limit"
  | "nothing_due";

export type ClaimResult = { outcome: ClaimOutcome; message_id?: string; wait_until?: string };

/** Outcome of approve / reject / unapprove (the approval RPC). */
export type ApprovalResult = { done: number; changed: number; skipped: number };

/** One message as the screen showed it: approvals refer to this exact version (R1). */
export type MessageVersion = { id: string; updatedAt: string };

/** How an incoming message was recognised (replies.ts -> record_email_reply). */
export type IncomingKind = "reply" | "bounce" | "possible_bounce";

/** Default sequence (business days after step 1); editable per campaign. */
export const DEFAULT_STEP_DELAYS = { step2: 3, step3: 7 } as const;
