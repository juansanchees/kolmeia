import "server-only";
import type { Plan } from "@/lib/research/types";
import { CONTEXT, HONESTY, UNTRUSTED, WEB_RULES, untrusted, type ProfileInput } from "./shared";

export const PROMPT_VERSION = "collect-2026-11-10.3";

export const SYSTEM = `${CONTEXT}

Your job now: collect candidate companies that match the request in the region, using web search and web fetch on the sources listed (and any other public source you find on the way). Do not verify deeply yet; another step does that.
Search widely: by town and by each village or neighbourhood of the region, by kind of builder (custom homes, new construction, multifamily, developers), by source type (permit reports, planning/zoning board agendas, local news of new homes or subdivisions, builder associations and award lists, directories such as Houzz, BBB or Yellow Pages). A company seen in a search result is enough to collect it (with that result as found_at); open a list page when it can give several companies at once.

For each company return: name (as the company writes it), city, state (2 letters), region (the sub-region or county), website (the company's own site, empty if none found), phone (as published) and phone_source_url (the page that shows that phone; empty if none), company_type, size_note (one short Portuguese phrase on size if a page shows it, else empty), entry_path and found_at: the URL, page title and a short excerpt (max 300 characters) of the page where you found it.
entry_path says how the company came in: "signal" when you found it through a job, building permit, project or news of a project it is doing; "directory" when through a list (association, registry, award list, directory); "search" for anything else.

jobs_without_builder: jobs, permits or projects you saw on a page where the builder/contractor is NOT named (for example a permit row that lists only the owner). For each: address (or empty), project_name (or empty), job_type, declared_value_usd (plain number, empty if not shown), date (YYYY-MM-DD, empty if not shown), url (that page) and a short excerpt. Never guess the builder; never invent a job. Empty list when there are none.

Rules:
- Only companies that plausibly match the request and the owner's profile. Skip the owner's own competitors in the same trade unless the request asks for them.
- Do not return any company listed in <untrusted_known_names>; they are already collected.
- Return at most the number asked. Quality over quantity.
- sources_tried: every source you looked at in this step with its status ("used" or "empty" = opened; "unverified" = only seen in search results; "blocked" = you tried to open it and it refused; "error" = did not load) and a short Portuguese note. A "blocked" note says how a human can get it.
- exhausted: true only when you searched widely and the region has no more good candidates; false when the budget ran out first.

${WEB_RULES}

${HONESTY}

${UNTRUSTED}`;

export type CollectInput = {
  profile: ProfileInput;
  request: string;
  region: string;
  plan: Plan;
  sources: { title: string; url: string | null; status: string; note: string }[];
  knownNames: string[];
  want: number;
  /** 1-based round of this run's collection (round 2+ must try other searches). */
  round?: number;
  /** Searches already run in earlier rounds of this run (do not repeat). */
  queriesTried?: string[];
};

export function buildUser(i: CollectInput): string {
  return [
    "Company profile of the owner:",
    untrusted("profile", i.profile ?? "(not filled in yet)"),
    "Request:",
    untrusted("request", i.request),
    "Places:",
    untrusted("places", i.plan.places.length ? i.plan.places : i.region),
    "Sources found for this region:",
    untrusted("sources", i.sources),
    "Already collected (do not repeat):",
    untrusted("known_names", i.knownNames),
    ...((i.round ?? 1) > 1
      ? [
          `This is collection round ${i.round}. Earlier rounds already ran the searches below; use different ones (other villages, other source types, other words):`,
          untrusted("queries_tried", i.queriesTried ?? []),
        ]
      : []),
    `Return at most ${i.want} new companies.`,
  ].join("\n");
}
