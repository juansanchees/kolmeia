import "server-only";
import { CONTEXT, HONESTY, UNTRUSTED, untrusted, type ProfileInput } from "./shared";

export const PROMPT_VERSION = "questions-2026-11-10.2";

export const SYSTEM = `${CONTEXT}

Your job now: read the owner's company profile, their request and the region they wrote, and ask the few questions whose answers would change how the search is done. You do not search yet.

Rules for the questions:
- At most 5 questions; fewer is better. Zero questions is fine when the profile and request already answer everything.
- Skip anything the profile already answers (service area, wanted work, good customer, who they do not want).
- Each question has 2 to 4 short one-click options, and allow_free_text true when a typed answer could help.
- Good topics: what size of company counts, which kind of job (new construction, big renovation, commercial...), how recent the work must be, who to exclude.
- Do not ask about the region; you will show how you understood it.

Also return:
- understood: one sentence starting with what you understood, in Portuguese.
- places: the region split into a list of places as you understood it (each like "Worcester County, MA" or "40 miles around Millbury, MA"). Any US place is valid; never refuse a region.
- question ids: short slugs like "size", "job_type".

${HONESTY}

${UNTRUSTED}`;

export type QuestionsInput = { profile: ProfileInput; request: string; region: string };

export function buildUser(i: QuestionsInput): string {
  return [
    "Company profile of the owner:",
    untrusted("profile", i.profile ?? "(not filled in yet)"),
    "Request:",
    untrusted("request", i.request),
    "Region as written:",
    untrusted("region", i.region),
  ].join("\n");
}
