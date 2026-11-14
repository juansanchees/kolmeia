import "server-only";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { OutgoingEmail } from "./compose";
import { parseRawEmail } from "./parse";
import type { Incoming } from "./replies";

// Network access to mailboxes. MVP: Gmail / Google Workspace only, fixed hosts in code (no user-supplied host,
// so no SSRF). Everything that touches the network implements these interfaces; tests inject fakes.

export const GMAIL_SMTP = { host: "smtp.gmail.com", port: 465, secure: true } as const;
export const GMAIL_IMAP = { host: "imap.gmail.com", port: 993, secure: true } as const;

/** Plaintext credentials, held in memory for one login only. Never logged, never returned to a browser. */
export type MailCreds = { user: string; pass: string };

export interface SmtpTransport {
  /** Logs in and out (EHLO + AUTH); throws on failure. */
  verify(creds: MailCreds): Promise<void>;
  send(creds: MailCreds, mail: OutgoingEmail): Promise<{ response: string }>;
}

export interface ImapTransport {
  /** Recent INBOX messages since a date, newest last, at most `max`, each capped in size and parsed to text. */
  fetchSince(creds: MailCreds, since: Date, max: number): Promise<Incoming[]>;
}

const TIMEOUTS = { connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 30_000 };
/** Raw bytes read per incoming message (bigger messages are cut; we only need the text). */
export const MAX_RAW_BYTES = 256 * 1024;

/** Error text safe to store and show: class, code and a short message; never credentials or message bodies (R10). */
export function mailErrorText(e: unknown): string {
  if (!(e instanceof Error)) return "unknown error";
  const x = e as Error & { code?: string; responseCode?: number; authenticationFailed?: boolean };
  // the stored app password cannot be opened (rotated key, edited row): the person reconnects the mailbox
  if (x.name === "SecretError") return "mailbox_secret";
  if (x.name === "MailboxKeyError") return "key_missing";
  if (x.authenticationFailed || x.code === "EAUTH" || x.responseCode === 535) return "auth_failed";
  const parts = [x.code, x.responseCode ? String(x.responseCode) : null, x.message.split("\n")[0]].filter(Boolean);
  return parts.join(" ").replace(/[^\x20-\x7e]+/g, " ").slice(0, 200);
}

export class GmailSmtp implements SmtpTransport {
  private client(creds: MailCreds) {
    return nodemailer.createTransport({
      host: GMAIL_SMTP.host,
      port: GMAIL_SMTP.port,
      secure: GMAIL_SMTP.secure,
      auth: { user: creds.user, pass: creds.pass },
      logger: false,
      debug: false,
      ...TIMEOUTS,
    });
  }

  async verify(creds: MailCreds): Promise<void> {
    const t = this.client(creds);
    try {
      await t.verify();
    } finally {
      t.close();
    }
  }

  async send(creds: MailCreds, mail: OutgoingEmail): Promise<{ response: string }> {
    const t = this.client(creds);
    try {
      const info = await t.sendMail({
        from: { name: mail.from.name, address: mail.from.address },
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        messageId: mail.messageId,
        inReplyTo: mail.inReplyTo ?? undefined,
        references: mail.references.length ? mail.references : undefined,
        headers: mail.headers,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      return { response: String(info.response ?? "").slice(0, 200) };
    } finally {
      t.close();
    }
  }
}

export class GmailImap implements ImapTransport {
  async fetchSince(creds: MailCreds, since: Date, max: number): Promise<Incoming[]> {
    const client = new ImapFlow({
      host: GMAIL_IMAP.host,
      port: GMAIL_IMAP.port,
      secure: GMAIL_IMAP.secure,
      auth: { user: creds.user, pass: creds.pass },
      logger: false,
      connectionTimeout: TIMEOUTS.connectionTimeout,
      greetingTimeout: TIMEOUTS.greetingTimeout,
      socketTimeout: TIMEOUTS.socketTimeout,
    });
    await client.connect();
    const out: Incoming[] = [];
    try {
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const found = await client.search({ since }, { uid: true });
        const uids = (Array.isArray(found) ? found : []).sort((a, b) => a - b).slice(-max);
        if (uids.length) {
          for await (const msg of client.fetch(uids, { uid: true, source: { maxLength: MAX_RAW_BYTES } }, { uid: true })) {
            if (msg.source) out.push(await parseRawEmail(msg.source));
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
    return out;
  }
}
