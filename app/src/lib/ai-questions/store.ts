import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getLead } from "@/lib/leads/queries";
import { displayOf } from "@/lib/leads/view";
import type { AnswerStore, Claimed, Finished, LeadData } from "./run";
import { QUESTION_COLUMNS, type AiCell, type AiQuestion } from "./types";

// The AI-question rows, read and written as the logged-in sender (RLS 0029).

/** A claim older than this is free again (a tab closed mid-step); matches the migration's comment. */
const CLAIM_MS = 10 * 60_000;
const PAGE = 1000;
const ANSWERS_MAX = 20_000;

export class SupabaseAnswerStore implements AnswerStore {
  constructor(
    private readonly db: SupabaseClient,
    private readonly now: () => number = Date.now,
  ) {}

  async claim(questionId: string, limit: number, leadIds?: string[]): Promise<Claimed[]> {
    const stale = new Date(this.now() - CLAIM_MS).toISOString();
    let q = this.db.from("ai_answers").select("id, lead_id").eq("question_id", questionId).eq("status", "queued").or(`claimed_at.is.null,claimed_at.lt.${stale}`);
    if (leadIds) q = q.in("lead_id", leadIds);
    const { data, error } = await q.order("created_at", { ascending: true }).limit(limit);
    if (error) throw new Error(`claim: ${error.message}`);
    const out: Claimed[] = [];
    for (const r of (data ?? []) as { id: string; lead_id: string }[]) {
      // conditional update: a row another tab took in between comes back empty
      const { data: got } = await this.db
        .from("ai_answers")
        .update({ claimed_at: new Date(this.now()).toISOString() })
        .eq("id", r.id)
        .eq("status", "queued")
        .or(`claimed_at.is.null,claimed_at.lt.${stale}`)
        .select("id");
      if (got?.length) out.push({ id: r.id, leadId: r.lead_id });
    }
    return out;
  }

  async leadData(leadId: string): Promise<LeadData | null> {
    const d = await getLead(this.db, leadId);
    if (!d) return null;
    const best = d.candidates.find((c) => c.id === d.lead.best_candidate_id) ?? d.candidates[0] ?? null;
    const shown = displayOf(best, d.fields);
    return {
      company: shown.name,
      website: shown.website,
      fields: d.fields,
      best,
      evidence: d.checks.filter((k) => k.result === "ok" && k.candidate_id === best?.id).flatMap((k) => k.evidence.map((e) => ({ url: e.url, title: e.title ?? null, excerpt: e.excerpt ?? null }))),
    };
  }

  async finish(id: string, r: Finished): Promise<void> {
    const { error } = await this.db
      .from("ai_answers")
      .update({
        status: r.status,
        answer: r.answer,
        evidence_url: r.evidence?.url ?? null,
        evidence_excerpt: r.evidence?.excerpt ?? null,
        evidence_label: r.evidence?.label ?? null,
        cost_usd: r.costUsd,
        error: r.error,
        claimed_at: null,
      })
      .eq("id", id);
    if (error) throw new Error(`finish: ${error.message}`);
  }

  async release(id: string): Promise<void> {
    await this.db.from("ai_answers").update({ claimed_at: null }).eq("id", id);
  }

  async countQueued(questionId: string): Promise<number> {
    const { count, error } = await this.db.from("ai_answers").select("id", { count: "exact", head: true }).eq("question_id", questionId).eq("status", "queued");
    if (error) throw new Error(`countQueued: ${error.message}`);
    return count ?? 0;
  }
}

export async function getQuestion(db: SupabaseClient, id: string): Promise<AiQuestion | null> {
  const { data, error } = await db.from("ai_questions").select(QUESTION_COLUMNS).eq("id", id).is("archived_at", null).maybeSingle();
  if (error) throw new Error(`getQuestion: ${error.message}`);
  return (data as AiQuestion | null) ?? null;
}

/** The workspace's open questions, newest first. */
export async function listQuestions(db: SupabaseClient, workspaceId: string): Promise<AiQuestion[]> {
  const { data, error } = await db.from("ai_questions").select(QUESTION_COLUMNS).eq("workspace_id", workspaceId).is("archived_at", null).order("created_at", { ascending: false }).limit(20);
  if (error) throw new Error(`listQuestions: ${error.message}`);
  return (data ?? []) as AiQuestion[];
}

/** Every answer the user may read for these questions, as lead id -> question id -> cell (RLS: the closer's leads only). */
export async function listAnswers(db: SupabaseClient, workspaceId: string, questionIds: string[]): Promise<Map<string, Record<string, AiCell>>> {
  const out = new Map<string, Record<string, AiCell>>();
  if (questionIds.length === 0) return out;
  for (let from = 0; from < ANSWERS_MAX; from += PAGE) {
    const { data, error } = await db
      .from("ai_answers")
      .select("id, question_id, lead_id, status, answer, evidence_url, evidence_excerpt, evidence_label")
      .eq("workspace_id", workspaceId)
      .in("question_id", questionIds)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`listAnswers: ${error.message}`);
    const rows = (data ?? []) as { question_id: string; lead_id: string; status: AiCell["status"]; answer: string | null; evidence_url: string | null; evidence_excerpt: string | null; evidence_label: string | null }[];
    for (const r of rows) {
      const cells = out.get(r.lead_id) ?? {};
      cells[r.question_id] = { status: r.status, answer: r.answer, url: r.evidence_url, excerpt: r.evidence_excerpt, label: r.evidence_label };
      out.set(r.lead_id, cells);
    }
    if (rows.length < PAGE) break;
  }
  return out;
}
