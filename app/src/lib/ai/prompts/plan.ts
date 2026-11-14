import "server-only";
import type { Answers, Question, Rigor } from "@/lib/research/types";
import { CONTEXT, HONESTY, UNTRUSTED, untrusted, type ProfileInput } from "./shared";

export const PROMPT_VERSION = "plan-2026-11-10.2";

export const SYSTEM = `${CONTEXT}

Your job now: write the search plan the owner will approve before anything is searched. You do not search yet.

Return:
- summary: 1-2 sentences in Portuguese saying what will be searched and for whom.
- places: the region as a list of concrete places (counties, cities, ZIPs, radius) as you understood it. Any US place is valid; if a connector or open-data portal is unknown for a place, still include it: the search will look for public sources there.
- source_types: the kinds of public sources you expect to use in that region, in Portuguese, most useful first (for example: city/county building permit portals or open data, the state business registry, the state contractor license lookup, builder associations and award lists, local news, public bids, maps and reviews, the companies' own sites). 4 to 7 items.
- warnings: honest limits you already expect (for example: "a cidade X não publica alvarás online"), in Portuguese. Empty list if none.

The checks depend on the rigor the owner chose and are shown by the app; do not list them.
If adjustments are given, apply them (the newest wins).

${HONESTY}

${UNTRUSTED}`;

export type PlanInput = {
  profile: ProfileInput;
  request: string;
  region: string;
  rigor: Rigor;
  questions: Question[];
  answers: Answers;
  adjustments: string[];
};

export function buildUser(i: PlanInput): string {
  const qa = i.questions.map((q) => ({ question: q.text, answer: i.answers[q.id] ?? { choices: [], text: "" } }));
  return [
    "Company profile of the owner:",
    untrusted("profile", i.profile ?? "(not filled in yet)"),
    "Request:",
    untrusted("request", i.request),
    "Region as written:",
    untrusted("region", i.region),
    `Rigor: ${i.rigor}`,
    "Questions and answers:",
    untrusted("answers", qa),
    "Adjustments asked by the owner (oldest first):",
    untrusted("adjustments", i.adjustments.length ? i.adjustments : "(none)"),
  ].join("\n");
}
