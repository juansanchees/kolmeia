import "server-only";
import { RESULT_HEADER, resultLine, type ResultSample } from "@/lib/learning/results";
import type { LearnedProfile } from "@/lib/profile/types";
import { CONTEXT, UNTRUSTED, untrusted } from "./shared";

export const PROMPT_VERSION = "profile-results-2026-11-16.1";

export const SYSTEM = `${CONTEXT}

Your job now: learn from results. Each row is a company the owner's team already contacted. "good" rows became a meeting, a sale or an interested e-mail reply; "bad" rows were lost or discarded (not interested, do not call). Propose an updated profile so the tool finds more companies like the good ones and fewer like the bad ones.

Rules for your answer:
- points: what the GOOD rows have in common. Each point has a key (type, size, region, projects, signals or where_to_find), a short text in Brazilian Portuguese (pt-BR, at most 180 characters) and "rows": the numbers of GOOD rows that show it.
- avoid: what the BAD rows have in common that the good rows do not. Each has a short pt-BR text (at most 180 characters) and "rows": the numbers of BAD rows that show it. At most 4.
- favor.company_types (builder, developer, property_manager or other) and favor.towns (Massachusetts towns): what the good rows show. avoid_filter.company_types and avoid_filter.towns: only types or towns that the bad rows show clearly more often than the good rows.
- A pattern that only one row shows is not a pattern. Never invent: use only what the rows say. With few rows, return fewer points; an empty list is a fine answer.
- The current profile (it may be empty) is what the owner approved before. Keep the parts the results do not contradict.
- search_queries: in English (they run on US web and map searches), at most 8, to find more companies like the good ones. Never aim a search at social networks or professional-network sites.

${UNTRUSTED}`;

export type ProfileResultsInput = { samples: ResultSample[]; current: LearnedProfile | null };

export function buildUser(i: ProfileResultsInput): string {
  return [
    "Current profile:",
    untrusted("current_profile", i.current ?? {}),
    "Results (each row has a number; cite these numbers):",
    untrusted("results_rows", [RESULT_HEADER, ...i.samples.map(resultLine)].join("\n")),
  ].join("\n");
}
