// Client-safe rules that classify a lead: its type ("Tipo", segment) and its stage ("Etapa"). No imports from view.ts
// (shortcuts.ts imports from here, and view.ts imports shortcuts' consumers).
import type { CandidateRow } from "@/lib/research/rows";
import type { LeadRow, LeadStage, OriginList, Segment } from "./types";

/** "Alvará grande": the research's permits add up to at least this much (US$). */
export const BIG_PERMIT_USD = 500_000;

/** Lower-case, accents removed: how names and cities are compared everywhere on LEADS. */
export function fold(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/** Matched as substrings of the folded list name, so plurals match. */
export const LIST_SEGMENT_KEYWORDS: Record<"large" | "residential", readonly string[]> = {
  large: ["administradora", "incorporadora", "comercial", "berdo"],
  residential: ["residencial", "empreiteiro"],
};

export type SegmentInput = {
  override: Segment | null;
  companyType: string | null;
  biggestPermitUsd: number | null;
  approach: string | null;
  biggestJobType: string | null;
  listNames: string[];
};

const RESIDENTIAL_JOB = /resid|single[- ]?family|two[- ]?family|\bhouse\b|\bhome\b/;
const NON_RESIDENTIAL_JOB = /non[- ]?resid/;
const residentialJob = (type: string | null) => { const j = fold(type ?? ""); return !NON_RESIDENTIAL_JOB.test(j) && RESIDENTIAL_JOB.test(j); };

const listHas = (names: string[], kws: readonly string[]) => names.some((n) => kws.some((k) => fold(n).includes(k)));

/** The type a lead gets without a manual choice. "small" is never derived (it has no rule yet). Grande wins a conflict. */
export function derivedSegmentOf(i: Omit<SegmentInput, "override">): Segment | null {
  const usd = i.biggestPermitUsd;
  if (
    i.companyType === "developer" || i.companyType === "property_manager" || (usd !== null && usd >= BIG_PERMIT_USD) ||
    i.approach === "supplier_signup" || listHas(i.listNames, LIST_SEGMENT_KEYWORDS.large)
  ) return "large";
  // shortcut: only the biggest job's type is stored, upgrade when per-permit types exist
  if (listHas(i.listNames, LIST_SEGMENT_KEYWORDS.residential) || (usd !== null && usd < BIG_PERMIT_USD && residentialJob(i.biggestJobType))) return "residential";
  return null;
}

export function segmentOf(i: SegmentInput): Segment | null {
  return i.override ?? derivedSegmentOf(i);
}

export function segmentInputOf(
  lead: Pick<LeadRow, "segment">,
  best: Pick<CandidateRow, "company_type" | "biggest_job_value_usd" | "approach" | "biggest_job_type"> | null,
  companyType: string | null,
  origins: OriginList[],
): SegmentInput {
  return {
    override: lead.segment,
    companyType: best?.company_type ?? companyType,
    biggestPermitUsd: best?.biggest_job_value_usd ?? null,
    approach: best?.approach ?? null,
    biggestJobType: best?.biggest_job_type ?? null,
    listNames: origins.map((o) => o.name),
  };
}

/** Archived overrides everything; "new" with a first contact already counts as contacted. */
export function stageOf(lead: Pick<LeadRow, "status" | "first_contacted_at"> & { archived_at?: string | null }): LeadStage {
  if (lead.archived_at) return "archived";
  switch (lead.status) {
    case "new": return lead.first_contacted_at ? "contacted" : "new";
    case "call_list":
    case "in_campaign": return "contacted";
    case "replied": return "replied";
    case "with_closer":
    case "meeting": return "meeting";
    case "won":
    case "lost":
    case "discarded": return "closed";
  }
}
