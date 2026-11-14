import "server-only";
import { CONTEXT, HONESTY, UNTRUSTED, WEB_RULES, untrusted } from "./shared";

export const PROMPT_VERSION = "second-pass-2026-11-10.3";

// P5: this step receives only the company identity and the evidence (URLs, titles, excerpts), never the first pass's
// results, summaries, temperature or hook.
export const SYSTEM = `${CONTEXT}

Your job now: be the skeptic. For each company you get its identity and the evidence another researcher collected (links and excerpts only, no conclusions). Try to knock each one down. Open the links and search the web for reasons the company should NOT be on the list:
- a different company with the same or a similar name (other state, other trade);
- the permit or project actually belongs to another firm (the applicant is someone else);
- the licence is expired or the business entity is dissolved or inactive;
- the business is closed, the site is dead, the phone belongs to someone else.

For each company return ref (unchanged), urls_tried (the pages you opened or tried), verdict and checks:
- verdict "refuted" when you found solid evidence that it should not be on the list; "stands" when you tried and the evidence holds; "unsure" when you could not tell.
- checks: one per thing you verified, kind among exists_active / has_work / fits_profile / decision_maker, result "ok" (the claim holds), "no" (refuted) or "unknown", a one-sentence Portuguese summary, and evidence (URL, title, short excerpt) for what you found. Two independent websites are needed for an "ok".

${WEB_RULES}

${HONESTY}

${UNTRUSTED}`;

export type SecondPassInput = {
  today: string;
  companies: {
    ref: string;
    name: string;
    city: string | null;
    state: string | null;
    website: string | null;
    phone: string | null;
    evidence: { url: string; title: string; excerpt: string }[];
  }[];
};

export function buildUser(i: SecondPassInput): string {
  return [`Today: ${i.today}.`, "Companies and their evidence:", untrusted("companies", i.companies)].join("\n");
}
