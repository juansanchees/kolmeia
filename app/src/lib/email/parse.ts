import "server-only";
import { simpleParser, type AddressObject } from "mailparser";
import { addressOf, parseIdList, normalizeMessageId, type Incoming } from "./replies";
import { incomingText } from "./text";

// Raw RFC 5322 bytes -> our Incoming shape: text only (HTML reduced to text), size-capped, attachments ignored.

const HTML_PARSE_MAX = 200_000;
/** Bytes kept from each machine part of a delivery report (we only need its fields and the original's headers). */
const REPORT_PART_MAX = 8_000;
const REPORT_TYPES = new Set(["message/delivery-status", "message/global-delivery-status", "text/rfc822-headers", "message/rfc822", "message/global"]);

/** Delivery-report parts (fields such as Action/Status, and the original message's headers) as plain text. */
function reportText(attachments: { contentType?: string; content?: Buffer }[] | undefined): string | null {
  const parts: string[] = [];
  for (const a of attachments ?? []) {
    if (!a.contentType || !REPORT_TYPES.has(a.contentType.toLowerCase()) || !Buffer.isBuffer(a.content)) continue;
    let t = a.content.subarray(0, REPORT_PART_MAX).toString("utf8");
    // for a whole quoted message keep its header block only (never its body)
    if (a.contentType.toLowerCase().startsWith("message/rfc822") || a.contentType.toLowerCase() === "message/global") t = t.split(/\r?\n\r?\n/)[0];
    parts.push(t.replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, " "));
  }
  return parts.length ? parts.join("\n").slice(0, 2 * REPORT_PART_MAX) : null;
}

function firstAddress(a: AddressObject | AddressObject[] | undefined): string | null {
  const obj = Array.isArray(a) ? a[0] : a;
  return obj?.value?.[0]?.address?.toLowerCase() ?? null;
}

function headerText(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => headerText(x)).filter(Boolean).join(", ");
  if (typeof v === "object" && "value" in (v as Record<string, unknown>)) {
    const o = v as { value: unknown; params?: Record<string, string> };
    const params = o.params ? Object.entries(o.params).map(([k, val]) => `; ${k}=${val}`).join("") : "";
    return `${String(o.value)}${params}`;
  }
  return String(v);
}

export async function parseRawEmail(source: Buffer | string): Promise<Incoming> {
  const mail = await simpleParser(source, {
    skipImageLinks: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    skipHtmlToText: true,
    maxHtmlLengthToParse: HTML_PARSE_MAX,
  });
  const html = typeof mail.html === "string" ? mail.html : null;
  return {
    messageId: normalizeMessageId(mail.messageId ?? null),
    from: firstAddress(mail.from) ?? addressOf(headerText(mail.headers.get("from"))),
    subject: (mail.subject ?? "").replace(/[\r\n]+/g, " ").slice(0, 300),
    inReplyTo: normalizeMessageId(mail.inReplyTo ?? null),
    references: parseIdList(mail.references ?? null),
    text: incomingText({ text: mail.text ?? null, html }),
    date: mail.date ?? null,
    contentType: headerText(mail.headers.get("content-type")),
    autoSubmitted: headerText(mail.headers.get("auto-submitted")),
    failedRecipients: headerText(mail.headers.get("x-failed-recipients")),
    report: reportText(mail.attachments),
  };
}
