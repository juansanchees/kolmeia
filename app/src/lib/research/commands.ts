import { z } from "zod";
import type { RunRow } from "./rows";
import type { ResearchStore } from "./store";
import { DECISIONS, DEFAULT_CAPS, HARD_CEILING, RIGORS, type Answers, type Rigor } from "./types";

// What the user can do to a run. Pure validation + store calls; the server actions wrap these with the session.
// The database trigger re-checks every status change (P4), so a bad call fails there too.

export const newRunSchema = z.object({
  request: z.string().trim().min(1).max(2000),
  region: z.string().trim().min(1).max(1000),
  rigor: z.enum(RIGORS).default("careful"),
});

export function titleFrom(request: string): string {
  const one = request.replace(/\s+/g, " ").trim();
  return one.length <= 80 ? one : `${one.slice(0, 79).trimEnd()}…`;
}

export async function createRun(store: ResearchStore, workspaceId: string, input: z.input<typeof newRunSchema>, setupAgentId?: string): Promise<string> {
  const v = newRunSchema.parse(input);
  const caps = DEFAULT_CAPS[v.rigor];
  return store.createRun({
    workspaceId,
    title: titleFrom(v.request),
    requestText: v.request,
    regionText: v.region,
    rigor: v.rigor,
    maxCandidates: caps.maxCandidates,
    maxCostUsd: caps.maxCostUsd,
    maxMinutes: caps.maxMinutes,
    ...(setupAgentId ? { setupAgentId } : {}),
  });
}

/** Keeps only answers to questions that were asked, with options that were offered (R15: no free-form keys). */
export function cleanAnswers(run: Pick<RunRow, "questions">, raw: Answers): Answers {
  const out: Answers = {};
  for (const q of run.questions ?? []) {
    const a = raw[q.id];
    if (!a) continue;
    out[q.id] = {
      choices: a.choices.filter((c) => q.options.includes(c)).slice(0, 4),
      text: q.allowFreeText ? a.text.trim().slice(0, 500) : "",
    };
  }
  return out;
}

export async function submitAnswers(store: ResearchStore, run: RunRow, raw: Answers, region?: string) {
  if (run.status !== "questions" || run.questions === null) throw new Error("not waiting for answers");
  const regionText = region?.trim();
  await store.updateRun(run.id, {
    answers: cleanAnswers(run, raw),
    ...(regionText && regionText.length <= 1000 ? { region_text: regionText } : {}),
    status: "plan",
    plan: null,
  });
}

export const adjustmentSchema = z.string().trim().min(1).max(500);

/** "Ajustar": the text joins the adjustments and the plan is written again. */
export async function adjustPlan(store: ResearchStore, run: RunRow, text: string, region?: string) {
  if (run.status !== "plan") throw new Error("not in plan");
  const adj = adjustmentSchema.parse(text);
  const regionText = region?.trim();
  await store.updateRun(run.id, {
    adjustments: [...run.adjustments, adj].slice(-10),
    ...(regionText && regionText.length <= 1000 ? { region_text: regionText } : {}),
    plan: null,
  });
}

export const approveSchema = z.object({
  rigor: z.enum(RIGORS),
  maxCandidates: z.coerce.number().int().min(1).max(HARD_CEILING.maxCandidates),
  maxCostUsd: z.coerce.number().positive().max(HARD_CEILING.maxCostUsd),
});

/** P4: approving is the only way to "ready"; the next advance starts the search. */
export async function approvePlan(store: ResearchStore, run: RunRow, input: z.input<typeof approveSchema>) {
  if (run.status !== "plan" || !run.plan) throw new Error("no plan to approve");
  const v = approveSchema.parse(input);
  await store.updateRun(run.id, {
    rigor: v.rigor as Rigor,
    max_candidates: v.maxCandidates,
    max_cost_usd: Math.round(v.maxCostUsd * 100) / 100,
    max_minutes: DEFAULT_CAPS[v.rigor].maxMinutes,
    status: "ready",
  });
}

export async function pauseRun(store: ResearchStore, run: RunRow) {
  if (run.status !== "running") return;
  await store.updateRun(run.id, { status: "paused", progress: { ...run.progress, pauseReason: "user" } });
}

export async function resumeRun(store: ResearchStore, run: RunRow) {
  if (run.status !== "paused") return;
  const progress = { ...run.progress };
  delete progress.pauseReason;
  await store.updateRun(run.id, { status: "running", progress });
}

export async function cancelRun(store: ResearchStore, run: RunRow) {
  if (!["questions", "plan", "ready", "running", "paused"].includes(run.status)) return;
  await store.updateRun(run.id, { status: "cancelled", finished_at: new Date().toISOString() });
}

/** Finding 13: only these three run controls exist; anything else is refused (it used to fall through to "cancel"). */
export const controlActionSchema = z.enum(["pause", "resume", "cancel"]);

export const decisionSchema = z.enum(DECISIONS);
export const listNameSchema = z.string().trim().min(1).max(120);
