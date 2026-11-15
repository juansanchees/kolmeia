import "server-only";
import { draftReply, draftSequence, classifyReply, writeCloserBrief, type DraftedEmail } from "@/lib/ai/email-tasks";
import { isAiError, STOP_CODES, type AiErrorCode } from "@/lib/ai/errors";
import type { AiTransport } from "@/lib/ai/types";
import { ComposeError, composeEmail, replySubject, senderComplete, unsubscribeOrigin, unsubscribeUrls, type OutgoingEmail } from "./compose";
import type { MailboxKeyRing } from "./config";
import { decryptSecret, mailboxAad } from "./crypto";
import { matchIncoming, isAutoReply } from "./replies";
import type { EmailStore, NewMessage, SendCampaign, SendStore } from "./store";
import { mailErrorText, type ImapTransport, type MailCreds, type SmtpTransport } from "./transport";
import { DEFAULT_STEP_DELAYS, type ClaimOutcome, type MailboxRow, type ReplyRow } from "./types";

// The e-mail engine. No background worker inside the app: the open page calls one bounded step at a time
// (drafting a couple of prospects, or sending at most ONE message), like the research engine. Every database
// write goes through the logged-in user's session (R14); the rules R1-R4 are enforced again inside the
// database functions this calls (claim_next_email, finish_email_send, ...).
// The one clock is outside: an external scheduler (pg_cron) calls /api/scheduler/tick, which runs sendStep for
// rehearsal (dry_run) campaigns only, with a transport that cannot send (scheduler.ts, scheduler-store.ts; E1).

export type EmailDeps = {
  store: EmailStore;
  ai: AiTransport | null;
  smtp: SmtpTransport;
  imap: ImapTransport;
  /** Encryption key(s) for mailbox secrets; tests pass one, production reads the configured keys lazily (config.ts). */
  key?: Buffer | MailboxKeyRing;
};

/**
 * Where unsubscribe links point. publicOrigin = APP_PUBLIC_ORIGIN (server-only env): the only origin real mail
 * may use (https, not localhost). requestOrigin: fallback for rehearsal and previews only.
 */
export type Origins = { publicOrigin: string | null; requestOrigin: string | null };

/** SMTP problems that make every next send fail too: the loop stops and the mailbox is marked for a re-test. */
const MAILBOX_STOP = new Set(["auth_failed", "mailbox_secret", "key_missing"]);

/** A step must finish well inside the route's maxDuration. */
export const DRAFT_BATCH = 2;
export const DRAFT_LEASE_SECONDS = 200;

/** Codes that stop spending until a person acts (no_access, daily/user/global cap, run_time included). */
const AI_STOP: ReadonlySet<AiErrorCode> = STOP_CODES;

/** What sendStep needs: the send subset of the store and the SMTP transport (the scheduler passes one that always throws). */
export type SendDeps = { store: SendStore; smtp: SmtpTransport; key?: Buffer | MailboxKeyRing };

async function creds(deps: Pick<SendDeps, "store" | "key">, mailbox: Pick<MailboxRow, "id" | "workspace_id" | "email">): Promise<MailCreds> {
  const stored = await deps.store.getMailboxSecret(mailbox.id);
  const pass = decryptSecret(stored, mailboxAad(mailbox.workspace_id, mailbox.email), deps.key ?? undefined);
  return { user: mailbox.email, pass };
}

// ---------------------------------------------------------------- fallback text when the AI left a step out
// Generic and honest (no claims). Marked ai_drafted = false; a human reviews it like any draft.
function fallbackStep(step: 1 | 2 | 3, company: string, senderFirst: string): DraftedEmail {
  if (step === 1) {
    return { step, subject: `HVAC for ${company}`.slice(0, 120), body: `Hi there,\n\nI run HVAC installs and service for builders and property managers in the area. Who at ${company} handles HVAC for your projects?\n\nThanks,\n${senderFirst}` };
  }
  return step === 2
    ? { step, subject: `Following up, ${company}`.slice(0, 120), body: `Hi there,\n\nJust following up on my note from last week. Is there someone at ${company} who handles HVAC for your projects?\n\nThanks,\n${senderFirst}` }
    : { step, subject: "Should I close the loop?", body: `Hi there,\n\nI don't want to crowd your inbox. If HVAC help isn't useful right now, just say "not now" and I'll leave it there.\n\nBest,\n${senderFirst}` };
}

/** Template drafts (no AI) for prospects that still need them: honest, generic, edited by a person before approval. */
export async function templateDrafts(deps: Pick<EmailDeps, "store">, campaignId: string, workspaceName: string, limit = 200): Promise<number> {
  const campaign = await deps.store.getCampaign(campaignId);
  if (!campaign) return 0;
  const [sender, prospects] = await Promise.all([deps.store.getSender(campaign.workspace_id), deps.store.prospectsToDraft(campaignId, limit)]);
  const senderName = sender?.sender_name.trim() || workspaceName;
  const senderFirst = senderName.split(/\s+/)[0] || senderName;
  for (const p of prospects) {
    await deps.store.insertMessages(
      ([1, 2, 3] as const).map((step) => {
        const e = fallbackStep(step, p.company_name, senderFirst);
        return { workspace_id: campaign.workspace_id, campaign_id: campaignId, prospect_id: p.id, kind: "sequence" as const, step, reply_to_id: null, subject: e.subject, body: e.body, ai_drafted: false, ai_model: null, prompt_version: null };
      }),
    );
  }
  return prospects.length;
}

// ---------------------------------------------------------------- 1. drafting (step-driven)
export type DraftStepResult =
  | { kind: "not_found" }
  | { kind: "busy" }
  | { kind: "drafted"; drafted: number; remaining: number }
  | { kind: "ai_error"; code: AiErrorCode; remaining: number; stop: boolean };

export async function draftStep(deps: EmailDeps, campaignId: string, holder: string, workspaceName: string): Promise<DraftStepResult> {
  const campaign = await deps.store.getCampaign(campaignId);
  if (!campaign) return { kind: "not_found" };
  if (!(await deps.store.claimDraft(campaignId, holder, DRAFT_LEASE_SECONDS))) return { kind: "busy" };
  try {
    const [sender, profile, prospects] = await Promise.all([
      deps.store.getSender(campaign.workspace_id),
      deps.store.getProfile(campaign.workspace_id),
      deps.store.prospectsToDraft(campaignId, DRAFT_BATCH),
    ]);
    const senderName = sender?.sender_name.trim() || workspaceName;
    const senderFirst = senderName.split(/\s+/)[0] || senderName;
    let drafted = 0;
    for (const p of prospects) {
      let rows: NewMessage[];
      try {
        const res = await draftSequence(
          { workspaceId: campaign.workspace_id, runId: null, ledger: deps.store, transport: deps.ai },
          {
            workspaceName,
            senderName,
            profile,
            prospect: {
              company: p.company_name,
              contactName: p.contact_name,
              contactTitle: p.contact_title,
              hook: p.hook,
              evidence: (p.evidence ?? []).map((e) => ({ url: e.url, title: e.title, excerpt: e.excerpt })),
            },
            delays: { step2: campaign.step2_delay_days ?? DEFAULT_STEP_DELAYS.step2, step3: campaign.step3_delay_days ?? DEFAULT_STEP_DELAYS.step3 },
          },
        );
        const byStep = new Map(res.data.emails.map((e) => [e.step, e]));
        if (!byStep.has(1)) throw Object.assign(new Error("no step 1"), { aiCode: "invalid_output" as const });
        rows = ([1, 2, 3] as const).map((step) => {
          const ai = byStep.get(step);
          const e = ai ?? fallbackStep(step as 2 | 3, p.company_name, senderFirst);
          return {
            workspace_id: campaign.workspace_id,
            campaign_id: campaignId,
            prospect_id: p.id,
            kind: "sequence" as const,
            step,
            reply_to_id: null,
            subject: e.subject,
            body: e.body,
            ai_drafted: Boolean(ai),
            ai_model: ai ? res.data.model : null,
            prompt_version: ai ? res.data.promptVersion : null,
            // shown to the reviewer next to the evidence links ("Fatos usados pela IA" / "sem fato específico")
            ai_facts: ai ? res.data.factsUsed : [],
            ai_no_fact: ai ? res.data.noFact : null,
          };
        });
      } catch (e) {
        const code: AiErrorCode = isAiError(e) ? e.code : "invalid_output";
        const remaining = await deps.store.countProspectsToDraft(campaignId);
        return { kind: "ai_error", code, remaining, stop: AI_STOP.has(code) };
      }
      await deps.store.insertMessages(rows);
      drafted++;
    }
    return { kind: "drafted", drafted, remaining: await deps.store.countProspectsToDraft(campaignId) };
  } finally {
    await deps.store.releaseDraft(campaignId, holder).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- 2. sending (one message per call)
/** E4 (0024): the emergency stop's outcome / error code. */
const SENDING_PAUSED = "sending_paused" as const;
export type SendStepResult = {
  outcome: ClaimOutcome | "sent" | "dry_run" | "failed" | "not_found" | "no_public_origin";
  messageId?: string;
  waitUntil?: string;
  error?: string;
  /** The mailbox itself failed (password refused / unreadable): the loop stops instead of failing every message. */
  stop?: boolean;
};

/** Builds the exact outgoing message for a claimed (or previewed) message. */
export async function buildOutgoing(
  deps: { store: Pick<SendStore, "getMessage" | "getProspect" | "getSender"> },
  campaign: Pick<SendCampaign, "workspace_id">,
  messageId: string,
  origin: string,
  strictOrigin = false,
): Promise<OutgoingEmail> {
  const message = await deps.store.getMessage(messageId);
  if (!message) throw new ComposeError("address");
  const [prospect, sender] = await Promise.all([deps.store.getProspect(message.prospect_id), deps.store.getSender(campaign.workspace_id)]);
  if (!prospect || !sender) throw new ComposeError("sender_incomplete");
  return composeEmail({
    kind: message.kind,
    sender,
    fromAddress: message.from_address ?? "",
    // only the address stamped at claim time (= the address a person signed off, R1); never a fallback
    to: message.to_address ?? "",
    subject: message.subject,
    body: message.body,
    unsubscribe: unsubscribeUrls(origin, prospect.unsub_token),
    messageId: message.rfc_message_id ?? "",
    inReplyTo: message.in_reply_to,
    strictOrigin,
  });
}

/**
 * Sends at most ONE message: the next due one of the campaign, or (opts.messageId) one human-cleared answer to a reply.
 * Real mail is refused before any claim when APP_PUBLIC_ORIGIN is not a public https origin.
 */
export async function sendStep(
  deps: SendDeps,
  campaignId: string,
  holder: string,
  origins: Origins,
  opts: { messageId?: string } = {},
): Promise<SendStepResult> {
  const campaign = await deps.store.getCampaign(campaignId);
  if (!campaign) return { outcome: "not_found" };
  if (campaign.send_mode === "real" && !unsubscribeOrigin(true, origins.publicOrigin, origins.requestOrigin)) return { outcome: "no_public_origin" };
  const claim = await deps.store.claimNext(campaignId, holder, opts.messageId ?? null);
  if (claim.outcome !== "claimed" || !claim.message_id) return { outcome: claim.outcome, waitUntil: claim.wait_until };
  const messageId = claim.message_id;

  const claimed = await deps.store.getMessage(messageId);
  const real = claimed?.send_mode === "real";
  const origin = unsubscribeOrigin(real, origins.publicOrigin, origins.requestOrigin);
  let mail: OutgoingEmail;
  try {
    if (!origin) throw new ComposeError("unsubscribe_url");
    mail = await buildOutgoing(deps, campaign, messageId, origin, real);
  } catch (e) {
    const code = e instanceof ComposeError ? `compose:${e.code}` : "compose";
    await deps.store.finishSend(messageId, holder, "failed", code);
    return { outcome: "failed", messageId, error: code };
  }

  if (!real) {
    // Rehearsal (ensaio): the whole path ran (claim, limits, suppression, footer); no SMTP connection is opened.
    await deps.store.finishSend(messageId, holder, "dry_run", null);
    return { outcome: "dry_run", messageId };
  }

  // E3: the mailbox is the one the claim recorded on this message (a person stays on one mailbox), never campaign.mailbox_id.
  // No mailbox on the message, or one that cannot be loaded: the send fails closed, it never leaves from another address.
  const mailboxId = claimed?.mailbox_id ?? null;
  try {
    const mailbox = mailboxId ? await deps.store.getMailbox(mailboxId) : null;
    if (!mailbox) throw new Error("mailbox_gone");
    // the From was composed from the message; it must be the address of the mailbox whose credentials are about to be used
    if (mail.from.address.toLowerCase() !== mailbox.email.toLowerCase()) throw new Error("from_mismatch");
    // E4: someone may have pressed "Parar todos os envios" after this claim; nothing leaves while it is on
    if (await deps.store.sendingPaused(campaign.workspace_id)) throw new Error(SENDING_PAUSED);
    await deps.smtp.send(await creds(deps, mailbox), mail);
  } catch (e) {
    const err = e instanceof Error && e.message === SENDING_PAUSED ? SENDING_PAUSED : mailErrorText(e);
    if (err === SENDING_PAUSED) {
      // not sent: failed and retryable by a person (retry_failed_email), like an SMTP error before the send
      await deps.store.finishSend(messageId, holder, "failed", SENDING_PAUSED);
      return { outcome: SENDING_PAUSED, messageId };
    }
    await deps.store.finishSend(messageId, holder, "failed", err);
    if (MAILBOX_STOP.has(err)) {
      if (mailboxId) await deps.store.setMailboxVerified(mailboxId, false, err).catch(() => undefined);
      return { outcome: "failed", messageId, error: err, stop: true };
    }
    return { outcome: "failed", messageId, error: err };
  }
  await deps.store.finishSend(messageId, holder, "sent", null);
  return { outcome: "sent", messageId };
}

/** "Enviar resposta": one human-cleared answer to a reply, whatever the campaign state (still R1-R4 and the mode). */
export async function sendReplyAnswer(deps: EmailDeps, messageId: string, holder: string, origins: Origins): Promise<SendStepResult> {
  const message = await deps.store.getMessage(messageId);
  if (!message || message.kind !== "reply") return { outcome: "not_found" };
  return sendStep(deps, message.campaign_id, holder, origins, { messageId });
}

// ---------------------------------------------------------------- 3. mailbox check and test message
export async function verifyMailbox(deps: EmailDeps, mailboxId: string): Promise<{ ok: boolean; error: string | null }> {
  const mailbox = await deps.store.getMailbox(mailboxId);
  if (!mailbox) return { ok: false, error: "not_found" };
  try {
    await deps.smtp.verify(await creds(deps, mailbox));
  } catch (e) {
    const err = mailErrorText(e);
    await deps.store.setMailboxVerified(mailboxId, false, err);
    return { ok: false, error: err };
  }
  await deps.store.setMailboxVerified(mailboxId, true, null);
  return { ok: true, error: null };
}

/**
 * One real message to the logged-in user's own account address (taken from the session, never typed), with the
 * real footer, so they see exactly what prospects will get. Logged under its own mode ('test'), at most 5 per
 * address per 24 h; not counted in the prospect limit. Needs APP_PUBLIC_ORIGIN like any real mail.
 */
export async function sendTestToSelf(
  deps: EmailDeps,
  mailboxId: string,
  selfAddress: string,
  workspaceName: string,
  origins: Origins,
): Promise<{ ok: boolean; error: string | null; waitUntil?: string }> {
  const mailbox = await deps.store.getMailbox(mailboxId);
  if (!mailbox) return { ok: false, error: "not_found" };
  const sender = await deps.store.getSender(mailbox.workspace_id);
  if (!senderComplete(sender)) return { ok: false, error: "sender_incomplete" };
  const origin = unsubscribeOrigin(true, origins.publicOrigin, origins.requestOrigin);
  if (!origin) return { ok: false, error: "no_public_origin" };
  let mail: OutgoingEmail;
  try {
    mail = composeEmail({
      kind: "sequence",
      sender,
      fromAddress: mailbox.email,
      to: selfAddress,
      subject: `Test message from ${workspaceName}`.slice(0, 120),
      body: `This is a test sent from your prospecting tool to your own address.\nThe text below the line is the footer every prospect will see.\n\n${sender.sender_name}`,
      unsubscribe: unsubscribeUrls(origin, "0".repeat(64)),
      messageId: `<test-${crypto.randomUUID().replace(/-/g, "")}@${mailbox.email.split("@")[1]}>`,
      strictOrigin: true,
    });
  } catch (e) {
    return { ok: false, error: e instanceof ComposeError ? e.code : "compose" };
  }
  const claim = await deps.store.claimTest(mailboxId, selfAddress);
  if (claim.outcome !== "claimed" || !claim.log_id) return { ok: false, error: claim.outcome === "claimed" ? "test_limit" : claim.outcome, waitUntil: claim.wait_until };
  // E4: stop pressed right after the claim
  if (await deps.store.sendingPaused(mailbox.workspace_id).catch(() => true)) {
    await deps.store.finishTest(claim.log_id, false, SENDING_PAUSED).catch(() => undefined);
    return { ok: false, error: SENDING_PAUSED };
  }
  try {
    await deps.smtp.send(await creds(deps, mailbox), mail);
  } catch (e) {
    const err = mailErrorText(e);
    await deps.store.finishTest(claim.log_id, false, err).catch(() => undefined);
    return { ok: false, error: err };
  }
  await deps.store.finishTest(claim.log_id, true, null);
  return { ok: true, error: null };
}

// ---------------------------------------------------------------- 4. replies (on demand)
export const REPLY_WINDOW_DAYS = 30;
export const FETCH_MAX = 150;
export const CLASSIFY_PER_CALL = 8;

export type FetchRepliesResult = {
  fetched: number;
  matched: number;
  stored: number;
  bounces: number;
  /** delivery reports that only name an address we mailed: a person confirms them in Respostas */
  possibleBounces: number;
  classified: number;
  aiProblem: AiErrorCode | null;
};

export async function fetchReplies(deps: EmailDeps, mailboxId: string, now = new Date()): Promise<FetchRepliesResult> {
  const mailbox = await deps.store.getMailbox(mailboxId);
  if (!mailbox) throw new Error("mailbox not found");
  const since = new Date(now.getTime() - REPLY_WINDOW_DAYS * 86_400_000);
  const [sent, incoming] = await Promise.all([
    deps.store.sentRefs(mailbox.workspace_id, mailbox.email, since),
    creds(deps, mailbox).then((c) => deps.imap.fetchSince(c, since, FETCH_MAX)),
  ]);
  let matched = 0;
  let stored = 0;
  let bounces = 0;
  let possibleBounces = 0;
  for (const inc of incoming) {
    if (!inc.messageId || inc.from === mailbox.email) continue;
    const m = matchIncoming(inc, sent);
    if (!m) continue; // unrelated mail is never stored
    matched++;
    const id = await deps.store.recordReply({
      prospectId: m.prospectId,
      mailboxId: mailbox.id,
      messageRowId: m.messageRowId,
      from: inc.from ?? "",
      subject: inc.subject,
      body: inc.text,
      rfcMessageId: inc.messageId,
      receivedAt: inc.date ?? now,
      kind: m.kind,
      bouncedAddress: m.bouncedAddress,
    });
    if (!id) continue;
    stored++;
    if (m.kind === "bounce") bounces++;
    else if (m.kind === "possible_bounce") possibleBounces++;
    else if (isAutoReply(inc)) await deps.store.setReplyClass(id, "out_of_office", "ai", "Resposta automática (cabeçalho).", null);
  }
  const c = await classifyPending(deps, mailbox.workspace_id);
  return { fetched: incoming.length, matched, stored, bounces, possibleBounces, classified: c.classified, aiProblem: c.aiProblem };
}

/** Labels stored replies that have no label yet (Haiku). An 'unsubscribe' label suppresses (the safe direction). */
export async function classifyPending(deps: EmailDeps, workspaceId: string, limit = CLASSIFY_PER_CALL): Promise<{ classified: number; aiProblem: AiErrorCode | null }> {
  if (!deps.ai) return { classified: 0, aiProblem: "not_configured" };
  const pending = await deps.store.unclassifiedReplies(workspaceId, limit);
  let classified = 0;
  for (const r of pending) {
    try {
      const res = await classifyReply({ workspaceId, runId: null, ledger: deps.store, transport: deps.ai }, { subject: r.subject, text: r.body_text });
      await deps.store.setReplyClass(r.id, res.data.classification, "ai", res.data.reason, res.data.model);
      classified++;
    } catch (e) {
      if (isAiError(e)) {
        if (AI_STOP.has(e.code)) return { classified, aiProblem: e.code };
        continue;
      }
      throw e;
    }
  }
  return { classified, aiProblem: null };
}

/** An AI draft of our answer to one reply. It is stored as a 'draft' message and needs approval like any other. */
export async function draftAnswer(deps: EmailDeps, reply: ReplyRow, workspaceName: string): Promise<{ ok: true } | { ok: false; code: AiErrorCode | "not_found" }> {
  if (!reply.prospect_id || reply.is_bounce || reply.possible_bounce) return { ok: false, code: "not_found" };
  const prospect = await deps.store.getProspect(reply.prospect_id);
  if (!prospect) return { ok: false, code: "not_found" };
  const [sender, profile, messages] = await Promise.all([
    deps.store.getSender(prospect.workspace_id),
    deps.store.getProfile(prospect.workspace_id),
    deps.store.listProspectMessages(prospect.id),
  ]);
  // only what really went out: a rehearsal never reached the prospect
  const last = [...messages].reverse().find((m) => m.status === "sent") ?? null;
  try {
    const res = await draftReply(
      { workspaceId: prospect.workspace_id, runId: null, ledger: deps.store, transport: deps.ai },
      {
        workspaceName,
        senderName: sender?.sender_name.trim() || workspaceName,
        profile,
        prospect: { company: prospect.company_name, contactName: prospect.contact_name },
        ourLastEmail: last ? { subject: last.subject, body: last.body } : null,
        reply: { subject: reply.subject, text: reply.body_text, classification: reply.classification },
      },
    );
    if (!res.data.body) return { ok: false, code: "invalid_output" };
    await deps.store.insertMessages([
      {
        workspace_id: prospect.workspace_id,
        campaign_id: prospect.campaign_id,
        prospect_id: prospect.id,
        kind: "reply",
        step: null,
        reply_to_id: reply.id,
        subject: replySubject(reply.subject),
        body: res.data.body,
        ai_drafted: true,
        ai_model: res.data.model,
        prompt_version: res.data.promptVersion,
      },
    ]);
    return { ok: true };
  } catch (e) {
    if (isAiError(e)) return { ok: false, code: e.code };
    throw e;
  }
}

// ---------------------------------------------------------------- 5. "Passar pra closer"
/** Marks the hand-off (who/when come from the database), then asks Opus for a short brief. No external send. */
export async function handOffWithBrief(
  deps: EmailDeps,
  prospectId: string,
  workspaceName: string,
): Promise<{ handedOff: boolean; brief: boolean; aiProblem: AiErrorCode | null }> {
  const prospect = await deps.store.getProspect(prospectId);
  if (!prospect) return { handedOff: false, brief: false, aiProblem: null };
  if (prospect.status !== "handed_off") await deps.store.handOff(prospectId);
  return { handedOff: true, ...(await refreshBrief(deps, prospectId, workspaceName)) };
}

export async function refreshBrief(deps: EmailDeps, prospectId: string, workspaceName: string): Promise<{ brief: boolean; aiProblem: AiErrorCode | null }> {
  const prospect = await deps.store.getProspect(prospectId);
  if (!prospect) return { brief: false, aiProblem: null };
  const [messages, replies] = await Promise.all([deps.store.listProspectMessages(prospectId), deps.store.listProspectReplies(prospectId)]);
  const thread = [
    ...messages
      .filter((m) => m.status === "sent") // a rehearsal never reached the prospect
      .map((m) => ({ direction: "us" as const, subject: m.subject, text: m.body, at: m.sent_at ?? m.created_at })),
    ...replies.filter((r) => !r.is_bounce && !r.possible_bounce).map((r) => ({ direction: "them" as const, subject: r.subject, text: r.body_text, at: r.received_at })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  try {
    const res = await writeCloserBrief(
      { workspaceId: prospect.workspace_id, runId: null, ledger: deps.store, transport: deps.ai },
      {
        workspaceName,
        prospect: { company: prospect.company_name, contactName: prospect.contact_name, contactTitle: prospect.contact_title, email: prospect.email, hook: prospect.hook },
        evidence: (prospect.evidence ?? []).map((e) => ({ url: e.url, title: e.title, excerpt: e.excerpt })),
        thread,
      },
    );
    await deps.store.saveBrief(prospectId, res.data);
    return { brief: true, aiProblem: null };
  } catch (e) {
    if (isAiError(e)) return { brief: false, aiProblem: e.code };
    throw e;
  }
}
