"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { AiErrorCode } from "@/lib/ai/errors";
import { defaultTransport } from "@/lib/ai/gateway";
import { sessionLedger } from "@/lib/ai/session-ledger";
import { runAnswerStep, type StepResult } from "@/lib/ai-questions/run";
import { getQuestion, SupabaseAnswerStore } from "@/lib/ai-questions/store";
import { ANSWER_TYPES, QUESTION_MAX, QUESTION_SOURCES, RUN_MAX, TEST_LEADS } from "@/lib/ai-questions/types";
import { nodeRawHttp } from "@/lib/qualifier/site/net";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { t } from "@/messages/pt";

// "Pergunta da IA para cada lead": owner/sdr only, every write as the user (RLS 0029), every AI call in the user's
// ledger (caps and allowlist in reserve_ai_call). The page drives the batch one bounded step at a time.

const A = t.leads.aiQuestion;
const uuid = z.string().uuid();
const STEP_LEADS = 2;
/** One step's site read per lead and AI call deadline (well inside the page's maxDuration of 300 s). */
const SITE_MS = 20_000;
const AI_MS = 30_000;

const AI_TEXT: Partial<Record<AiErrorCode, string>> = {
  not_configured: t.ai.notConfigured,
  no_access: t.ai.noAccess,
  daily_cap: t.ai.dailyCap,
  user_cap: t.ai.userCap,
  global_cap: t.ai.globalCap,
  refused: t.ai.refused,
};

const createSchema = z.object({
  question: z.string().trim().min(3).max(QUESTION_MAX),
  answerType: z.enum(ANSWER_TYPES),
  sources: z.array(z.enum(QUESTION_SOURCES)).min(1).max(2),
});

export type QuestionResult = { ok: true; id: string } | { ok: false; error: string };

export async function createQuestionAction(input: z.input<typeof createSchema>): Promise<QuestionResult> {
  const ws = await requireSender();
  const p = createSchema.safeParse(input);
  if (!p.success) return { ok: false, error: p.error.issues.some((i) => i.path[0] === "sources") ? A.pickSource : A.tooLong };
  const db = await createClient();
  if (!db) return { ok: false, error: A.failed };
  const { data, error } = await db
    .from("ai_questions")
    .insert({ workspace_id: ws.id, question: p.data.question, answer_type: p.data.answerType, sources: [...new Set(p.data.sources)] })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: A.failed };
  revalidatePath("/leads");
  return { ok: true, id: data.id as string };
}

export async function archiveQuestionAction(questionId: string): Promise<{ ok: boolean }> {
  const ws = await requireSender();
  const db = await createClient();
  if (!db || !uuid.safeParse(questionId).success) return { ok: false };
  const { error } = await db.from("ai_questions").update({ archived_at: new Date().toISOString() }).eq("id", questionId).eq("workspace_id", ws.id);
  revalidatePath("/leads");
  return { ok: !error };
}

/** Queues leads that have no answer yet; failed ones (and, for a test, finished ones too) go back to the queue. */
async function enqueue(db: NonNullable<Awaited<ReturnType<typeof createClient>>>, wsId: string, questionId: string, leadIds: string[], redo: boolean): Promise<boolean> {
  const { error } = await db
    .from("ai_answers")
    .upsert(
      leadIds.map((lead_id) => ({ workspace_id: wsId, question_id: questionId, lead_id, status: "queued" })),
      { onConflict: "question_id,lead_id", ignoreDuplicates: true },
    );
  if (error) return false;
  const { error: e2 } = await db
    .from("ai_answers")
    .update({ status: "queued", answer: null, evidence_url: null, evidence_excerpt: null, evidence_label: null, error: null, claimed_at: null })
    .eq("question_id", questionId)
    .in("lead_id", leadIds)
    .in("status", redo ? ["failed", "done", "skipped"] : ["failed"]);
  return !e2;
}

export type StepOut = { ok: true; result: StepResult; stopText: string | null } | { ok: false; error: string };

async function step(questionId: string, limit: number, leadIds?: string[]): Promise<StepOut> {
  const ws = await requireSender();
  const db = await createClient();
  if (!db || !uuid.safeParse(questionId).success) return { ok: false, error: A.failed };
  const q = await getQuestion(db, questionId).catch(() => null);
  if (!q) return { ok: false, error: A.failed };
  try {
    const result = await runAnswerStep(
      {
        store: new SupabaseAnswerStore(db),
        ai: { workspaceId: ws.id, runId: null, ledger: sessionLedger(db), transport: defaultTransport(), deadlineMs: AI_MS },
        site: { http: nodeRawHttp, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now, gaps: new Map(), totalMs: SITE_MS },
      },
      q,
      { limit, leadIds },
    );
    revalidatePath("/leads");
    return { ok: true, result, stopText: result.stop ? (AI_TEXT[result.stop] ?? t.ai.generic) : null };
  } catch {
    return { ok: false, error: A.failed };
  }
}

/** "Testar em 3": answers up to 3 leads now (re-answering them), so the person checks before a batch. */
export async function testQuestionAction(questionId: string, leadIds: string[]): Promise<StepOut> {
  const ws = await requireSender();
  const ids = z.array(uuid).min(1).max(TEST_LEADS).safeParse(leadIds);
  const db = await createClient();
  if (!db || !ids.success || !uuid.safeParse(questionId).success) return { ok: false, error: A.noLeads };
  if (!(await enqueue(db, ws.id, questionId, ids.data, true))) return { ok: false, error: A.failed };
  return step(questionId, TEST_LEADS, ids.data);
}

/** "Rodar em N": queues the leads; the page then calls stepQuestionAction while rows remain. */
export async function enqueueQuestionAction(questionId: string, leadIds: string[]): Promise<{ ok: boolean; error?: string }> {
  const ws = await requireSender();
  const ids = z.array(uuid).min(1).max(RUN_MAX).safeParse(leadIds);
  const db = await createClient();
  if (!db || !ids.success || !uuid.safeParse(questionId).success) return { ok: false, error: A.noLeads };
  return (await enqueue(db, ws.id, questionId, ids.data, false)) ? { ok: true } : { ok: false, error: A.failed };
}

export async function stepQuestionAction(questionId: string): Promise<StepOut> {
  return step(questionId, STEP_LEADS);
}
