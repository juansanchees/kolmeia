import "server-only";
import { z } from "zod";
import { townOf } from "@/lib/coverage/region";
import { PROFILE_ROWS_BUDGET_CHARS, PROFILE_SAMPLE_MAX, sampleRows } from "@/lib/profile/sample";
import { LIST_POINT_KEYS, type LearnedProfile } from "@/lib/profile/types";
import { COMPANY_TYPES } from "@/lib/research/types";
import { reserveFor, runTask, type AiContext, type TaskDef, type TaskResult } from "./gateway";
import { MODELS } from "./models";
import * as P from "./prompts/profile-learn";
import type { ProfileLearnInput } from "./prompts/profile-learn";

// The training call (C-d): one Sonnet call, no web tools, the list's rows as untrusted data. The model only proposes;
// whatever it returns is cut down here (rows of the sample, known towns, no social-network queries) and nothing is
// applied until a sender approves it.

export type { ProfileLearnInput };

export const profileSchema = z.object({
  points: z.array(z.object({ key: z.enum(LIST_POINT_KEYS), text: z.string(), rows: z.array(z.number()) })),
  filter: z.object({ company_types: z.array(z.enum(COMPANY_TYPES)), towns: z.array(z.string()) }),
  search_queries: z.array(z.string()),
});
type Parsed = z.infer<typeof profileSchema>;

const MAX_POINTS = 12;
const MAX_TEXT = 200;
const MAX_ROWS = 20;

/** Cap at `max` chars: cut at the last space and add "…" so no word is left half-written. */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const at = head.lastIndexOf(" ");
  const cut = at > 0 ? head.slice(0, at) : head;
  return `${cut.replace(/[\s,;:.\-–—]+$/, "")}…`;
}
const MAX_TOWNS = 60;
const MAX_QUERIES = 8;
const MAX_QUERY = 120;
// Social-network queries are dropped; the pattern avoids spelling the name (a repo guard keeps it out of src).
export const SOCIAL = /linked[\s_.-]*in|lnkd/i;

export const profileDef: TaskDef<ProfileLearnInput, Parsed, LearnedProfile> = {
  task: "profile_learn",
  model: MODELS.sonnet,
  promptVersion: P.PROMPT_VERSION,
  system: P.SYSTEM,
  schema: profileSchema,
  effort: "medium",
  maxTokens: 4000,
  buildUser: P.buildUser,
  normalize: (p, input) => {
    const sample = new Set(input.rows.map((r) => r.row));
    const points: LearnedProfile["points"] = [];
    for (const pt of p.points) {
      const rows = [...new Set(pt.rows.filter((n) => Number.isInteger(n) && sample.has(n)))].slice(0, MAX_ROWS);
      const text = cutAtWord(pt.text.replace(/\s+/g, " ").trim(), MAX_TEXT);
      if (rows.length && text) points.push({ key: pt.key, text, rows });
      if (points.length >= MAX_POINTS) break;
    }
    const towns = [...new Set(p.filter.towns.map(townOf).filter((t): t is string => t !== null))].slice(0, MAX_TOWNS);
    const queries = [...new Set(p.search_queries.map((q) => q.replace(/\s+/g, " ").trim()).filter((q) => q && q.length <= MAX_QUERY && !SOCIAL.test(q)))].slice(0, MAX_QUERIES);
    return { points, filter: { companyTypes: [...new Set(p.filter.company_types)], towns }, searchQueries: queries };
  },
};

export function learnProfile(ctx: AiContext, input: ProfileLearnInput): Promise<TaskResult<LearnedProfile>> {
  // What is sent is what can be cited: fit the rows to the wrapper first, in the same stratified order as the sample.
  const rows = sampleRows(input.rows, PROFILE_SAMPLE_MAX, PROFILE_ROWS_BUDGET_CHARS);
  return runTask(ctx, profileDef, { ...input, rows });
}

/** What the "Treinar" button shows; equals what the call reserves. */
export function profileEstimateUsd(): number {
  return reserveFor(profileDef);
}
