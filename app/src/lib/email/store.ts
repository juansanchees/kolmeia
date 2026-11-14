// What the e-mail engine needs from the database. Production: SupabaseEmailStore (the logged-in user's session,
// RLS applies; rule R14). Tests: a SQL store over PGlite running as the `authenticated` role.
import type { AiLedger } from "@/lib/ai/gateway";
import type { ProfileInput } from "@/lib/ai/prompts/shared";
import type { SentRef } from "./replies";
import type {
  CampaignRow,
  ClaimResult,
  CloserBrief,
  IncomingKind,
  MailboxRow,
  MessageRow,
  ProspectRow,
  ReplyClass,
  ReplyRow,
  SenderProfile,
} from "./types";

export type NewMessage = {
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
  prompt_version: string | null;
  /** What the AI said it used (shown to the reviewer). */
  ai_facts?: string[];
  ai_no_fact?: boolean | null;
};

export type NewReply = {
  prospectId: string;
  mailboxId: string;
  messageRowId: string | null;
  from: string;
  subject: string;
  body: string;
  rfcMessageId: string;
  receivedAt: Date;
  kind: IncomingKind;
  bouncedAddress: string | null;
};

export type TestClaim = { outcome: "claimed" | "test_limit"; log_id?: string; wait_until?: string };

/** The columns of a campaign that the send path reads. */
export type SendCampaign = Pick<CampaignRow, "id" | "workspace_id" | "status" | "send_mode" | "mailbox_id">;
/** The columns of a mailbox that the send path reads (never the secret). */
export type SendMailbox = Pick<MailboxRow, "id" | "workspace_id" | "email">;
/** The columns of a prospect that building the outgoing message reads. */
export type SendProspect = Pick<ProspectRow, "id" | "unsub_token">;
/** The columns of a message that building the outgoing message reads. */
export type SendMessage = Pick<
  MessageRow,
  "id" | "workspace_id" | "campaign_id" | "prospect_id" | "kind" | "status" | "send_mode" | "from_address" | "to_address" | "subject" | "body" | "rfc_message_id" | "in_reply_to" | "mailbox_id"
>;

/**
 * The subset of the store that sendStep uses. EmailStore satisfies it (the logged-in user's path); the scheduler's
 * store (scheduler-store.ts) implements only this, through scheduler_* functions, and never reads a mailbox secret.
 */
export interface SendStore {
  getSender(workspaceId: string): Promise<SenderProfile | null>;
  getCampaign(campaignId: string): Promise<SendCampaign | null>;
  getMailbox(mailboxId: string): Promise<SendMailbox | null>;
  getMailboxSecret(mailboxId: string): Promise<string>;
  setMailboxVerified(mailboxId: string, ok: boolean, error: string | null): Promise<void>;
  getProspect(prospectId: string): Promise<SendProspect | null>;
  getMessage(messageId: string): Promise<SendMessage | null>;
  claimNext(campaignId: string, holder: string, messageId?: string | null): Promise<ClaimResult>;
  finishSend(messageId: string, holder: string, result: "sent" | "dry_run" | "failed", error: string | null): Promise<void>;
}

export interface EmailStore extends AiLedger {
  getSender(workspaceId: string): Promise<SenderProfile | null>;
  getProfile(workspaceId: string): Promise<ProfileInput>;
  getCampaign(campaignId: string): Promise<CampaignRow | null>;
  getMailbox(mailboxId: string): Promise<MailboxRow | null>;
  /** Ciphertext through mailbox_secret() (owners/SDRs only). Never selectable as a column. */
  getMailboxSecret(mailboxId: string): Promise<string>;
  setMailboxVerified(mailboxId: string, ok: boolean, error: string | null): Promise<void>;
  getProspect(prospectId: string): Promise<ProspectRow | null>;
  /** Active prospects with an address and no sequence message yet (oldest first). */
  prospectsToDraft(campaignId: string, limit: number): Promise<ProspectRow[]>;
  countProspectsToDraft(campaignId: string): Promise<number>;
  getMessage(messageId: string): Promise<MessageRow | null>;
  listProspectMessages(prospectId: string): Promise<MessageRow[]>;
  insertMessages(rows: NewMessage[]): Promise<void>;
  claimDraft(campaignId: string, holder: string, seconds: number): Promise<boolean>;
  releaseDraft(campaignId: string, holder: string): Promise<void>;
  /** One due message of the campaign, or (messageId) that one approved answer to a reply, whatever the campaign state. */
  claimNext(campaignId: string, holder: string, messageId?: string | null): Promise<ClaimResult>;
  finishSend(messageId: string, holder: string, result: "sent" | "dry_run" | "failed", error: string | null): Promise<void>;
  /** Our real sends from one address since a date (Message-IDs to match replies against). */
  sentRefs(workspaceId: string, fromAddress: string, since: Date): Promise<SentRef[]>;
  recordReply(r: NewReply): Promise<string | null>;
  getReply(replyId: string): Promise<ReplyRow | null>;
  unclassifiedReplies(workspaceId: string, limit: number): Promise<ReplyRow[]>;
  setReplyClass(replyId: string, cls: ReplyClass, source: "ai" | "human", reason: string | null, model: string | null): Promise<void>;
  handOff(prospectId: string): Promise<void>;
  /** Through save_closer_brief() (shape checked in SQL). */
  saveBrief(prospectId: string, brief: CloserBrief): Promise<void>;
  /** "Enviar teste para mim": logged under mode 'test', at most 5 per address per 24 h. */
  claimTest(mailboxId: string, to: string): Promise<TestClaim>;
  finishTest(logId: string, ok: boolean, error: string | null): Promise<void>;
  listProspectReplies(prospectId: string): Promise<ReplyRow[]>;
}
