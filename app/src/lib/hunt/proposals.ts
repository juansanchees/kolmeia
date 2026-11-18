// "Quero mais clientes": from the saved company profile (and the coverage already recorded) propose 2-3 searches the
// company can run, best first, each explained with codes (who buys, why it fits, which signal, where to look, what is
// assumed). Deterministic, no AI. The words are P5's messages.
import type { CoverageRow } from "@/lib/kb/coverage";
import { OFFERS } from "@/lib/offers";
import type { CompanyProfileLike, Offer } from "@/lib/offers/types";

export type Proposal = {
  offer: string;
  titleCode: string;
  buyerCodes: string[];
  whyFitCodes: string[];
  signalCodes: string[];
  sourceCodes: string[];
  assumptionCodes: string[];
  recommended: boolean;
  recommendReasonCodes: string[];
  score: number;
  /** Only on the recommended one, and only when a missing profile fact could change the pick (e.g. `ask_region`). */
  question?: string;
};

// Offer source codes → the coverage `source` they are recorded under (kb sources, 0040).
const COVERAGE_SOURCE: Record<string, string> = { town_permits: "permit", massbuilds: "project", company_site: "site_robot", management_company_sites: "site_robot" };
const COVERAGE_BONUS = 10;
const MAX_PROPOSALS = 3;

/** ok/partial coverage on any of the offer's sources = we already know where to look. */
function coverageCodes(sourceCodes: string[], coverage: CoverageRow[]): string[] {
  const kb = new Set(sourceCodes.map((s) => COVERAGE_SOURCE[s]).filter(Boolean));
  const rows = coverage.filter((c) => kb.has(c.source));
  if (!rows.length) return ["coverage_unknown"];
  return rows.some((c) => c.outcome === "ok" || c.outcome === "partial") ? ["coverage_ok"] : ["coverage_blocked"];
}

export function proposeSearches(profile: CompanyProfileLike, coverage: CoverageRow[], offers: Record<string, Offer> = OFFERS): Proposal[] {
  const scored = Object.values(offers)
    .map((o) => {
      const fit = o.meta.profileFit(profile);
      const cov = coverageCodes(o.meta.sourceCodes, coverage);
      const score = fit.score <= 0 ? 0 : fit.score + (cov[0] === "coverage_ok" ? COVERAGE_BONUS : 0);
      return { o, fit, cov, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.o.id.localeCompare(b.o.id))
    .slice(0, MAX_PROPOSALS);

  return scored.map((x, i) => {
    const recommended = i === 0;
    const p: Proposal = {
      offer: x.o.id,
      titleCode: `search_${x.o.id}`,
      buyerCodes: x.o.meta.buyerCodes,
      whyFitCodes: x.fit.reasonCodes,
      signalCodes: x.o.meta.signalCodes,
      sourceCodes: x.o.meta.sourceCodes,
      assumptionCodes: x.fit.assumptionCodes,
      recommended,
      recommendReasonCodes: recommended ? [...(scored.length > 1 ? ["best_profile_fit"] : ["only_fit"]), ...x.cov] : [],
      score: x.score,
    };
    if (recommended && x.fit.missing) p.question = x.fit.missing;
    return p;
  });
}
