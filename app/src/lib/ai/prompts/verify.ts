import "server-only";
import type { CheckKind, Rigor } from "@/lib/research/types";
import { CONTEXT, HONESTY, UNTRUSTED, WEB_RULES, untrusted, type ProfileInput } from "./shared";

export const PROMPT_VERSION = "verify-2026-11-10.3";

export const SYSTEM = `${CONTEXT}

Your job now: check each company given, using web search and web fetch on public pages, and fill its record.

Return EXACTLY one entry per company given, with its ref copied unchanged, even when you found nothing for it (then every check is "unknown" and the summary says why).

How to work (in this order, and stop opening pages once the checks are answered):
1. Open the company's own website when one is given (it is in the input). Read its about, projects, team and contact pages.
2. Then public registries and permit pages for the company's town or state (state business registry, contractor license lookup, the town's permit portal or permit reports), found with web search.
3. Then news of its projects.
List in urls_tried every page you opened or tried to open for that company. If nothing could be read, say in each check's summary which URLs you tried and what happened (for example "o site recusou a leitura").

Run exactly the checks listed for this rigor. For each check return kind, result and evidence:
- exists_active: the business is registered and active (state registry or license lookup), its site or listing is live, phone/address are consistent.
- has_work: it has work now or recently: building permits in the last 18 months (permit portals, open data), projects on its own site with dates, news, awarded bids.
- fits_profile: it matches the owner's request and profile (size, kind of job), and is not someone the owner said they do not want.
- decision_maker: who to ask for (owner, president, estimator, project manager) from a public page.
result is "ok" (confirmed by the evidence), "no" (the evidence shows the opposite, for example dissolved, licence expired, no permits in years) or "unknown" (not enough public evidence; say why in summary). summary is one Portuguese sentence. evidence: the URL, page title and a short excerpt (max 300 characters, copied from the page) for each source used. An "ok" without evidence is not allowed.${"\n"}In strict rigor an "ok" needs two independent sources on different websites; with only one, answer "unknown" and say so.

Then fill the signal and contact fields from what you read (empty string when not found; never estimate):
- permit_count, total_value_usd (plain number, sum of declared values), last_permit_date (YYYY-MM-DD), biggest_job_address, biggest_job_value_usd (plain number), biggest_job_type, biggest_job_description (short), signal_match (which source and how it matched: by name, phone or website domain).
- ask_for_name, ask_for_title: the person to ask for (owner, president, estimator, project manager), only when a page you read names them; name_confidence ("high" when two sources on different websites agree, "medium" for one good source, "low" for a weak hint, "none" when not found), name_source_url (the page that names them), name_note (Portuguese: what cross-check supports the name, for example the permit applicant or the licence holder).
- phone and phone_source_url (the page that shows it), website, public_email (only an address published on a public page), email_type ("named" = a person or company-domain address, "generic" = info@/office@, "personal" = a published gmail/yahoo-type address, "none") and email_source_url.
- google_rating and review_count only if you saw them, with rating_source_url.
- is_large_contractor: true for large general contractors that prequalify subcontractors; supplier_portal_url: their subcontractor/supplier prequalification page if one exists.
- hook: ONE English sentence for a phone call that cites a real, sourced job, permit or project you found for THIS company (street address, job type, approximate value) and ends by asking who is handling the HVAC. Example shape: "Saw your Falmouth permit at 12 Example Rd (new 2-story home, ~$1.8M) - who's doing the HVAC?" Write it whenever has_work is confirmed; empty string when there is no confirmed job.
- jobs_without_builder (top level, not per company): jobs, permits or projects you saw where the builder is not named (address or project name, job_type, declared_value_usd, date YYYY-MM-DD, url, short excerpt). Empty list when none; never guess.
- notes: short Portuguese notes, including any limit (for example "valores são estimativas declaradas").

${WEB_RULES}

${HONESTY}

${UNTRUSTED}`;

export type VerifyInput = {
  rigor: Rigor;
  kinds: readonly CheckKind[];
  profile: ProfileInput;
  request: string;
  today: string;
  companies: { ref: string; name: string; city: string | null; state: string | null; website: string | null; phone: string | null }[];
};

export function buildUser(i: VerifyInput): string {
  return [
    `Rigor: ${i.rigor}. Checks to run: ${i.kinds.join(", ")}. Today: ${i.today}.`,
    "Company profile of the owner:",
    untrusted("profile", i.profile ?? "(not filled in yet)"),
    "Request:",
    untrusted("request", i.request),
    "Companies to check:",
    untrusted("companies", i.companies),
  ].join("\n");
}
