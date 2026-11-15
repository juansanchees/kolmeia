import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import type { ClockReply, ReplyMailbox, ReplyStore } from "./clock-replies";
import type { SentRef } from "./replies";
import type { SendCampaign, SendMailbox, SendMessage, SendProspect, SendStore } from "./store";
import type { ClaimResult, SenderProfile } from "./types";

// The scheduler's view of the database (E1). No user session: the public anon key plus the caller's token, forwarded as
// the request header x-scheduler-token and checked INSIDE the database (scheduler_authorized()). Everything goes
// through scheduler_* functions: this file never touches a table.
// Real mail (0025, D4): only a store built with real = true (the route, when the server switch is on) asks the database
// for real work, and the database answers only while the workspace's C12 gate is open and the stop is off. The mailbox
// ciphertext comes from scheduler_mailbox_secret, for the one message this run holds, and is held in memory only until
// the engine decrypts it (never logged, never returned to anyone).
// Replies (0026, E5): only a real store asks for reply mailboxes; the database lists a mailbox only behind the same locks
// and answers its secret, its sent references and the recording only for a mailbox listed in this run.
// Errors carry a short code only, never a database message (R10).

/** The database refused the token (clock off, wrong token). */
export class SchedulerAuthError extends Error {
  constructor() {
    super("scheduler_unauthorized");
    this.name = "SchedulerAuthError";
  }
}

export type TickStore = SendStore & {
  beginRun(): Promise<{ runId: string; busy: boolean }>;
  dueWork(runId: string): Promise<string[]>;
  finishRun(runId: string, counts: { campaigns: number; sent: number; failed: number }, error: string | null): Promise<void>;
};

export class SchedulerStore implements TickStore, ReplyStore {
  private run: string | null = null;
  /** The message this run claimed last (the only one whose mailbox may be read). */
  private claimed: string | null = null;
  /** Its workspace (from scheduler_message), to read the stop switch when the database refuses the mailbox. */
  private claimedWorkspace: string | null = null;
  /** The mailbox read for the claimed message (kept after finishSend: the engine reports a broken mailbox afterwards). */
  private lastMailbox: { messageId: string; mailboxId: string } | null = null;
  /** Ciphertext of the claimed message's mailbox, between getMailbox and getMailboxSecret. */
  private secret: { mailboxId: string; ciphertext: string } | null = null;
  /** Mailboxes the database listed for replies in this run (the only ones the reply calls may name). */
  private replyListed = new Set<string>();

  /** `real`: the server switch (realClockEnabled). False = rehearsal only, whatever the database would allow. */
  constructor(
    private readonly db: SupabaseClient,
    private readonly real = false,
  ) {}

  private async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T | null> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) {
      if (error.code === "42501") {
        // 0025: the token was fine but this mailbox may not be used now (gate, stop, holder, status): not an auth error
        if (/^mailbox not available/.test(error.message ?? "")) throw new Error("mailbox_refused");
        throw new SchedulerAuthError();
      }
      throw new Error(`rpc_${fn}`);
    }
    return (data as T | null) ?? null;
  }

  private runId(): string {
    if (!this.run) throw new Error("no_open_run");
    return this.run;
  }

  async beginRun(): Promise<{ runId: string; busy: boolean }> {
    const r = await this.rpc<{ run_id: string; busy: boolean }>("scheduler_begin_run");
    if (!r || typeof r.run_id !== "string") throw new Error("rpc_scheduler_begin_run");
    if (!r.busy) this.run = r.run_id;
    return { runId: r.run_id, busy: r.busy === true };
  }

  async dueWork(runId: string): Promise<string[]> {
    const r = await this.rpc<{ campaign_ids: string[] }>("scheduler_due_work", { p_run: runId, p_real: this.real });
    return Array.isArray(r?.campaign_ids) ? r.campaign_ids : [];
  }

  async finishRun(runId: string, counts: { campaigns: number; sent: number; failed: number }, error: string | null): Promise<void> {
    await this.rpc("scheduler_finish_run", { p_run: runId, p_counts: counts, p_error: error });
    if (this.run === runId) this.run = null;
    this.claimed = null;
    this.claimedWorkspace = null;
    this.secret = null;
    this.lastMailbox = null;
    this.replyListed.clear();
  }

  // ---- SendStore
  getSender(workspaceId: string): Promise<SenderProfile | null> {
    return this.rpc<SenderProfile>("scheduler_sender", { p_run: this.runId(), p_workspace: workspaceId });
  }
  getCampaign(campaignId: string): Promise<SendCampaign | null> {
    return this.rpc<SendCampaign>("scheduler_campaign", { p_run: this.runId(), p_campaign: campaignId });
  }
  getProspect(prospectId: string): Promise<SendProspect | null> {
    return this.rpc<SendProspect>("scheduler_prospect", { p_run: this.runId(), p_prospect: prospectId });
  }
  async getMessage(messageId: string): Promise<SendMessage | null> {
    const m = await this.rpc<SendMessage>("scheduler_message", { p_run: this.runId(), p_message: messageId });
    if (m && m.id === this.claimed) this.claimedWorkspace = m.workspace_id;
    return m;
  }
  async claimNext(campaignId: string, holder: string, messageId: string | null = null): Promise<ClaimResult> {
    if (messageId) throw new Error("replies_not_supported"); // answers to replies are a person's action
    if (holder !== this.runId()) throw new Error("holder_is_not_the_run");
    this.claimed = null;
    this.claimedWorkspace = null;
    this.secret = null;
    this.lastMailbox = null;
    const r = await this.rpc<ClaimResult>("scheduler_claim_next_email", { p_run: holder, p_campaign: campaignId, p_real: this.real });
    if (!r) throw new Error("rpc_scheduler_claim_next_email");
    if (r.outcome === "claimed" && r.message_id) this.claimed = r.message_id;
    return r;
  }
  async finishSend(messageId: string, holder: string, result: "sent" | "dry_run" | "failed", error: string | null): Promise<void> {
    if (holder !== this.runId()) throw new Error("holder_is_not_the_run");
    if (this.claimed === messageId) {
      this.claimed = null;
      this.claimedWorkspace = null;
      this.secret = null;
    }
    await this.rpc("scheduler_finish_email_send", { p_run: holder, p_message: messageId, p_result: result, p_error: error });
  }

  // ---- Real mail (0025): the mailbox of the one message this run claimed, only with the server switch on.
  async getMailbox(mailboxId: string): Promise<SendMailbox | null> {
    if (!this.real || !this.claimed) throw new Error("no_mailbox_access");
    let r: { id: string; workspace_id: string; email: string; ciphertext: string } | null;
    try {
      r = await this.rpc("scheduler_mailbox_secret", { p_run: this.runId(), p_message: this.claimed });
    } catch (e) {
      if (e instanceof SchedulerAuthError) throw e; // the token itself was refused: keep the 401 meaning
      // the database said no (gate, stop, mailbox, holder): a short code, nothing else; the stop keeps its own code so
      // the message stays retryable as 'sending_paused', like the engine's own re-check
      const ws = this.claimedWorkspace;
      throw new Error(ws && (await this.sendingPaused(ws)) ? "sending_paused" : "mailbox_refused");
    }
    if (!r || r.id !== mailboxId || typeof r.ciphertext !== "string") throw new Error("mailbox_refused");
    this.secret = { mailboxId: r.id, ciphertext: r.ciphertext };
    this.lastMailbox = { messageId: this.claimed, mailboxId: r.id };
    return { id: r.id, workspace_id: r.workspace_id, email: r.email };
  }
  async getMailboxSecret(mailboxId: string): Promise<string> {
    const s = this.secret;
    this.secret = null; // handed over once
    if (!this.real || !s || s.mailboxId !== mailboxId) throw new Error("no_mailbox_access");
    return s.ciphertext;
  }
  /**
   * The clock can only mark the mailbox of its last real message as broken (password refused, stored secret unreadable,
   * key missing),
   * so the next claims skip it; marking a mailbox good is a person's re-test.
   */
  async setMailboxVerified(mailboxId: string, ok: boolean, error: string | null): Promise<void> {
    const last = this.lastMailbox;
    if (ok || !this.real || !last || last.mailboxId !== mailboxId) throw new Error("no_mailbox_access");
    await this.rpc("scheduler_mailbox_failed", { p_run: this.runId(), p_message: last.messageId, p_code: error });
  }
  /** E4: the stop switch, read again right before SMTP. Unreadable = stopped (fail closed). */
  async sendingPaused(workspaceId: string): Promise<boolean> {
    try {
      return (await this.rpc<boolean>("scheduler_sending_paused", { p_run: this.runId(), p_workspace: workspaceId })) !== false;
    } catch {
      return true;
    }
  }

  // ---- Replies (0026, E5): real mode only; every call names a mailbox the database listed in this run.
  async replyMailboxes(): Promise<ReplyMailbox[]> {
    this.replyListed.clear();
    if (!this.real) return []; // rehearsal: the clock reads no mailbox, it does not even ask
    const r = await this.rpc<{ mailboxes: ReplyMailbox[] }>("scheduler_reply_mailboxes", { p_run: this.runId() });
    const list = Array.isArray(r?.mailboxes) ? r.mailboxes : [];
    for (const m of list) this.replyListed.add(m.id);
    return list;
  }
  private listedReply(mailboxId: string): void {
    if (!this.real || !this.replyListed.has(mailboxId)) throw new Error("no_mailbox_access");
  }
  async replyMailboxSecret(mailboxId: string): Promise<string> {
    this.listedReply(mailboxId);
    const r = await this.rpc<{ id: string; ciphertext: string }>("scheduler_imap_secret", { p_run: this.runId(), p_mailbox: mailboxId });
    if (!r || r.id !== mailboxId || typeof r.ciphertext !== "string") throw new Error("mailbox_refused");
    return r.ciphertext;
  }
  async replySentRefs(mailboxId: string, since: Date): Promise<SentRef[]> {
    this.listedReply(mailboxId);
    const r = await this.rpc<{ message_id: string; prospect_id: string; rfc_message_id: string; to_address: string; sent_at: string }[]>(
      "scheduler_reply_sent_refs",
      { p_run: this.runId(), p_mailbox: mailboxId, p_since: since.toISOString() },
    );
    return (Array.isArray(r) ? r : []).map((x) => ({ messageRowId: x.message_id, prospectId: x.prospect_id, rfcMessageId: x.rfc_message_id, toAddress: x.to_address, sentAt: x.sent_at }));
  }
  recordClockReply(r: ClockReply): Promise<string | null> {
    this.listedReply(r.mailboxId);
    return this.rpc<string>("scheduler_record_reply", {
      p_run: this.runId(),
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
      p_rule_class: r.ruleClass,
    });
  }
  /** A listed reply mailbox whose login failed: marked 'error' so the clock stops logging in (a person re-tests it). */
  async replyMailboxFailed(mailboxId: string, code: string): Promise<void> {
    this.listedReply(mailboxId);
    await this.rpc("scheduler_mailbox_failed", { p_run: this.runId(), p_message: null, p_code: code, p_mailbox: mailboxId });
  }
}

/** A store for one request: the anon key and the caller's token. Null when the database is not configured. */
export function createSchedulerStore(token: string, real = false): SchedulerStore | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-scheduler-token": token } },
  });
  return new SchedulerStore(db, real);
}
