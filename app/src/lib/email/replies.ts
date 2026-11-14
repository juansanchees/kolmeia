// Matching an incoming message to one of our prospects, and recognising bounces. Pure (tests feed fixtures).

export type Incoming = {
  messageId: string | null;
  from: string | null;
  subject: string;
  inReplyTo: string | null;
  references: string[];
  text: string;
  date: Date | null;
  contentType: string | null;
  autoSubmitted: string | null;
  failedRecipients: string | null;
  /** Machine parts of a delivery report (message/delivery-status and the original's headers), as text; else null. */
  report: string | null;
};

export type SentRef = { messageRowId: string; prospectId: string; rfcMessageId: string; toAddress: string; sentAt: string };

export type Match = {
  prospectId: string;
  messageRowId: string | null;
  via: "thread" | "address";
  /** reply: a person answered; bounce: a failure report that quotes OUR Message-ID; possible_bounce: a person decides. */
  kind: "reply" | "bounce" | "possible_bounce";
  /** For (possible) bounces: the address the report says failed. */
  bouncedAddress: string | null;
};

/** "<a@b>" lower-cased and trimmed; null when it does not look like a Message-ID. */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/<?([^<>\s]+@[^<>\s]+)>?/);
  return m ? `<${m[1].toLowerCase()}>` : null;
}

export function parseIdList(raw: string | string[] | null | undefined): string[] {
  const text = Array.isArray(raw) ? raw.join(" ") : (raw ?? "");
  const ids = text.match(/<[^<>\s]+@[^<>\s]+>/g) ?? [];
  return ids.map((id) => normalizeMessageId(id)).filter((x): x is string => Boolean(x));
}

export function addressOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/<([^<>\s]+@[^<>\s]+)>/) ?? raw.match(/([^\s<>"']+@[^\s<>"']+)/);
  return m ? m[1].toLowerCase().replace(/[.,;]+$/, "") : null;
}

const DAEMON = /^(mailer-daemon|postmaster|mail-daemon|mailerdaemon)@/i;
const BOUNCE_SUBJECT = /(delivery status notification|undeliver(ed|able)|returned mail|failure notice|mail delivery (failed|subsystem)|delivery (has )?failed|address not found)/i;

export function isBounce(inc: Incoming): boolean {
  const from = addressOf(inc.from) ?? "";
  const ct = (inc.contentType ?? "").toLowerCase();
  if (ct.includes("multipart/report") && ct.includes("delivery-status")) return true;
  if (DAEMON.test(from)) return true;
  return Boolean(inc.failedRecipients) && BOUNCE_SUBJECT.test(inc.subject);
}

/** The address that bounced: X-Failed-Recipients, then Final-/Original-Recipient in the report or the text. */
export function bouncedAddress(inc: Incoming): string | null {
  const fromHeader = addressOf(inc.failedRecipients);
  if (fromHeader) return fromHeader;
  const m = `${inc.report ?? ""}\n${inc.text}`.match(/(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^\s<>;]+@[^\s<>;]+)>?/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * What a delivery report says: "failed" (Action: failed or Status: 5.x.x), "delayed" (Action: delayed or
 * Status: 4.x.x, and nothing failed) or "unknown" (no machine-readable fields).
 */
export function dsnVerdict(inc: Incoming): "failed" | "delayed" | "unknown" {
  const t = `${inc.report ?? ""}\n${inc.text}`;
  const actions = [...t.matchAll(/^[ \t]*Action:[ \t]*([a-z-]+)/gim)].map((m) => m[1].toLowerCase());
  const classes = [...t.matchAll(/^[ \t]*Status:[ \t]*([245])\.\d{1,3}\.\d{1,3}/gim)].map((m) => m[1]);
  if (actions.includes("failed") || classes.includes("5")) return "failed";
  if (actions.includes("delayed") || classes.includes("4")) return "delayed";
  return "unknown";
}

/** Out-of-office and other machine replies (RFC 3834). They still count as a reply, but we label them. */
export function isAutoReply(inc: Incoming): boolean {
  const a = (inc.autoSubmitted ?? "").toLowerCase();
  return (a !== "" && a !== "no") || /^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office)/i.test(inc.subject.trim());
}

/**
 * Finds which of our sent messages this one answers.
 * Replies: by In-Reply-To / References against the Message-IDs we stored, then by sender address = an address we
 * mailed (latest send wins).
 * Delivery reports (bounces) are trusted only when they prove they are about OUR message: they must quote one of
 * our Message-IDs (In-Reply-To/References, or the original headers inside the report) AND say failed / 5.x.x.
 * A delayed / 4.x.x report is ignored. A report that only names an address we mailed (anyone can write that) or
 * that quotes our id without a clear failure becomes a "possible bounce" for a person to confirm.
 * Mail that matches nothing is ignored and never stored.
 */
export function matchIncoming(inc: Incoming, sent: SentRef[]): Match | null {
  const byId = new Map(sent.map((s) => [s.rfcMessageId.toLowerCase(), s]));
  const latestTo = (address: string | null) =>
    address ? sent.filter((s) => s.toAddress.toLowerCase() === address).sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0] : undefined;
  const headerIds = [normalizeMessageId(inc.inReplyTo), ...inc.references.map(normalizeMessageId)].filter((x): x is string => Boolean(x));

  if (isBounce(inc)) {
    const verdict = dsnVerdict(inc);
    if (verdict === "delayed") return null;
    const ids = [...headerIds, ...parseIdList(inc.report), ...parseIdList(inc.text)];
    const ours = ids.map((id) => byId.get(id)).find(Boolean);
    const address = bouncedAddress(inc);
    if (ours && verdict === "failed") {
      return { prospectId: ours.prospectId, messageRowId: ours.messageRowId, via: "thread", kind: "bounce", bouncedAddress: address ?? ours.toAddress };
    }
    const target = ours ?? latestTo(address);
    return target
      ? { prospectId: target.prospectId, messageRowId: target.messageRowId, via: ours ? "thread" : "address", kind: "possible_bounce", bouncedAddress: address ?? target.toAddress }
      : null;
  }

  for (const id of headerIds) {
    const hit = byId.get(id);
    if (hit) return { prospectId: hit.prospectId, messageRowId: hit.messageRowId, via: "thread", kind: "reply", bouncedAddress: null };
  }
  const latest = latestTo(addressOf(inc.from));
  return latest ? { prospectId: latest.prospectId, messageRowId: latest.messageRowId, via: "address", kind: "reply", bouncedAddress: null } : null;
}

const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "aol.com", "icloud.com", "me.com", "comcast.net", "verizon.net", "proton.me", "protonmail.com",
]);

/**
 * Where our answer to a reply goes (mirror of public.reply_target_address in 0003): the reply's sender when it is
 * the prospect's own address or another address of the prospect's (non free-mail) domain; otherwise the
 * prospect's address. Shown to the person before approval; the approved address is stamped (R1).
 */
export function replyTarget(replyFrom: string | null, prospectEmail: string | null): string | null {
  const from = addressOf(replyFrom);
  if (!from || !prospectEmail) return prospectEmail;
  const p = prospectEmail.toLowerCase();
  if (from === p) return from;
  const domain = p.split("@")[1] ?? "";
  return from.split("@")[1] === domain && !FREE_MAIL.has(domain) ? from : p;
}
