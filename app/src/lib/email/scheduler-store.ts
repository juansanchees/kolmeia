import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import type { SendCampaign, SendMailbox, SendMessage, SendProspect, SendStore } from "./store";
import type { ClaimResult, SenderProfile } from "./types";

// The scheduler's view of the database (E1). No user session: the public anon key plus the caller's token, forwarded as
// the request header x-scheduler-token and checked INSIDE the database (scheduler_authorized()). Everything goes
// through scheduler_* functions: this file never touches a table and never reads a mailbox secret.
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

export class SchedulerStore implements TickStore {
  private run: string | null = null;

  constructor(private readonly db: SupabaseClient) {}

  private async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T | null> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) {
      if (error.code === "42501") throw new SchedulerAuthError();
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
    const r = await this.rpc<{ campaign_ids: string[] }>("scheduler_due_work", { p_run: runId });
    return Array.isArray(r?.campaign_ids) ? r.campaign_ids : [];
  }

  async finishRun(runId: string, counts: { campaigns: number; sent: number; failed: number }, error: string | null): Promise<void> {
    await this.rpc("scheduler_finish_run", { p_run: runId, p_counts: counts, p_error: error });
    if (this.run === runId) this.run = null;
  }

  // ---- SendStore (only what a rehearsal send reads)
  getSender(workspaceId: string): Promise<SenderProfile | null> {
    return this.rpc<SenderProfile>("scheduler_sender", { p_run: this.runId(), p_workspace: workspaceId });
  }
  getCampaign(campaignId: string): Promise<SendCampaign | null> {
    return this.rpc<SendCampaign>("scheduler_campaign", { p_run: this.runId(), p_campaign: campaignId });
  }
  getProspect(prospectId: string): Promise<SendProspect | null> {
    return this.rpc<SendProspect>("scheduler_prospect", { p_run: this.runId(), p_prospect: prospectId });
  }
  getMessage(messageId: string): Promise<SendMessage | null> {
    return this.rpc<SendMessage>("scheduler_message", { p_run: this.runId(), p_message: messageId });
  }
  async claimNext(campaignId: string, holder: string, messageId: string | null = null): Promise<ClaimResult> {
    if (messageId) throw new Error("replies_not_supported"); // answers to replies are a person's action
    if (holder !== this.runId()) throw new Error("holder_is_not_the_run");
    const r = await this.rpc<ClaimResult>("scheduler_claim_next_email", { p_run: holder, p_campaign: campaignId });
    if (!r) throw new Error("rpc_scheduler_claim_next_email");
    return r;
  }
  async finishSend(messageId: string, holder: string, result: "sent" | "dry_run" | "failed", error: string | null): Promise<void> {
    if (holder !== this.runId()) throw new Error("holder_is_not_the_run");
    await this.rpc("scheduler_finish_email_send", { p_run: holder, p_message: messageId, p_result: result, p_error: error });
  }

  // ---- Real mail is impossible on this path: there is no mailbox access at all.
  async getMailbox(): Promise<SendMailbox | null> {
    throw new Error("no_mailbox_access");
  }
  async getMailboxSecret(): Promise<string> {
    throw new Error("no_mailbox_access");
  }
  async setMailboxVerified(): Promise<void> {
    throw new Error("no_mailbox_access");
  }
  // E4: read only on the real path, which this store cannot reach (a real clock must implement it; fail closed).
  async sendingPaused(): Promise<boolean> {
    throw new Error("no_mailbox_access");
  }
}

/** A store for one request: the anon key and the caller's token. Null when the database is not configured. */
export function createSchedulerStore(token: string): SchedulerStore | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-scheduler-token": token } },
  });
  return new SchedulerStore(db);
}
