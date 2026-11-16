import "server-only";
import { isAiError, STOP_CODES, type AiErrorCode } from "@/lib/ai/errors";
import type { AiContext } from "@/lib/ai/gateway";
import { answerLeadQuestion, type AnswerInput, type AnswerOut } from "@/lib/ai/lead-ai-tasks";
import type { LeadFieldRow } from "@/lib/leads/types";
import { readSite, type SiteDeps } from "@/lib/qualifier/site/reader";
import type { CandidateRow } from "@/lib/research/rows";
import { sanitizeUrl } from "@/lib/safe-url";
import type { AiQuestion } from "./types";

// Runs "Pergunta da IA para cada lead" one bounded step at a time (the open page calls it again while rows are queued;
// no background worker). Each lead: build its sources (stored data, its own site read robots-aware), one Haiku call in
// the clicking user's ledger, store the answer with its evidence. A cap stops the batch and gives the rows back.

/** What the app already knows about a lead, as the user may read it (RLS). */
export type LeadData = {
  company: string;
  website: string | null;
  fields: Pick<LeadFieldRow, "field" | "value" | "source" | "source_ref" | "status" | "excerpt">[];
  best: Pick<CandidateRow, "hook" | "notes" | "size_note" | "company_type" | "permit_count" | "total_value_usd" | "last_permit_date" | "biggest_job_address" | "biggest_job_type" | "biggest_job_value_usd" | "biggest_job_description" | "found_at_url" | "found_at_excerpt"> | null;
  evidence: { url: string; title: string | null; excerpt: string | null }[];
};

export type Claimed = { id: string; leadId: string };
export type Finished = { status: "done" | "failed"; answer: string | null; evidence: AnswerOut["evidence"]; costUsd: number; error: string | null };

export interface AnswerStore {
  claim(questionId: string, limit: number, leadIds?: string[]): Promise<Claimed[]>;
  leadData(leadId: string): Promise<LeadData | null>;
  finish(id: string, r: Finished): Promise<void>;
  /** Back to the queue untouched (a cap stopped the batch before this row was paid for). */
  release(id: string): Promise<void>;
  countQueued(questionId: string): Promise<number>;
}

export type StepDeps = { store: AnswerStore; ai: AiContext; site: SiteDeps | null };
export type StepResult = { done: number; remaining: number; stop: AiErrorCode | null; answers: { leadId: string; answer: string | null; status: Finished["status"] }[] };

const PAGE_CHARS = 6000;
const MAX_SOURCES = 24;
const isUrl = (s: string | null | undefined) => (s ? sanitizeUrl(s) : null);
const usd = (n: number | null) => (n === null ? null : `US$ ${Math.round(n).toLocaleString("en-US")}`);

/** The sources a question may read for one lead, numbered. Stored data first, then the lead's own pages. */
export function dataSources(d: LeadData): AnswerInput["sources"] {
  const out: AnswerInput["sources"] = [];
  const push = (label: string, text: string | null | undefined, url: string | null = null) => {
    const t = text?.replace(/\s+/g, " ").trim();
    if (t && out.length < MAX_SOURCES) out.push({ ref: `d${out.length + 1}`, label, url: isUrl(url), text: t.slice(0, 1200) });
  };
  const b = d.best;
  if (b) {
    push("pesquisa: gancho", b.hook, b.found_at_url);
    push("pesquisa: onde achamos", b.found_at_excerpt, b.found_at_url);
    push("pesquisa: tipo", b.company_type ? `company type: ${b.company_type}` : null);
    push("pesquisa: porte", b.size_note);
    if ((b.permit_count ?? 0) > 0) push("pesquisa: alvarás", [`${b.permit_count} permits`, usd(b.total_value_usd) && `total ${usd(b.total_value_usd)}`, b.last_permit_date && `last ${b.last_permit_date}`].filter(Boolean).join(", "));
    if (b.biggest_job_address) push("pesquisa: maior obra", [b.biggest_job_address, b.biggest_job_type, usd(b.biggest_job_value_usd), b.biggest_job_description].filter(Boolean).join(" · "));
    push("pesquisa: notas", b.notes);
  }
  for (const e of d.evidence) push(`prova: ${e.title ?? "página"}`, e.excerpt, e.url);
  for (const f of d.fields) {
    if (f.status === "refuted" || f.source === "pattern") continue;
    push(`dado do lead: ${f.field} (${f.source})`, `${f.field}: ${f.value}${f.excerpt ? ` — ${f.excerpt}` : ""}`, f.source_ref);
  }
  return out;
}

async function sourcesFor(q: AiQuestion, d: LeadData, site: SiteDeps | null): Promise<AnswerInput["sources"]> {
  const out = q.sources.includes("data") ? dataSources(d) : [];
  if (q.sources.includes("site") && d.website && site) {
    const read = await readSite(d.website, site);
    if (read.outcome === "ok") {
      read.pages.forEach((p, n) => out.push({ ref: `s${n + 1}`, label: "site do lead", url: isUrl(p.url), text: p.text.replace(/\s+/g, " ").slice(0, PAGE_CHARS) }));
    }
  }
  return out;
}

/** One lead: no source at all is "Não sei" without spending anything. */
export async function answerOne(q: AiQuestion, d: LeadData, deps: Pick<StepDeps, "ai" | "site">): Promise<Finished> {
  const sources = await sourcesFor(q, d, deps.site);
  if (sources.length === 0) return { status: "done", answer: "unknown", evidence: null, costUsd: 0, error: null };
  const r = await answerLeadQuestion(deps.ai, { question: q.question, answerType: q.answer_type, company: d.company, sources });
  return { status: "done", answer: r.data.answer, evidence: r.data.evidence, costUsd: r.costUsd, error: null };
}

export async function runAnswerStep(deps: StepDeps, q: AiQuestion, opts: { limit: number; leadIds?: string[] }): Promise<StepResult> {
  const rows = await deps.store.claim(q.id, opts.limit, opts.leadIds);
  const res: StepResult = { done: 0, remaining: 0, stop: null, answers: [] };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let out: Finished;
    try {
      const data = await deps.store.leadData(row.leadId);
      out = data ? await answerOne(q, data, deps) : { status: "failed", answer: null, evidence: null, costUsd: 0, error: "lead_gone" };
    } catch (e) {
      const code = isAiError(e) ? e.code : null;
      if (code && STOP_CODES.has(code)) {
        // a cap (or no access): nothing more is paid for; this row and the rest go back to the queue
        for (const r of rows.slice(i)) await deps.store.release(r.id).catch(() => undefined);
        res.stop = code;
        break;
      }
      out = { status: "failed", answer: null, evidence: null, costUsd: 0, error: code ?? "error" };
    }
    await deps.store.finish(row.id, out);
    res.done++;
    res.answers.push({ leadId: row.leadId, answer: out.answer, status: out.status });
  }
  res.remaining = await deps.store.countQueued(q.id);
  return res;
}
