import { aiCapErrorFrom } from "@/lib/ai/errors";
import type { AiCallRecord, AiReservation } from "@/lib/ai/gateway";
import { DEFAULT_DAILY_CAP_USD } from "@/lib/ai/gateway";
import type { ProfileInput } from "@/lib/ai/prompts/shared";
import type { SentRef } from "@/lib/email/replies";
import type { EmailStore, NewMessage, NewReply, TestClaim } from "@/lib/email/store";
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
} from "@/lib/email/types";
import { as, type TestDb } from "../db/helpers";

/** Dates as ISO strings, like PostgREST returns them. */
function iso<T>(row: Record<string, unknown>): T {
  for (const [k, v] of Object.entries(row)) if (v instanceof Date) row[k] = v.toISOString();
  return row as T;
}

/**
 * Test store: the same operations as SupabaseEmailStore, as SQL run as the `authenticated` role with the user's
 * JWT claim, so RLS, column grants, triggers and the definer functions apply as they would through PostgREST.
 */
export class SqlEmailStore implements EmailStore {
  constructor(
    private readonly db: TestDb,
    readonly userId: string,
  ) {}

  private q<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    return this.db.query<T>(as(this.userId), sql, params);
  }
  private async one<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.q(sql, params);
    return rows[0] ? iso<T>(rows[0]) : null;
  }
  private async many<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.q(sql, params)).map((r) => iso<T>(r));
  }

  getSender(ws: string) {
    return this.one<SenderProfile>("select legal_name, postal_address, sender_name from public.sender_profiles where workspace_id = $1", [ws]);
  }
  async getProfile(ws: string): Promise<ProfileInput> {
    return (await this.one<NonNullable<ProfileInput>>("select what_we_do, service_area, wanted_work, good_customer, not_wanted from public.company_profiles where workspace_id = $1", [ws])) ?? null;
  }
  getCampaign(id: string) {
    return this.one<CampaignRow>(`select ${CAMPAIGN_COLUMNS} from public.email_campaigns where id = $1`, [id]);
  }
  getMailbox(id: string) {
    return this.one<MailboxRow>(`select ${MAILBOX_COLUMNS} from public.mailboxes where id = $1`, [id]);
  }
  async getMailboxSecret(id: string): Promise<string> {
    return (await this.one<{ mailbox_secret: string }>("select public.mailbox_secret($1)", [id]))!.mailbox_secret;
  }
  async setMailboxVerified(id: string, ok: boolean, error: string | null) {
    await this.q("select public.set_mailbox_verified($1,$2,$3)", [id, ok, error]);
  }
  getProspect(id: string) {
    return this.one<ProspectRow>(`select ${PROSPECT_COLUMNS} from public.email_prospects where id = $1`, [id]);
  }
  prospectsToDraft(campaignId: string, limit: number) {
    return this.many<ProspectRow>(
      `select ${PROSPECT_COLUMNS} from public.email_prospects p
        where p.campaign_id = $1 and p.status = 'active' and p.email is not null
          and not exists (select 1 from public.email_messages m where m.prospect_id = p.id and m.kind = 'sequence')
        order by p.created_at limit $2`,
      [campaignId, limit],
    );
  }
  async countProspectsToDraft(campaignId: string) {
    return (await this.prospectsToDraft(campaignId, 10_000)).length;
  }
  getMessage(id: string) {
    return this.one<MessageRow>(`select ${MESSAGE_COLUMNS} from public.email_messages where id = $1`, [id]);
  }
  listProspectMessages(prospectId: string) {
    return this.many<MessageRow>(`select ${MESSAGE_COLUMNS} from public.email_messages where prospect_id = $1 order by created_at`, [prospectId]);
  }
  async insertMessages(rows: NewMessage[]) {
    for (const r of rows) {
      await this.q(
        `insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, reply_to_id, subject, body, ai_drafted, ai_model, prompt_version, ai_facts, ai_no_fact)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
        [r.workspace_id, r.campaign_id, r.prospect_id, r.kind, r.step, r.reply_to_id, r.subject, r.body, r.ai_drafted, r.ai_model, r.prompt_version, JSON.stringify(r.ai_facts ?? []), r.ai_no_fact ?? null],
      );
    }
  }
  async claimDraft(campaignId: string, holder: string, seconds: number) {
    return (await this.one<{ ok: boolean }>("select public.claim_campaign_draft($1,$2,$3) as ok", [campaignId, holder, seconds]))!.ok;
  }
  async releaseDraft(campaignId: string, holder: string) {
    await this.q("select public.release_campaign_draft($1,$2)", [campaignId, holder]);
  }
  async claimNext(campaignId: string, holder: string, messageId: string | null = null): Promise<ClaimResult> {
    return (await this.one<{ r: ClaimResult }>("select public.claim_next_email($1,$2,$3) as r", [campaignId, holder, messageId]))!.r;
  }
  async finishSend(messageId: string, holder: string, result: "sent" | "dry_run" | "failed", error: string | null) {
    await this.q("select public.finish_email_send($1,$2,$3,$4)", [messageId, holder, result, error]);
  }
  async sentRefs(ws: string, fromAddress: string, since: Date): Promise<SentRef[]> {
    const rows = await this.many<{ id: string; prospect_id: string; rfc_message_id: string; to_address: string; sent_at: string }>(
      "select id, prospect_id, rfc_message_id, to_address, sent_at from public.email_messages where workspace_id = $1 and from_address = $2 and status = 'sent' and sent_at >= $3 and rfc_message_id is not null",
      [ws, fromAddress, since.toISOString()],
    );
    return rows.map((r) => ({ messageRowId: r.id, prospectId: r.prospect_id, rfcMessageId: r.rfc_message_id, toAddress: r.to_address, sentAt: r.sent_at }));
  }
  async recordReply(r: NewReply) {
    const row = await this.one<{ id: string | null }>("select public.record_email_reply($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as id", [
      r.prospectId,
      r.mailboxId,
      r.messageRowId,
      r.from,
      r.subject,
      r.body,
      r.rfcMessageId,
      r.receivedAt.toISOString(),
      r.kind,
      r.bouncedAddress,
    ]);
    return row?.id ?? null;
  }
  getReply(id: string) {
    return this.one<ReplyRow>(`select ${REPLY_COLUMNS} from public.email_replies where id = $1`, [id]);
  }
  unclassifiedReplies(ws: string, limit: number) {
    return this.many<ReplyRow>(`select ${REPLY_COLUMNS} from public.email_replies where workspace_id = $1 and not is_bounce and not possible_bounce and classification is null order by received_at limit $2`, [ws, limit]);
  }
  async setReplyClass(id: string, cls: ReplyClass, source: "ai" | "human", reason: string | null, model: string | null) {
    await this.q("select public.set_reply_class($1,$2,$3,$4,$5)", [id, cls, source, reason, model]);
  }
  async handOff(prospectId: string) {
    await this.q("select public.hand_off_prospect($1)", [prospectId]);
  }
  async saveBrief(prospectId: string, brief: CloserBrief) {
    await this.q("select public.save_closer_brief($1, $2::jsonb)", [prospectId, JSON.stringify(brief)]);
  }
  async claimTest(mailboxId: string, to: string): Promise<TestClaim> {
    return (await this.one<{ r: TestClaim }>("select public.claim_test_email($1,$2) as r", [mailboxId, to]))!.r;
  }
  async sendingPaused(ws: string) {
    return (await this.one<{ sending_paused: boolean }>("select sending_paused from public.workspace_settings where workspace_id = $1", [ws]))?.sending_paused ?? false;
  }
  async finishTest(logId: string, ok: boolean, error: string | null) {
    await this.q("select public.finish_test_email($1,$2,$3)", [logId, ok, error]);
  }
  listProspectReplies(prospectId: string) {
    return this.many<ReplyRow>(`select ${REPLY_COLUMNS} from public.email_replies where prospect_id = $1 order by received_at`, [prospectId]);
  }

  // AiLedger
  async dailyCapUsd(ws: string) {
    const r = await this.one<{ ai_daily_cap_usd: string }>("select ai_daily_cap_usd from public.workspace_settings where workspace_id = $1", [ws]);
    return r ? Number(r.ai_daily_cap_usd) : DEFAULT_DAILY_CAP_USD;
  }
  async spentTodayUsd(ws: string) {
    return Number((await this.one<{ s: string }>("select public.ai_spend_today($1) as s", [ws]))!.s);
  }
  async reserve(r: AiReservation): Promise<string> {
    try {
      const row = await this.one<{ id: string }>("select public.reserve_ai_call($1,$2,$3,$4,$5,$6,$7,$8) as id", [
        r.workspaceId, r.runId, r.task, r.model, r.promptVersion, r.reserveUsd, r.userDailyCapUsd, r.globalDailyCapUsd,
      ]);
      return row!.id;
    } catch (e) {
      throw aiCapErrorFrom((e as Error).message) ?? e;
    }
  }
  async settle(id: string, row: AiCallRecord): Promise<void> {
    await this.q("select public.settle_ai_call($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [
      id, row.status, row.usage.inputTokens, row.usage.outputTokens, row.usage.cacheReadTokens, row.usage.cacheWriteTokens,
      row.usage.webSearches, row.usage.webFetches, row.costUsd, row.error, row.durationMs,
    ]);
  }
  /** Legacy direct insert: refused by the database after 0004 (kept for the AiLedger interface). */
  async record(row: AiCallRecord) {
    await this.q(
      `insert into public.ai_calls (workspace_id, run_id, task, model, prompt_version, input_tokens, output_tokens, cost_usd, status, error, duration_ms)
       values ($1,null,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [row.workspaceId, row.task, row.model, row.promptVersion, row.usage.inputTokens, row.usage.outputTokens, row.costUsd, row.status, row.error, row.durationMs],
    );
  }
}
