import "server-only";
import { z } from "zod";
import { townOf } from "@/lib/coverage/region";
import { sampleResults, type ResultRow } from "@/lib/learning/results";
import { LIST_POINT_KEYS, type LearnedProfile } from "@/lib/profile/types";
import { COMPANY_TYPES, type CompanyType } from "@/lib/research/types";
import { fill, t } from "@/messages/pt";
import { reserveFor, runTask, type AiContext, type TaskDef, type TaskResult } from "./gateway";
import { MODELS } from "./models";
import { cutAtWord, SOCIAL } from "./profile-tasks";
import * as P from "./prompts/profile-results";
import type { ProfileResultsInput } from "./prompts/profile-results";

// "Aprender com os resultados": one Sonnet call, no web tools, the results as untrusted data. Ledger task
// "profile_learn" (the same spend line as the list training). Only a proposal comes out; a sender approves it.

const filterSchema = z.object({ company_types: z.array(z.enum(COMPANY_TYPES)), towns: z.array(z.string()) });
export const resultsSchema = z.object({
  points: z.array(z.object({ key: z.enum(LIST_POINT_KEYS), text: z.string(), rows: z.array(z.number()) })),
  avoid: z.array(z.object({ text: z.string(), rows: z.array(z.number()) })),
  favor: filterSchema,
  avoid_filter: filterSchema,
  search_queries: z.array(z.string()),
  /** Numbers (1 = first) of the current profile's points that the results contradict; every other one is carried over. */
  contradicted: z.array(z.number()),
});
type Parsed = z.infer<typeof resultsSchema>;

const MAX_POINTS = 12; // learned_profile_valid
const MAX_FAVOR = 8;
const MAX_AVOID = 4;
const MAX_ROWS = 20;
const MAX_TOWNS = 60;
const MAX_QUERIES = 8;
const MAX_QUERY = 120;

const text = (s: string) => cutAtWord(s.replace(/\s+/g, " ").trim(), 200);
const uniq = <T>(xs: T[]) => [...new Set(xs)];

export const resultsDef: TaskDef<ProfileResultsInput, Parsed, LearnedProfile> = {
  task: "profile_learn",
  model: MODELS.sonnet,
  promptVersion: P.PROMPT_VERSION,
  system: P.SYSTEM,
  schema: resultsSchema,
  effort: "medium",
  maxTokens: 4000,
  buildUser: P.buildUser,
  normalize: (p, input) => {
    const good = new Set(input.samples.filter((s) => s.good).map((s) => s.n));
    const badRows = input.samples.filter((s) => !s.good);
    const bad = new Set(badRows.map((s) => s.n));
    const cite = (rows: number[], from: Set<number>) => uniq(rows.filter((n) => Number.isInteger(n) && from.has(n))).slice(0, MAX_ROWS);

    const points: LearnedProfile["points"] = [];
    for (const pt of p.points) {
      const rows = cite(pt.rows, good);
      const x = text(pt.text);
      if (rows.length && x && points.length < MAX_FAVOR) points.push({ key: pt.key, text: x, rows });
    }

    // avoid towns/types: kept only when a bad row of the sample shows them (its rows are the citation)
    const avoidTowns = uniq(p.avoid_filter.towns.map(townOf).filter((x): x is string => x !== null)).filter((town) => badRows.some((s) => townOf(s.row.city) === town));
    const avoidTypes = uniq(p.avoid_filter.company_types).filter((ct) => badRows.some((s) => s.row.company_type === ct));
    const avoid: LearnedProfile["points"] = [];
    if (avoidTowns.length) avoid.push({ key: "avoid", text: text(fill(t.profile.avoidTowns, { towns: avoidTowns.join(", ") })), rows: badRows.filter((s) => avoidTowns.includes(townOf(s.row.city) ?? "")).map((s) => s.n).slice(0, MAX_ROWS) });
    if (avoidTypes.length) avoid.push({ key: "avoid", text: text(fill(t.profile.avoidTypes, { types: avoidTypes.map((ct) => t.profile.types[ct]).join(", ") })), rows: badRows.filter((s) => avoidTypes.includes(s.row.company_type as CompanyType)).map((s) => s.n).slice(0, MAX_ROWS) });
    for (const a of p.avoid) {
      const rows = cite(a.rows, bad);
      const x = text(a.text);
      if (rows.length && x) avoid.push({ key: "avoid", text: x, rows });
    }

    const towns = uniq(p.favor.towns.map(townOf).filter((x): x is string => x !== null)).filter((x) => !avoidTowns.includes(x)).slice(0, MAX_TOWNS);
    const queries = uniq(p.search_queries.map((q) => q.replace(/\s+/g, " ").trim()).filter((q) => q && q.length <= MAX_QUERY && !SOCIAL.test(q))).slice(0, MAX_QUERIES);
    // the approved profile's points stay (marked, with their own citations) unless the model names them as contradicted
    const dropped = new Set(p.contradicted);
    const carried = (input.current?.points ?? []).filter((_, i) => !dropped.has(i + 1)).map((x) => ({ ...x, carried: true as const }));
    const kept = avoid.slice(0, MAX_AVOID);
    return {
      points: [...[...carried, ...points].slice(0, MAX_POINTS - kept.length), ...kept],
      filter: { companyTypes: uniq(p.favor.company_types).filter((ct) => !avoidTypes.includes(ct)), towns },
      searchQueries: queries,
    };
  },
};

/** Samples the rows (good and bad in turns, fitted to the wrapper) and makes the one call. */
export function learnFromResults(ctx: AiContext, rows: ResultRow[], current: LearnedProfile | null): Promise<TaskResult<LearnedProfile> & { sampleRows: number }> {
  const samples = sampleResults(rows);
  return runTask(ctx, resultsDef, { samples, current }).then((r) => ({ ...r, sampleRows: samples.length }));
}

/** What the button shows; equals what the call reserves. */
export function resultsEstimateUsd(): number {
  return reserveFor(resultsDef);
}
