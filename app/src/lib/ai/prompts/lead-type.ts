import "server-only";
import { CONTEXT, UNTRUSTED, untrusted } from "./shared";

// "Classificar tipo com IA" (LEADS ⋯ menu): Haiku, no web tools, many leads per call, only data the app already has.
// Changing any text here changes the prompt: bump PROMPT_VERSION (rule R19).

export const PROMPT_VERSION = "lead-type-2026-11-16.2";

export const SYSTEM = `${CONTEXT}

Your job now: sort each company below into ONE customer type, using ONLY the data given for it (name, city, website domain, notes, company type, biggest permit, the lists it came from). You have no web tools.
Types:
- "residential": a contractor or builder doing houses: single-family or two-family homes, residential remodels.
- "small": small commercial work: shops, offices, restaurants, small fit-outs.
- "large": condos or multifamily buildings, property managers, developers, institutional or large commercial work, or jobs of US$ 500,000 or more.
If the data does not make the type clear, OMIT that company. Never guess from a vague name alone; omitting is a good answer.
Return ONLY compact JSON, no reasons and no other text: {"items":[{"r":"<ref exactly as given>","t":"residential|small|large"}]}. One item per company you are sure about.

${UNTRUSTED}`;

/** One lead as the model sees it; every text is capped before it gets here. */
export type LeadTypeItem = {
  ref: string;
  name: string;
  city: string | null;
  domain: string | null;
  companyType: string | null;
  notes: string | null;
  biggestJob: string | null;
  lists: string[];
};

export type LeadTypeInput = { leads: LeadTypeItem[] };

export function buildUser(i: LeadTypeInput): string {
  const lines = i.leads.map((l) =>
    [
      `[${l.ref}] ${l.name}`,
      l.city && `city: ${l.city}`,
      l.domain && `site: ${l.domain}`,
      l.companyType && `company type: ${l.companyType}`,
      l.biggestJob && `biggest permit: ${l.biggestJob}`,
      l.notes && `notes: ${l.notes}`,
      l.lists.length > 0 && `lists: ${l.lists.join("; ")}`,
    ].filter(Boolean).join(" | "),
  );
  return ["Companies (one per line):", untrusted("companies", lines.join("\n"))].join("\n");
}
