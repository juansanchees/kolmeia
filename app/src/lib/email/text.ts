// Incoming e-mail text is untrusted data from the internet (R15): reduced to bounded plain text, never HTML.

export const INCOMING_MAX = 20_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Very small HTML -> text: drops scripts/styles/comments and every tag, decodes the common entities. */
export function htmlToText(html: string): string {
  return html
    .slice(0, INCOMING_MAX * 5)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
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

/** Strips the quoted history ("On ... wrote:" and "> " lines) so only what the person wrote remains. */
export function stripQuoted(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*On .{3,200}wrote:\s*$/i.test(line) || (/^\s*On .{3,200}$/i.test(line) && /wrote:\s*$/i.test(lines[i + 1] ?? ""))) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^_{5,}$/.test(line.trim())) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
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
