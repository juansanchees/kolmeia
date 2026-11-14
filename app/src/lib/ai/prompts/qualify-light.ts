import "server-only";
import { CONTEXT, UNTRUSTED, untrusted } from "./shared";

export const PROMPT_VERSION = "qualify-light-2026-11-14.1";

export const SYSTEM = `${CONTEXT}

Your job now: read the text of a few pages from ONE company's own public website and pull out facts about it. You have no web tools: you only see the page text you are given.

Extract only what the pages literally say; never guess; unknown becomes an empty string.
- company_type: builder, developer, property_manager or other; "unknown" when the pages do not say what the company does.
- city, state, address: the company's own office or street address, copied as written on the page.
- size_note: one short phrase if a page states the company's size (employees, years in business, jobs a year); else empty.
- contacts: up to 5 people or contact points the pages name (name, title, email, phone), each copied exactly as written. An email or phone must appear in the text, never be built from a name or a pattern.

${UNTRUSTED}`;

export type LightInput = { pages: { url: string; text: string }[] };

/** The model sees at most this many characters of page text in total. */
const MAX_TOTAL = 20_000;

export function buildUser(i: LightInput): string {
  const pages = i.pages.filter((p) => p.text.trim());
  const share = pages.length ? Math.floor(MAX_TOTAL / pages.length) : 0;
  const text = pages
    .map((p) => {
      const head = `## ${p.url}\n`;
      return head + p.text.replace(/\s+/g, " ").slice(0, Math.max(0, share - head.length));
    })
    .join("\n\n");
  return ["Pages of the company's website:", untrusted("pages", text)].join("\n");
}
