// Incoming e-mail text is untrusted data from the internet (R15): reduced to bounded plain text, never HTML.

export const INCOMING_MAX = 20_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Very small HTML -> text: drops scripts/styles/comments and every tag, decodes the common entities. */
export function htmlToText(html: string): string {
  return html
    .slice(0, INCOMING_MAX * 5)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    // the quoted history of an HTML-only reply (no ">" survives the tag strip): dropped as a whole
    .replace(/<blockquote[\s\S]*<\/blockquote\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

/** Attribution lines of a quoted reply: English, Portuguese and Spanish ("On … wrote:", "Em … escreveu:", "El … escribió:"). */
const ATTRIBUTION_START = /^\s*(On|Em|El)\s.{3,200}$/i;
const ATTRIBUTION_END = /(wrote|escreveu|escribi[oó]):\s*$/i;
/** An Outlook-style header block of the quoted message ("From: Name <a@b>", "De: …", "*From:* …"). */
const QUOTED_HEADER = /^\s*\*?(From|De|Von):\*?\s.*(@|\[mailto:)/i;

/** Strips the quoted history ("On ... wrote:", its pt/es forms, header blocks and "> " lines) so only what the person wrote remains. */
export function stripQuoted(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ATTRIBUTION_START.test(line) && ATTRIBUTION_END.test(line)) break;
    // a header wrapped on two (or three) lines by the client
    if (ATTRIBUTION_START.test(line) && (ATTRIBUTION_END.test(lines[i + 1] ?? "") || ATTRIBUTION_END.test(`${lines[i + 1] ?? ""} ${lines[i + 2] ?? ""}`))) break;
    if (/^-{2,}\s*(Original Message|Mensagem original|Mensaje original)\s*-{2,}/i.test(line) || /^_{5,}$/.test(line.trim())) break;
    if (QUOTED_HEADER.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * The person's own words for the clock's rules (E5): quoted history stripped, and nothing from OUR e-mail even when a
 * client leaked it unquoted: stops at a signature marker ("--") and drops any line with our unsubscribe link (/u/) or
 * the footer sentence.
 */
export function ownWordsForRules(text: string): string {
  const out: string[] = [];
  for (const line of stripQuoted(text.replace(/\r\n?/g, "\n")).split("\n")) {
    if (/^\s*--\s*$/.test(line)) break;
    if (/\/u\/[A-Za-z0-9_-]{8,}|\/api\/unsubscribe\/|rather not hear from us|unsubscribe here/i.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").slice(0, 2000);
}

/** Bounded, control-character-free plain text. */
export function cleanIncomingText(raw: string, max = INCOMING_MAX): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

/** Text of an incoming message: the text part if any, else the HTML reduced to text; quoted history removed. */
export function incomingText(parts: { text?: string | null; html?: string | null }, max = INCOMING_MAX): string {
  const base = parts.text && parts.text.trim() ? parts.text : parts.html ? htmlToText(parts.html) : "";
  const own = stripQuoted(cleanIncomingText(base, max * 2));
  return cleanIncomingText(own || base, max);
}
