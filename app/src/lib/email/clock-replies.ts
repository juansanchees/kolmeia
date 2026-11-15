import "server-only";
import type { MailboxKeyRing } from "./config";
import { decryptSecret, mailboxAad } from "./crypto";
import { isAutoReply, matchIncoming, type Incoming, type SentRef } from "./replies";
import type { NewReply } from "./store";
import { ownWordsForRules } from "./text";
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

/** last_read_at: when the clock last listed it for replies (before this run), or null. */
export type ReplyMailbox = { id: string; workspace_id: string; email: string; last_read_at: string | null };
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

/**
 * Phrases that ask us to stop writing. Narrow on purpose (a false hit suppresses a live lead for good): "remove me" /
 * "take me off" / "opt out" only with a list or e-mail context, "stop …" only aimed at "me".
 */
const STOP_PHRASES: RegExp[] = [
  /\bunsubscribe\b/i,
  /\b(?:remove|take)\s+me\s+(?:off|from)\s+(?:of\s+)?(?:your|the|this|these|ur|all)\s+(?:(?:e-?mail|mailing|contact|distribution|marketing)\s+)?(?:list|lists|mailing|e-?mails?)\b/i,
  /\bopt\s*-?\s*me\s+out\b/i,
  /\bopt(?:\s*-\s*|\s+)?out\s+(?:of|from)\s+(?:your|the|this|these|ur|all)\s+(?:(?:e-?mail|mailing|marketing)\s+)?(?:list|lists|mailing|e-?mails?|messages)\b/i,
  /\bstop\s+(?:e-?mailing|contacting|messaging|writing\s+to|sending\s+me)\s*(?:me\b)?/i,
  /\b(?:do\s+not|don'?t|please\s+don'?t)\s+(?:e-?mail|contact|write\s+to)\s+me\b/i,
  /\bno\s+more\s+e-?mails?\b/i,
];
/** "please don't remove me from the list", "never unsubscribe me", "I won't opt out of the mailing list". */
const NEGATED = /\b(?:don'?t|do\s+not|never|won'?t|will\s+not|not|no\s+need\s+to)\s+(?:\w+\s+){0,2}$/i;

/** Rule: the reply asks us to stop writing (subject or the person's own words, never our quoted e-mail or footer). */
export function asksToStop(inc: Incoming): boolean {
  for (const text of [inc.subject, ownWordsForRules(inc.text)]) {
    for (const re of STOP_PHRASES) {
      const g = new RegExp(re.source, "gi");
      for (const m of text.matchAll(g)) {
        // the "don't e-mail me" phrase carries its own negation; any other phrase preceded by a negation is not a request
        if (/^(?:do\s+not|don'?t|please\s+don'?t)\s/i.test(m[0])) return true;
        if (!NEGATED.test(text.slice(Math.max(0, m.index - 40), m.index))) return true;
      }
    }
  }
  return false;
}

function isAuthError(e: unknown): boolean {
  return e instanceof Error && e.name === "SchedulerAuthError";
}

/** IMAP read raced against the time left; on timeout the login is aborted (the transport closes its client). */
async function fetchWithin(imap: ImapTransport, creds: MailCreds, since: Date, ms: number): Promise<Incoming[]> {
  if (ms <= 0) throw new Error("tick_deadline");
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error("imap_timeout"));
    }, ms);
  });
  try {
    return await Promise.race([imap.fetchSince(creds, since, CLOCK_FETCH_MAX, abort.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * At most 5 mailboxes (the database's choice), no new one after `budgetMs`, nothing at all after `deadline` (absolute,
 * in now() time: the tick's hard stop inside maxDuration). Per mailbox: secret (decrypted in memory), our sent references
 * (30 days), one IMAP read since the last read minus a day (raced against the deadline), then each matched message
 * recorded with its rule label until the deadline (the rest is picked up next tick: each Message-ID is stored once).
 * The 'unsubscribe' rule needs a thread match (our Message-ID quoted): an address-only match may stop the sequence as a
 * reply but never suppresses. A broken login marks the mailbox (scheduler_mailbox_failed); other per-mailbox errors are
 * counted with a short code. A refused token rethrows.
 * read = mailboxes read; recorded = replies/bounces stored now.
 */
export async function clockReplies(
  store: ReplyStore,
  imap: ImapTransport,
  now: () => number = Date.now,
  opts: { key?: Buffer | MailboxKeyRing; budgetMs?: number; deadline?: number } = {},
): Promise<{ read: number; recorded: number; failed: number; error: string | null }> {
  const started = now();
  const budgetMs = opts.budgetMs ?? CLOCK_REPLY_BUDGET_MS;
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  let read = 0;
  let recorded = 0;
  let failed = 0;
  let error: string | null = null;

  for (const mb of await store.replyMailboxes()) {
    if (now() - started >= budgetMs || now() >= deadline) break;
    let stage: "login" | "record" = "login";
    try {
      const window = new Date(now() - CLOCK_REPLY_WINDOW_DAYS * 86_400_000);
      // a busy inbox: read from the last read (minus a day of overlap), so the newest CLOCK_FETCH_MAX are the unread ones
      const last = mb.last_read_at ? Date.parse(mb.last_read_at) - 86_400_000 : Number.NaN;
      const since = Number.isFinite(last) && last > window.getTime() ? new Date(last) : window;
      const stored = await store.replyMailboxSecret(mb.id);
      const creds: MailCreds = { user: mb.email, pass: decryptSecret(stored, mailboxAad(mb.workspace_id, mb.email), opts.key ?? undefined) };
      const sent = await store.replySentRefs(mb.id, window);
      if (!sent.length) continue; // nothing of ours to match: no login
      const incoming = await fetchWithin(imap, creds, since, Math.min(deadline - now(), 2_147_483_647));
      read++;
      stage = "record";
      const own = mb.email.toLowerCase();
      for (const inc of incoming) {
        if (now() >= deadline) break; // the rest next tick
        if (!inc.messageId || inc.from === own) continue;
        const m = matchIncoming(inc, sent);
        if (!m) continue; // unrelated mail is never stored
        const ruleClass: RuleClass | null =
          m.kind !== "reply" ? null : m.via === "thread" && asksToStop(inc) ? "unsubscribe" : isAutoReply(inc) ? "out_of_office" : null;
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
      const msg = e instanceof Error ? e.message : "";
      const text = ["mailbox_refused", "imap_timeout", "tick_deadline"].includes(msg) ? msg : mailErrorText(e);
      failed++;
      error ??= CODE.test(text) ? text : stage === "login" ? "imap_failed" : "reply_record_failed";
      if (stage === "login" && MAILBOX_BROKEN.has(text)) await store.replyMailboxFailed(mb.id, text).catch(() => undefined);
    }
  }
  return { read, recorded, failed, error };
}
