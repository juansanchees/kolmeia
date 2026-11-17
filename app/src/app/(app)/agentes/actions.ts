"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { FormState } from "@/lib/form-state";
import {
  adjustmentSchema,
  adjustPlan,
  approvePlan,
  cancelRun,
  controlActionSchema,
  createRun,
  decisionSchema,
  listNameSchema,
  newRunSchema,
  pauseRun,
  resumeRun,
  submitAnswers,
} from "@/lib/research/commands";
import { researchSession } from "@/lib/research/session";
import type { Answers } from "@/lib/research/types";
import { getT } from "@/lib/i18n/server";

const uuid = z.string().uuid();

async function loadRun(runId: string) {
  const s = await researchSession();
  if (!s || !uuid.safeParse(runId).success) return null;
  const run = await s.store.getRun(runId); // RLS: only runs of the user's workspaces
  return run ? { ...s, run } : null;
}

export async function createResearch(_prev: FormState, formData: FormData): Promise<FormState> {
  const t = await getT();
  const M = t.research;
  const parsed = newRunSchema.safeParse({
    request: formData.get("request") ?? "",
    region: formData.get("region") ?? "",
    rigor: "careful",
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of parsed.error.issues) {
      if (i.path[0] === "request") fieldErrors.request = M.newForm.errors.request;
      if (i.path[0] === "region") fieldErrors.region = M.newForm.errors.region;
    }
    return { status: "error", fieldErrors };
  }
  const s = await researchSession();
  if (!s) return { status: "error", message: M.newForm.errors.generic };
  let id: string;
  try {
    id = await createRun(s.store, s.workspace.id, parsed.data);
  } catch {
    return { status: "error", message: M.newForm.errors.generic };
  }
  revalidatePath("/agentes", "layout");
  redirect(`/agentes/pesquisa/${id}`);
}

const answersSchema = z.record(
  z.string().max(40),
  z.object({ choices: z.array(z.string().max(80)).max(4), text: z.string().max(500) }),
);

export async function answerQuestions(runId: string, answers: Answers, region: string): Promise<FormState> {
  const t = await getT();
  const M = t.research;
  const ctx = await loadRun(runId);
  const parsed = answersSchema.safeParse(answers);
  if (!ctx || !parsed.success) return { status: "error", message: M.plan.errors.generic };
  try {
    await submitAnswers(ctx.store, ctx.run, parsed.data, region);
  } catch {
    return { status: "error", message: M.plan.errors.generic };
  }
  revalidatePath(`/agentes/pesquisa/${runId}`);
  revalidatePath("/agentes", "layout");
  return { status: "success" };
}

export async function adjustResearch(runId: string, text: string, region?: string): Promise<FormState> {
  const t = await getT();
  const M = t.research;
  const ctx = await loadRun(runId);
  if (!ctx) return { status: "error", message: M.plan.errors.generic };
  if (!adjustmentSchema.safeParse(text).success) {
    return { status: "error", message: M.plan.errors.adjust };
  }
  try {
    await adjustPlan(ctx.store, ctx.run, text, region);
  } catch {
    return { status: "error", message: M.plan.errors.adjust };
  }
  revalidatePath(`/agentes/pesquisa/${runId}`);
  revalidatePath("/agentes", "layout");
  return { status: "success" };
}

export async function approveResearch(runId: string, input: { rigor: string; maxCandidates: number; maxCostUsd: number }): Promise<FormState> {
  const t = await getT();
  const M = t.research;
  const ctx = await loadRun(runId);
  if (!ctx) return { status: "error", message: M.plan.errors.generic };
  try {
    await approvePlan(ctx.store, ctx.run, input as never);
  } catch (e) {
    return { status: "error", message: e instanceof z.ZodError ? M.plan.errors.caps : M.plan.errors.generic };
  }
  revalidatePath(`/agentes/pesquisa/${runId}`);
  revalidatePath("/agentes", "layout");
  return { status: "success" };
}

export async function controlResearch(runId: string, action: "pause" | "resume" | "cancel"): Promise<FormState> {
  const t = await getT();
  const M = t.research;
  const parsed = controlActionSchema.safeParse(action);
  if (!parsed.success) return { status: "error", message: M.plan.errors.generic };
  const ctx = await loadRun(runId);
  if (!ctx) return { status: "error", message: M.plan.errors.generic };
  try {
    if (parsed.data === "pause") await pauseRun(ctx.store, ctx.run);
    else if (parsed.data === "resume") await resumeRun(ctx.store, ctx.run);
    else await cancelRun(ctx.store, ctx.run);
  } catch {
    return { status: "error", message: M.plan.errors.generic };
  }
  revalidatePath(`/agentes/pesquisa/${runId}`);
  revalidatePath("/agentes", "layout");
  return { status: "success" };
}

export async function setDecision(runId: string, candidateId: string, decision: string): Promise<FormState> {
  const t = await getT();
  const M = t.research;
  const s = await researchSession();
  const d = decisionSchema.safeParse(decision);
  if (!s || !d.success || !uuid.safeParse(candidateId).success) return { status: "error", message: M.list.decisionError };
  try {
    await s.store.updateCandidate(candidateId, { user_decision: d.data });
  } catch {
    return { status: "error", message: M.list.decisionError };
  }
  revalidatePath(`/agentes/pesquisa/${runId}`);
  return { status: "success" };
}

export async function createResearchList(runId: string, name: string): Promise<FormState> {
  const t = await getT();
  const M = t.research;
  const ctx = await loadRun(runId);
  const n = listNameSchema.safeParse(name);
  if (!ctx || !n.success) return { status: "error", message: M.list.listError };
  try {
    await ctx.store.createList(runId, n.data);
  } catch (e) {
    return { status: "error", message: e instanceof Error && /P3/.test(e.message) ? M.list.listNeedsKeep : M.list.listError };
  }
  return { status: "success", message: M.list.listCreated };
}
