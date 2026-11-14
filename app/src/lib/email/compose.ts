// Building the exact message that leaves (R4, R12). Pure and client-safe: the review screen uses the same
// function to show the final text, footer included.
import type { SenderProfile } from "./types";

export const SUBJECT_MAX = 150;
export const BODY_MAX = 5000;

/** Same pattern as the database check email_messages_r4_subject: no fake "Re:" / "Fwd:" on cold e-mail. */
export const DECEPTIVE_SUBJECT = /^\s*[[(]?\s*(re|fw|fwd|aw|tr|sv|vs)\s*(\[\d+\])?\s*[:\])]/i;
/** Same pattern as the database check email_messages_r12_links. */
export const LINK = /(https?:\/\/|www\.)/i;

export type SubjectProblem = "empty" | "too_long" | "line_break" | "deceptive";

export function subjectProblem(subject: string, kind: "sequence" | "reply" = "sequence"): SubjectProblem | null {
  const s = subject.trim();
  if (!s) return "empty";
  if (s.length > SUBJECT_MAX) return "too_long";
  if (/[\r\n]/.test(subject)) return "line_break";
  if (kind === "sequence" && DECEPTIVE_SUBJECT.test(s)) return "deceptive";
  return null;
}

export type BodyProblem = "empty" | "too_long" | "link";

export function bodyProblem(body: string, kind: "sequence" | "reply" = "sequence"): BodyProblem | null {
  const b = body.trim();
  if (!b) return "empty";
  if (b.length > BODY_MAX) return "too_long";
  if (kind === "sequence" && LINK.test(b)) return "link";
  return null;
}

export function hasLink(text: string): boolean {
  return LINK.test(text);
}

/** Removes URLs from AI text (R12). Whole tokens that look like links are dropped. */
export function stripLinks(text: string): string {
  return text
    .replace(/\(?\b(?:https?:\/\/|www\.)[^\s)]+\)?/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,;:!?])/g, "$1")
    .trim();
}

/** Drops any "Re:"/"Fwd:" prefixes so an AI subject can never look like a reply. */
export function stripReplyPrefix(subject: string): string {
  let s = subject.trim();
  for (let i = 0; i < 5 && DECEPTIVE_SUBJECT.test(s); i++) s = s.replace(DECEPTIVE_SUBJECT, "").trim();
  return s;
}

export function replySubject(original: string): string {
  const base = stripReplyPrefix(original).replace(/[\r\n]+/g, " ").slice(0, SUBJECT_MAX - 4);
  return `Re: ${base || "your message"}`;
}

/** Header-safe value: no line breaks, no control characters. */
export function headerSafe(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

export function senderComplete(s: SenderProfile | null): s is SenderProfile {
  return Boolean(s && s.legal_name.trim().length >= 2 && s.postal_address.trim().length >= 10 && s.sender_name.trim().length >= 2);
}

export type UnsubscribeUrls = { page: string; oneClick: string };

const LOCAL_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$|\.localhost$|\.local$/i;

/** An origin real e-mail may point at: https, a public host name, no path, no credentials. */
export function isPublicHttpsOrigin(origin: string | null | undefined): origin is string {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      (u.pathname === "/" || u.pathname === "") &&
      !u.search &&
      !u.hash &&
      !LOCAL_HOST.test(u.hostname) &&
      u.hostname.includes(".")
    );
  } catch {
    return false;
  }
}

/**
 * Which origin the unsubscribe links of a message use. Real sends (and the test message, which really leaves) use
 * only the configured APP_PUBLIC_ORIGIN and are refused without a valid one; never the request's Host header.
 * Rehearsal and previews may fall back to the request origin (nothing leaves).
 */
export function unsubscribeOrigin(real: boolean, configured: string | null, requestOrigin: string | null): string | null {
  if (isPublicHttpsOrigin(configured)) return new URL(configured).origin;
  if (real) return null;
  return requestOrigin;
}

export function unsubscribeUrls(origin: string, token: string): UnsubscribeUrls {
  const base = origin.replace(/\/+$/, "");
  return { page: `${base}/u/${token}`, oneClick: `${base}/api/unsubscribe/${token}` };
}

/** CAN-SPAM footer (R4): real sender name, legal name, postal address and a working unsubscribe link. English. */
export function buildFooter(sender: SenderProfile, unsubscribePage: string): string {
  const address = sender.postal_address
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
  return [
    "--",
    headerSafe(sender.sender_name),
    headerSafe(sender.legal_name),
    address,
    "",
    `If you'd rather not hear from us, unsubscribe here: ${unsubscribePage}`,
  ].join("\n");
}

export type OutgoingEmail = {
  from: { name: string; address: string };
  to: string;
  subject: string;
  /** Plain text only (R12): body, then the footer. */
  text: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  /** RFC 8058 one-click unsubscribe. */
  headers: { "List-Unsubscribe": string; "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
};

export type ComposeInput = {
  kind: "sequence" | "reply";
  sender: SenderProfile;
  fromAddress: string;
  to: string;
  subject: string;
  body: string;
  unsubscribe: UnsubscribeUrls;
  messageId: string;
  inReplyTo?: string | null;
  /** Real send: the unsubscribe links must be on a public https origin (never localhost / http). */
  strictOrigin?: boolean;
};

export class ComposeError extends Error {
  constructor(readonly code: "sender_incomplete" | SubjectProblem | BodyProblem | "address" | "unsubscribe_url") {
    super(code);
    this.name = "ComposeError";
  }
}

const ADDRESS = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

function isUnsubscribeUrl(u: string, strict: boolean): boolean {
  try {
    const url = new URL(u);
    if (strict) return isPublicHttpsOrigin(url.origin);
    return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}

/** The exact message (headers, text) that leaves. Throws ComposeError when a rule would be broken. */
export function composeEmail(i: ComposeInput): OutgoingEmail {
  if (!senderComplete(i.sender)) throw new ComposeError("sender_incomplete");
  const sp = subjectProblem(i.subject, i.kind);
  if (sp) throw new ComposeError(sp);
  const bp = bodyProblem(i.body, i.kind);
  if (bp) throw new ComposeError(bp);
  const to = i.to.trim().toLowerCase();
  const from = i.fromAddress.trim().toLowerCase();
  if (!ADDRESS.test(to) || !ADDRESS.test(from)) throw new ComposeError("address");
  if (!isUnsubscribeUrl(i.unsubscribe.page, Boolean(i.strictOrigin)) || !isUnsubscribeUrl(i.unsubscribe.oneClick, Boolean(i.strictOrigin))) throw new ComposeError("unsubscribe_url");
  const body = i.body.replace(/\r\n?/g, "\n").trim();
  return {
    from: { name: headerSafe(i.sender.sender_name), address: from },
    to,
    subject: headerSafe(i.subject),
    text: `${body}\n\n${buildFooter(i.sender, i.unsubscribe.page)}\n`,
    messageId: i.messageId,
    inReplyTo: i.inReplyTo ?? null,
    references: i.inReplyTo ? [i.inReplyTo] : [],
    headers: {
      "List-Unsubscribe": `<${i.unsubscribe.oneClick}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
