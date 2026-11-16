import { describe, expect, test, vi } from "vitest";
import type { AiContext, AiLedger } from "@/lib/ai/gateway";
import type { AiQuestion } from "@/lib/ai-questions/types";
import { matchesAnswer } from "@/lib/ai-questions/types";
import { DEFAULT_LEAD_FILTERS, filterLeads, parseLeadFilters } from "@/lib/leads/view";
import type { LeadListItem, LeadRow } from "@/lib/leads/types";
import { FakeTransport } from "../engine/fake-ai";

vi.mock("server-only", () => ({}));
const { checkAnswer, normalizeAnswer, answerDef } = await import("@/lib/ai/lead-ai-tasks");
const { runAnswerStep } = await import("@/lib/ai-questions/run");
const { AiError } = await import("@/lib/ai/errors");
const { MODELS } = await import("@/lib/ai/models");
type Store = import("@/lib/ai-questions/run").AnswerStore;
type LeadData = import("@/lib/ai-questions/run").LeadData;

// Fase 3 item 9: "Pergunta da IA para cada lead". The AI is faked (no network); the site is never read here.
const Q: AiQuestion = { id: "q1", question: "Faz obra multifamiliar?", answer_type: "yes_no_unknown", sources: ["data"], created_at: "" };
const SRC = [{ ref: "d1", label: "pesquisa: gancho", url: "https://acme.example/projects", text: "We build multi-family developments across Greater Boston." }];
const INPUT = { question: Q.question, answerType: "yes_no_unknown" as const, company: "Acme", sources: SRC };

describe("answer rules", () => {
  test("an answer is kept only with a quote written in the cited source; otherwise it is 'unknown'", () => {
    expect(checkAnswer({ answer: "yes", source_ref: "d1", quote: "multi-family developments" }, INPUT)).toEqual({
      answer: "yes",
      evidence: { url: "https://acme.example/projects", excerpt: "multi-family developments", label: "pesquisa: gancho" },
    });
    expect(checkAnswer({ answer: "yes", source_ref: "d1", quote: "we build condos in Cambridge" }, INPUT)).toEqual({ answer: "unknown", evidence: null });
    expect(checkAnswer({ answer: "yes", source_ref: "d9", quote: "multi-family developments" }, INPUT)).toEqual({ answer: "unknown", evidence: null });
    expect(checkAnswer({ answer: "yes", source_ref: "d1", quote: "We" }, INPUT)).toEqual({ answer: "unknown", evidence: null });
  });
  test("answers are normalized per type", () => {
    expect(normalizeAnswer("Sim", "yes_no_unknown")).toBe("yes");
    expect(normalizeAnswer("Não", "yes_no_unknown")).toBe("no");
    expect(normalizeAnswer("maybe", "yes_no_unknown")).toBe("unknown");
    expect(normalizeAnswer("4", "score_1_5")).toBe("4");
    expect(normalizeAnswer("7", "score_1_5")).toBe("unknown");
    expect(normalizeAnswer("Não sei", "short_text")).toBe("unknown");
    expect(normalizeAnswer("  prédios   novos ", "short_text")).toBe("prédios novos");
  });
  test("the cheapest model, no web tools, its own ledger task", () => {
    expect(answerDef).toMatchObject({ model: MODELS.haiku, task: "ai_answer" });
    expect(answerDef.web).toBeUndefined();
  });
});

function fakeStore(rows: string[], data: (id: string) => LeadData | null) {
  const finished: { id: string; status: string; answer: string | null; evidence: unknown }[] = [];
  const released: string[] = [];
  const store: Store = {
    claim: async (_q, limit) => rows.slice(0, limit).map((leadId, i) => ({ id: `a${i}`, leadId })),
    leadData: async (id) => data(id),
    finish: async (id, r) => {
      finished.push({ id, status: r.status, answer: r.answer, evidence: r.evidence });
    },
    release: async (id) => {
      released.push(id);
    },
    countQueued: async () => rows.length - finished.length,
  };
  return { store, finished, released };
}
const lead = (hook: string | null): LeadData => ({
  company: "Acme",
  website: null,
  fields: [],
  best: hook ? ({ hook, found_at_url: "https://acme.example/projects" } as LeadData["best"]) : null,
  evidence: [],
});
function ctx(transport: FakeTransport, reserve: AiLedger["reserve"]): AiContext {
  const ledger: AiLedger = { dailyCapUsd: async () => 10, spentTodayUsd: async () => 0, record: async () => undefined, reserve, settle: async () => undefined };
  return { workspaceId: "ws-1", runId: null, ledger, transport };
}

describe("runAnswerStep", () => {
  test("an AI answer without evidence is stored as unknown, with no evidence", async () => {
    const t = new FakeTransport({ ai_answer: () => ({ json: { answer: "yes", source_ref: "d1", quote: "they build hospitals" } }) });
    const s = fakeStore(["l1"], () => lead("We build multi-family developments."));
    const r = await runAnswerStep({ store: s.store, ai: ctx(t, async () => "c1"), site: null }, Q, { limit: 3 });
    expect(r).toMatchObject({ done: 1, stop: null });
    expect(s.finished).toEqual([{ id: "a0", status: "done", answer: "unknown", evidence: null }]);
    expect(t.calls[0].user).toMatch(/<untrusted_sources>[\s\S]*multi-family/);
  });
  test("a supported answer keeps its excerpt", async () => {
    const t = new FakeTransport({ ai_answer: () => ({ json: { answer: "yes", source_ref: "d1", quote: "multi-family developments" } }) });
    const s = fakeStore(["l1"], () => lead("We build multi-family developments."));
    await runAnswerStep({ store: s.store, ai: ctx(t, async () => "c1"), site: null }, Q, { limit: 3 });
    expect(s.finished[0]).toMatchObject({ answer: "yes", evidence: { excerpt: "multi-family developments" } });
  });
  test("a lead with no source at all is 'unknown' without any AI call", async () => {
    const t = new FakeTransport({});
    const reserve = vi.fn(async () => "c1");
    const s = fakeStore(["l1"], () => lead(null));
    await runAnswerStep({ store: s.store, ai: ctx(t, reserve), site: null }, Q, { limit: 3 });
    expect(s.finished[0]).toMatchObject({ status: "done", answer: "unknown" });
    expect(reserve).not.toHaveBeenCalled();
  });
  test("a cap stops the batch: nothing is paid for, the rows go back to the queue", async () => {
    const t = new FakeTransport({ ai_answer: () => ({ json: { answer: "no", source_ref: "", quote: "" } }) });
    const reserve = vi.fn(async () => {
      throw new AiError("user_cap");
    });
    const s = fakeStore(["l1", "l2", "l3"], () => lead("We build multi-family developments."));
    const r = await runAnswerStep({ store: s.store, ai: ctx(t, reserve), site: null }, Q, { limit: 3 });
    expect(r.stop).toBe("user_cap");
    expect(r.done).toBe(0);
    expect(s.finished).toEqual([]);
    expect(s.released).toEqual(["a0", "a1", "a2"]);
    expect(t.calls).toHaveLength(0);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ task: "ai_answer", model: MODELS.haiku, runId: null }));
  });
  test("a malformed answer fails that lead only; the batch goes on", async () => {
    const t = new FakeTransport({ ai_answer: (_r, n) => (n === 0 ? { text: "not json" } : { json: { answer: "unknown", source_ref: "", quote: "" } }) });
    const s = fakeStore(["l1", "l2"], () => lead("We build multi-family developments."));
    const r = await runAnswerStep({ store: s.store, ai: ctx(t, async () => "c1"), site: null }, Q, { limit: 3 });
    expect(r.stop).toBeNull();
    expect(s.finished.map((f) => f.status)).toEqual(["failed", "done"]);
  });
});

function item(id: string, ai?: LeadListItem["ai"], total?: number): LeadListItem {
  const lead = { id, workspace_id: "w", best_candidate_id: null, status: "new", origin_kind: "import", level: 1, first_contacted_at: null } as unknown as LeadRow;
  return { lead, best: total === undefined ? null : ({ total_value_usd: total } as LeadListItem["best"]), display: { name: id, city: null, phone: null, website: null, email: null }, agentName: null, importName: null, proofOk: 0, ai };
}

describe("AI column filter (shared filter object)", () => {
  const done = (answer: string) => ({ status: "done" as const, answer, url: null, excerpt: answer === "unknown" ? null : "x", label: null });
  test("matchesAnswer", () => {
    expect(matchesAnswer(done("yes"), "yes")).toBe(true);
    expect(matchesAnswer(done("unknown"), "yes")).toBe(false);
    expect(matchesAnswer(done("unknown"), "answered")).toBe(false);
    expect(matchesAnswer(undefined, "pending")).toBe(true);
    expect(matchesAnswer({ status: "queued", answer: null, url: null, excerpt: null, label: null }, "pending")).toBe(true);
    expect(matchesAnswer(undefined, "all")).toBe(true);
  });
  test("filterLeads uses aiQuestion/aiAnswer, and a saved view keeps them", () => {
    const items = [item("a", { q1: done("yes") }), item("b", { q1: done("no") }), item("c")];
    const f = { ...DEFAULT_LEAD_FILTERS, aiQuestion: "11111111-1111-4111-8111-111111111111", aiAnswer: "yes" };
    const ids = (x: LeadListItem[]) => x.map((i) => i.lead.id);
    expect(ids(filterLeads(items.map((i) => ({ ...i, ai: i.ai ? { [f.aiQuestion]: i.ai.q1 } : undefined })), f))).toEqual(["a"]);
    expect(parseLeadFilters({ aiQuestion: f.aiQuestion, aiAnswer: "yes" })).toMatchObject({ aiQuestion: f.aiQuestion, aiAnswer: "yes" });
    expect(parseLeadFilters({ aiQuestion: "drop table" })).toEqual(DEFAULT_LEAD_FILTERS);
  });
  test("minPermitUsd uses the research's permit total", () => {
    const items = [item("big", undefined, 900_000), item("small", undefined, 40_000), item("none")];
    expect(filterLeads(items, { ...DEFAULT_LEAD_FILTERS, minPermitUsd: 500_000 }).map((i) => i.lead.id)).toEqual(["big"]);
  });
});
