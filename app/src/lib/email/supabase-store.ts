import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_DAILY_CAP_USD, type AiCallRecord, type AiReservation } from "@/lib/ai/gateway";
import { reserveAiCallRpc, settleAiCallRpc } from "@/lib/ai/ledger-rpc";
import type { ProfileInput } from "@/lib/ai/prompts/shared";
import type { SentRef } from "./replies";
import type { EmailStore, NewMessage, NewReply, TestClaim } from "./store";
import {
  CAMPAIGN_COLUMNS,
  MAILBOX_COLUMNS,
  MESSAGE_COLUMNS,
  PROSPECT_COLUMNS,
  REPLY_COLUMNS,
  type CampaignRow,
  type ClaimResult,
  type CloserBrief,
  type MailboxRow,
  type MessageRow,
  type ProspectRow,
  type ReplyClass,
  type ReplyRow,
  type SenderProfile,
} from "./types";

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Production store: every call runs with the logged-in user's session (cookie client), so RLS applies (R14). */
export class SupabaseEmailStore implements EmailStore {
  constructor(private readonly db: SupabaseClient) {}

  private fail(what: string, error: { message: string } | null): never {
    // Never include row data, addresses or secrets in the error (R10).
    throw new Error(`${what}: ${error?.message ?? "failed"}`);
  }

  async getSender(workspaceId: string): Promise<SenderProfile | null> {
    const { data, error } = await this.db.from("sender_profiles").select("legal_name, postal_address, sender_name").eq("workspace_id", workspaceId).maybeSingle();
    if (error) this.fail("getSender", error);
    return (data as SenderProfile | null) ?? null;
  }

  async getProfile(workspaceId: string): Promise<ProfileInput> {
    const { data, error } = await this.db
      .from("company_profiles")
      .select("what_we_do, service_area, wanted_work, good_customer, not_wanted")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (error) this.fail("getProfile", error);
    return (data as ProfileInput) ?? null;
  }

  async getCampaign(campaignId: string): Promise<CampaignRow | null> {
    const { data, error } = await this.db.from("email_campaigns").select(CAMPAIGN_COLUMNS).eq("id", campaignId).maybeSingle();
    if (error) this.fail("getCampaign", error);
    return (data as CampaignRow | null) ?? null;
  }

  async getMailbox(mailboxId: string): Promise<MailboxRow | null> {
    const { data, error } = await this.db.from("mailboxes").select(MAILBOX_COLUMNS).eq("id", mailboxId).maybeSingle();
    if (error) this.fail("getMailbox", error);
    return (data as MailboxRow | null) ?? null;
  }

  async getMailboxSecret(mailboxId: string): Promise<string> {
    const { data, error } = await this.db.rpc("mailbox_secret", { p_mailbox: mailboxId });
    if (error || typeof data !== "string") this.fail("getMailboxSecret", error);
    return data as string;
  }

  async setMailboxVerified(mailboxId: string, ok: boolean, err: string | null): Promise<void> {
    const { error } = await this.db.rpc("set_mailbox_verified", { p_mailbox: mailboxId, p_ok: ok, p_error: err });
    if (error) this.fail("setMailboxVerified", error);
  }

  async getProspect(prospectId: string): Promise<ProspectRow | null> {
    const { data, error } = await this.db.from("email_prospects").select(PROSPECT_COLUMNS).eq("id", prospectId).maybeSingle();
    if (error) this.fail("getProspect", error);
    return (data as ProspectRow | null) ?? null;
  }

  private async draftedIds(campaignId: string): Promise<Set<string>> {
    const { data, error } = await this.db.from("email_messages").select("prospect_id").eq("campaign_id", campaignId).eq("kind", "sequence");
    if (error) this.fail("draftedIds", error);
    return new Set((data ?? []).map((r) => (r as { prospect_id: string }).prospect_id));
  }

  private async draftable(campaignId: string): Promise<ProspectRow[]> {
    const [{ data, error }, drafted] = await Promise.all([
      this.db
        .from("email_prospects")
        .select(PROSPECT_COLUMNS)
        .eq("campaign_id", campaignId)
        .eq("status", "active")
        .not("email", "is", null)
        .order("created_at", { ascending: true }),
      this.draftedIds(campaignId),
    ]);
    if (error) this.fail("prospectsToDraft", error);
    return ((data ?? []) as ProspectRow[]).filter((p) => !drafted.has(p.id));
  }

  async prospectsToDraft(campaignId: string, limit: number): Promise<ProspectRow[]> {
    return (await this.draftable(campaignId)).slice(0, limit);
  }

  async countProspectsToDraft(campaignId: string): Promise<number> {
    return (await this.draftable(campaignId)).length;
  }

  async getMessage(messageId: string): Promise<MessageRow | null> {
    const { data, error } = await this.db.from("email_messages").select(MESSAGE_COLUMNS).eq("id", messageId).maybeSingle();
    if (error) this.fail("getMessage", error);
    return (data as MessageRow | null) ?? null;
  }

  async listProspectMessages(prospectId: string): Promise<MessageRow[]> {
    const { data, error } = await this.db.from("email_messages").select(MESSAGE_COLUMNS).eq("prospect_id", prospectId).order("created_at", { ascending: true });
    if (error) this.fail("listProspectMessages", error);
    return (data ?? []) as MessageRow[];
  }

  async insertMessages(rows: NewMessage[]): Promise<void> {
    if (!rows.length) return;
    const { error } = await this.db.from("email_messages").insert(rows);
    if (error) this.fail("insertMessages", error);
  }

  async claimDraft(campaignId: string, holder: string, seconds: number): Promise<boolean> {
    const { data, error } = await this.db.rpc("claim_campaign_draft", { p_campaign: campaignId, p_holder: holder, p_seconds: seconds });
    if (error) this.fail("claimDraft", error);
    return data === true;
  }

  async releaseDraft(campaignId: string, holder: string): Promise<void> {
    const { error } = await this.db.rpc("release_campaign_draft", { p_campaign: campaignId, p_holder: holder });
    if (error) this.fail("releaseDraft", error);
  }

  async claimNext(campaignId: string, holder: string, messageId: string | null = null): Promise<ClaimResult> {
    const { data, error } = await this.db.rpc("claim_next_email", { p_campaign: campaignId, p_holder: holder, p_message: messageId });
    if (error) this.fail("claimNext", error);
    return data as ClaimResult;
  }

  async finishSend(messageId: string, holder: string, result: "sent" | "dry_run" | "failed", err: string | null): Promise<void> {
    const { error } = await this.db.rpc("finish_email_send", { p_message: messageId, p_holder: holder, p_result: result, p_error: err });
    if (error) this.fail("finishSend", error);
  }

  async sentRefs(workspaceId: string, fromAddress: string, since: Date): Promise<SentRef[]> {
    const { data, error } = await this.db
      .from("email_messages")
      .select("id, prospect_id, rfc_message_id, to_address, sent_at")
      .eq("workspace_id", workspaceId)
      .eq("from_address", fromAddress)
      .eq("status", "sent")
      .gte("sent_at", since.toISOString())
      .not("rfc_message_id", "is", null)
      .limit(5000);
    if (error) this.fail("sentRefs", error);
    return ((data ?? []) as { id: string; prospect_id: string; rfc_message_id: string; to_address: string; sent_at: string }[]).map((r) => ({
      messageRowId: r.id,
      prospectId: r.prospect_id,
      rfcMessageId: r.rfc_message_id,
      toAddress: r.to_address,
      sentAt: r.sent_at,
    }));
  }

  async recordReply(r: NewReply): Promise<string | null> {
    const { data, error } = await this.db.rpc("record_email_reply", {
      p_prospect: r.prospectId,
      p_mailbox: r.mailboxId,
      p_message: r.messageRowId,
      p_from: r.from,
      p_subject: r.subject,
      p_body: r.body,
      p_rfc_id: r.rfcMessageId,
      p_received_at: r.receivedAt.toISOString(),
      p_kind: r.kind,
      p_bounced: r.bouncedAddress,
    });
    if (error) this.fail("recordReply", error);
    return (data as string | null) ?? null;
  }

  async getReply(replyId: string): Promise<ReplyRow | null> {
    const { data, error } = await this.db.from("email_replies").select(REPLY_COLUMNS).eq("id", replyId).maybeSingle();
    if (error) this.fail("getReply", error);
    return (data as ReplyRow | null) ?? null;
  }

  async unclassifiedReplies(workspaceId: string, limit: number): Promise<ReplyRow[]> {
    const { data, error } = await this.db
      .from("email_replies")
      .select(REPLY_COLUMNS)
      .eq("workspace_id", workspaceId)
      .eq("is_bounce", false)
      .eq("possible_bounce", false)
      .is("classification", null)
      .order("received_at", { ascending: true })
      .limit(limit);
    if (error) this.fail("unclassifiedReplies", error);
    return (data ?? []) as ReplyRow[];
  }

  async setReplyClass(replyId: string, cls: ReplyClass, source: "ai" | "human", reason: string | null, model: string | null): Promise<void> {
    const { error } = await this.db.rpc("set_reply_class", { p_reply: replyId, p_class: cls, p_source: source, p_reason: reason, p_model: model });
    if (error) this.fail("setReplyClass", error);
  }

  async handOff(prospectId: string): Promise<void> {
    const { error } = await this.db.rpc("hand_off_prospect", { p_prospect: prospectId });
    if (error) this.fail("handOff", error);
  }

  async saveBrief(prospectId: string, brief: CloserBrief): Promise<void> {
    const { error } = await this.db.rpc("save_closer_brief", { p_prospect: prospectId, p_brief: brief });
    if (error) this.fail("saveBrief", error);
  }

  async claimTest(mailboxId: string, to: string): Promise<TestClaim> {
    const { data, error } = await this.db.rpc("claim_test_email", { p_mailbox: mailboxId, p_to: to });
    if (error) this.fail("claimTest", error);
    return data as TestClaim;
  }

  async sendingPaused(workspaceId: string): Promise<boolean> {
    const { data, error } = await this.db.from("workspace_settings").select("sending_paused").eq("workspace_id", workspaceId).maybeSingle();
    if (error) return true; // fail closed: an unreadable switch never lets mail out
    return (data as { sending_paused: boolean } | null)?.sending_paused ?? false;
  }

  async finishTest(logId: string, ok: boolean, err: string | null): Promise<void> {
    const { error } = await this.db.rpc("finish_test_email", { p_log: logId, p_ok: ok, p_error: err });
    if (error) this.fail("finishTest", error);
  }

  async listProspectReplies(prospectId: string): Promise<ReplyRow[]> {
    const { data, error } = await this.db.from("email_replies").select(REPLY_COLUMNS).eq("prospect_id", prospectId).order("received_at", { ascending: true });
    if (error) this.fail("listProspectReplies", error);
    return (data ?? []) as ReplyRow[];
  }

  // ---------------------------------------------------------------- AiLedger
  async dailyCapUsd(workspaceId: string): Promise<number> {
    const { data, error } = await this.db.from("workspace_settings").select("ai_daily_cap_usd").eq("workspace_id", workspaceId).maybeSingle();
    if (error) this.fail("dailyCapUsd", error);
    return num(data?.ai_daily_cap_usd) ?? DEFAULT_DAILY_CAP_USD;
  }

  async spentTodayUsd(workspaceId: string): Promise<number> {
    const { data, error } = await this.db.rpc("ai_spend_today", { p_workspace: workspaceId });
    if (error) this.fail("spentTodayUsd", error);
    return num(data) ?? 0;
  }

  reserve(r: AiReservation): Promise<string> {
    return reserveAiCallRpc(this.db, r);
  }

  settle(id: string, row: AiCallRecord): Promise<void> {
    return settleAiCallRpc(this.db, id, row);
  }

  /** Legacy direct insert. After migration 0004 the database refuses it; kept for the AiLedger interface only. */
  async record(row: AiCallRecord): Promise<void> {
    const { error } = await this.db.from("ai_calls").insert({
      workspace_id: row.workspaceId,
      run_id: null,
      task: row.task,
      model: row.model,
      prompt_version: row.promptVersion,
      input_tokens: row.usage.inputTokens,
      output_tokens: row.usage.outputTokens,
      cache_read_tokens: row.usage.cacheReadTokens,
      cache_write_tokens: row.usage.cacheWriteTokens,
      web_searches: row.usage.webSearches,
      web_fetches: row.usage.webFetches,
      cost_usd: row.costUsd,
      status: row.status,
      error: row.error,
      duration_ms: row.durationMs,
    });
    if (error) this.fail("recordAiCall", error);
  }
}
