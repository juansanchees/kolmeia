// Gap resolver: tries to fill what an opportunity is missing (who is the company, how to reach it, where to bid).
// Ordered steps: permit number, applicant phone, name + town (all against the base), then the company's own site.
// Every step that cannot run or fails leaves a coverage row and the next step still runs. Network goes only through the
// injected readSite (robots.txt, 1 req/s, honest User-Agent live there); archived lookups are injected too.
import { nameKey, phoneKey } from "@/lib/research/dedupe";
import type { SiteRead } from "@/lib/qualifier/site/reader";
import type { CampaignParams, OfferContacts, OfferSignal } from "@/lib/offers/types";
import type { CoverageOutcome, CoverageRow } from "./coverage";

export type CompanyHit = { name: string; phone?: string; website?: string };
export type GapOpp = {
  signal: OfferSignal & { permit_no?: string | null };
  company: CompanyHit | null;
  link_status: "confirmed" | "pending" | "none";
  contacts: OfferContacts;
  /** In memory only (never stored): the applicant of a permit. */
  applicant?: { name?: string; phone?: string };
};
export type GapDeps = {
  /** false = no live network: the site step is recorded as skipped (`live off`). */
  live: boolean;
  now: () => Date;
  readSite: (website: string) => Promise<SiteRead>;
  /** Lookups return every company that fits; exactly one is a match, several stay pending. */
  byPermitNo?: (permitNo: string, town: string) => Promise<CompanyHit[]>;
  byPhone?: (phoneKey: string) => Promise<CompanyHit[]>;
  byNameTown?: (nameKey: string, town: string) => Promise<CompanyHit[]>;
};
export type GapLink = { status: "confirmed" | "pending"; via: "permit_no" | "applicant_phone" | "name_town"; company?: CompanyHit; candidates?: CompanyHit[] };
export type GapResult = { contacts: OfferContacts; company: CompanyHit | null; link?: GapLink; coverage: CoverageRow[] };

const VENDOR_RE = /(vendor|supplier|procore|buildingconnected|planhub|bidcontender)/i;
const BIDS_RE = /(\bbids?\b|bidding|rfq|rfp|subcontractor|prequal|trade-?partner)/i;

function siteOutcome(r: SiteRead): { outcome: CoverageOutcome; reason?: string } {
  switch (r.outcome) {
    case "ok": return { outcome: "ok" };
    case "site_blocked": return { outcome: "blocked", reason: "site blocked (403/429)" };
    case "robots": return { outcome: "robots", reason: "robots.txt disallows" };
    case "site_down": return { outcome: "down", reason: "site down or timeout" };
    case "not_html": return { outcome: "empty", reason: "not html" };
    case "no_site": return { outcome: "skipped", reason: "no site" };
    default: return { outcome: "down", reason: "read error" };
  }
}
function errorOutcome(e: unknown): { outcome: CoverageOutcome; reason: string } {
  const m = e instanceof Error ? e.message : String(e);
  const outcome: CoverageOutcome = /robots/i.test(m) ? "robots" : /\b(403|forbidden|429)\b/i.test(m) ? "blocked" : "down";
  return { outcome, reason: m.slice(0, 200) };
}

export async function resolveGaps(opp: GapOpp, deps: GapDeps, params?: CampaignParams): Promise<GapResult> {
  const town = opp.signal.town ?? "";
  const coverage: CoverageRow[] = [];
  let company = opp.company;
  let link: GapLink | undefined;
  const contacts: OfferContacts = { ...opp.contacts };
  const row = (source: string, outcome: CoverageOutcome, queried: number, rows_in: number, reason?: string) =>
    coverage.push({ town, source, ran_at: deps.now().toISOString(), outcome, queried, rows_in, ...(reason ? { reason } : {}) });

  // Step 4: the company's own site (phone, bids page, vendor portal). A campaign that wants the bid path reads it
  // before the lookups whenever the company is already known.
  let siteDone = false;
  const siteStep = async () => {
    if (siteDone || !company) return;
    siteDone = true;
    if (!company.website) return row("site_robot", "skipped", 0, 0, "no website");
    if (!deps.live) return row("site_robot", "skipped", 0, 0, "live off");
    try {
      const r = await deps.readSite(company.website);
      const o = siteOutcome(r);
      row("site_robot", o.outcome, 1, r.pages.length, o.reason);
      for (const p of r.pages) {
        const found = (u: string) => (contacts.source_url ??= p.url, u);
        if (!contacts.phone && p.facts.phones[0]) contacts.phone = found(p.facts.phones[0].value);
        for (const l of p.facts.links) {
          if (!contacts.vendor_portal_url && VENDOR_RE.test(l)) contacts.vendor_portal_url = found(l);
          else if (!contacts.bids_url && BIDS_RE.test(l)) contacts.bids_url = found(l);
        }
      }
    } catch (e) {
      const o = errorOutcome(e);
      row("site_robot", o.outcome, 1, 0, o.reason);
    }
  };
  if (params?.wantBidPath) await siteStep();

  // Steps 1-3: only while the responsible company is not confirmed. One hit = linked; several = pending, never guessed.
  const steps: { source: GapLink["via"]; run: (() => Promise<CompanyHit[]>) | null }[] = [
    { source: "permit_no", run: opp.signal.permit_no && deps.byPermitNo ? () => deps.byPermitNo!(opp.signal.permit_no!, town) : null },
    { source: "applicant_phone", run: phoneKey(opp.applicant?.phone) && deps.byPhone ? () => deps.byPhone!(phoneKey(opp.applicant!.phone)!) : null },
    { source: "name_town", run: opp.applicant?.name && nameKey(opp.applicant.name) && deps.byNameTown ? () => deps.byNameTown!(nameKey(opp.applicant!.name!), town) : null },
  ];
  if (opp.link_status !== "confirmed") {
    for (const st of steps) {
      if (!st.run) continue;
      const source = `kb_match:${st.source}`;
      try {
        const hits = await st.run();
        if (hits.length === 1) {
          company = hits[0];
          link = { status: "confirmed", via: st.source, company: hits[0] };
          row(source, "ok", 1, 1);
          break;
        }
        if (hits.length > 1) {
          link ??= { status: "pending", via: st.source, candidates: hits };
          row(source, "partial", 1, hits.length, "ambiguous: several companies fit");
        } else row(source, "empty", 1, 0);
      } catch (e) {
        const o = errorOutcome(e);
        row(source, o.outcome, 1, 0, `lookup error: ${o.reason}`);
      }
    }
  }

  await siteStep();
  return { contacts, company, ...(link ? { link } : {}), coverage };
}
