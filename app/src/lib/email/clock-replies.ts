import "server-only";
import type { MailboxKeyRing } from "./config";
import { decryptSecret, mailboxAad } from "./crypto";
import { isAutoReply, matchIncoming, type Incoming, type SentRef } from "./replies";
import type { NewReply } from "./store";
import { CLOCK_SMTP_TIMEOUTS, GmailImap, mailErrorText, type ImapTransport, type MailCreds } from "./transport";

// E5 (0026): the clock reads replies after its sends, with RULES ONLY (no AI call on the clock; the AI labels stay on
// the Respostas screen). It runs only behind the same locks as the clock's real sending: the route builds the IMAP reader
// (clockImap) only when the server switch is on and the mailbox key is configured, the store asks the database for reply
// mailboxes only in real mode, and the database lists a mailbox only while its workspace is clock_real_ready (C12 gate,
// owner's switch, stop off) and the mailbox is 'ok' + healthy on an active real campaign. Matching is replies.ts
// (matchIncoming / isBounce / isAutoReply); recording is record_email_reply's core (a reply stops the sequence, a bounce
// suppresses and counts toward E4's auto pause). Nothing is logged; credentials live in memory for one login only.

export const CLOCK_REPLY_WINDOW_DAYS = 30;
/** Messages read per mailbox per tick (the screen reads 150; the clock has less time). */
export const CLOCK_FETCH_MAX = 50;
/** No new mailbox after this long into the reply phase (each login is bounded by the short clock timeouts). */
export const CLOCK_REPLY_BUDGET_MS = 10_000;

/** Login problems that make every next login fail too: the mailbox is marked for a person's re-test. */
const MAILBOX_BROKEN = new Set(["auth_failed", "mailbox_secret", "key_missing"]);
const CODE = /^[a-z0-9_:]{1,60}$/;

export type ReplyMailbox = { id: string; workspace_id: string; email: string };
export type RuleClass = "unsubscribe" | "out_of_office";
export type ClockReply = NewReply & { ruleClass: RuleClass | null };

/** The clock's reply half of the store (scheduler-store.ts); every call is gated in the database (0026). */
export interface ReplyStore {
  replyMailboxes(): Promise<ReplyMailbox[]>;
  replyMailboxSecret(mailboxId: string): Promise<string>;
  replySentRefs(mailboxId: string, since: Date): Promise<SentRef[]>;
  recordClockReply(r: ClockReply): Promise<string | null>;
  replyMailboxFailed(mailboxId: string, code: string): Promise<void>;
}

/** The clock's IMAP reader, with the clock's short timeouts. The route calls this only behind the real switch. */
export function clockImap(): ImapTransport {
  return new GmailImap(CLOCK_SMTP_TIMEOUTS);
}

const STOP_WORDS =
  /\b(unsubscribe|remove me|take me off|opt[- ]?out|stop (?:e-?mailing|contacting|sending)|(?:do not|don'?t) (?:e-?mail|contact|write to) me|no more e-?mails?)\b/i;

/** The person's own words: the text above the quoted e-mail (">" lines, "On ... wrote:", "Original Message", "From:"). */
function ownWords(text: string): string {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*>/.test(line) || /^\s*On .+wrote:\s*$/i.test(line) || /^\s*-{2,}\s*Original Message/i.test(line) || /^\s*From:\s/i.test(line)) break;
    out.push(line);
  }
  return out.join("\n").slice(0, 2000);
}

/** Rule: the reply asks us to stop writing (subject or the person's own words). Suppressing is the safe direction. */
export function asksToStop(inc: Incoming): boolean {
  return STOP_WORDS.test(inc.subject) || STOP_WORDS.test(ownWords(inc.text));
}

function isAuthError(e: unknown): boolean {
  return e instanceof Error && e.name === "SchedulerAuthError";
}

/**
 * At most 5 mailboxes (the database's choice), no new one after `budgetMs`. Per mailbox: secret (decrypted in memory),
 * our sent references, one IMAP read, then each matched message recorded with its rule label. A broken login marks
 * the mailbox (scheduler_mailbox_failed); other per-mailbox errors are counted with a short code. A refused token rethrows.
 * read = mailboxes read; recorded = replies/bounces stored now (each Message-ID once).
 */
export async function clockReplies(
  store: ReplyStore,
  imap: ImapTransport,
  now: () => number = Date.now,
  opts: { key?: Buffer | MailboxKeyRing; budgetMs?: number } = {},
): Promise<{ read: number; recorded: number; failed: number; error: string | null }> {
  const started = now();
  const budgetMs = opts.budgetMs ?? CLOCK_REPLY_BUDGET_MS;
  let read = 0;
  let recorded = 0;
  let failed = 0;
  let error: string | null = null;

  for (const mb of await store.replyMailboxes()) {
    if (now() - started >= budgetMs) break;
    let stage: "login" | "record" = "login";
    try {
      const since = new Date(now() - CLOCK_REPLY_WINDOW_DAYS * 86_400_000);
      const stored = await store.replyMailboxSecret(mb.id);
      const creds: MailCreds = { user: mb.email, pass: decryptSecret(stored, mailboxAad(mb.workspace_id, mb.email), opts.key ?? undefined) };
      const sent = await store.replySentRefs(mb.id, since);
      if (!sent.length) continue; // nothing of ours to match: no login
      const incoming = await imap.fetchSince(creds, since, CLOCK_FETCH_MAX);
      read++;
      stage = "record";
      const own = mb.email.toLowerCase();
      for (const inc of incoming) {
        if (!inc.messageId || inc.from === own) continue;
        const m = matchIncoming(inc, sent);
        if (!m) continue; // unrelated mail is never stored
        const ruleClass: RuleClass | null = m.kind !== "reply" ? null : asksToStop(inc) ? "unsubscribe" : isAutoReply(inc) ? "out_of_office" : null;
        const id = await store.recordClockReply({
          prospectId: m.prospectId,
          mailboxId: mb.id,
          messageRowId: m.messageRowId,
          from: inc.from ?? "",
          subject: inc.subject,
          body: inc.text,
          rfcMessageId: inc.messageId,
          receivedAt: inc.date ?? new Date(now()),
          kind: m.kind,
          bouncedAddress: m.bouncedAddress,
          ruleClass,
        });
        if (id) recorded++;
      }
    } catch (e) {
      if (isAuthError(e)) throw e;
      const text = e instanceof Error && e.message === "mailbox_refused" ? "mailbox_refused" : mailErrorText(e);
      failed++;
      error ??= CODE.test(text) ? text : stage === "login" ? "imap_failed" : "reply_record_failed";
      if (stage === "login" && MAILBOX_BROKEN.has(text)) await store.replyMailboxFailed(mb.id, text).catch(() => undefined);
    }
  }
  return { read, recorded, failed, error };
}
