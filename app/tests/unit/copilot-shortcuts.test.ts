import { describe, expect, test, vi } from "vitest";
import type { AiContext, AiLedger } from "@/lib/ai/gateway";
import { applyShortcut, BIG_PERMIT_USD, SHORTCUTS } from "@/lib/leads/shortcuts";
import { DEFAULT_LEAD_FILTERS, parseLeadFilters } from "@/lib/leads/view";
import { whyHotFacts } from "@/lib/leads/why-hot";
import type { CandidateRow } from "@/lib/research/rows";
import { FakeTransport } from "../engine/fake-ai";

vi.mock("server-only", () => ({}));
const { checkExplain, explainLead, explainDef } = await import("@/lib/ai/lead-ai-tasks");
const { MODELS } = await import("@/lib/ai/models");

// Fase 3 item 13: Copiloto shortcuts map to the shared filter object; "Por que este lead é quente?" uses stored proof only.
const byId = (id: string) => SHORTCUTS.find((s) => s.id === id)!;

describe("shortcuts produce the expected filter objects", () => {
  test("each shortcut", () => {
    expect(byId("bigPermitBuilders").filters).toEqual({ ...DEFAULT_LEAD_FILTERS, companyTypes: ["builder"], tab: "signal", minPermitUsd: BIG_PERMIT_USD });
    expect(byId("propertyManagers").filters).toEqual({ ...DEFAULT_LEAD_FILTERS, companyTypes: ["property_manager"] });
    expect(byId("hotNoContact").filters).toEqual({ ...DEFAULT_LEAD_FILTERS, temperature: "hot", contact: "new" });
    expect(byId("builderSequence")).toEqual({ id: "builderSequence", filters: { ...DEFAULT_LEAD_FILTERS, companyTypes: ["builder"], hasEmail: true, contact: "new" }, href: "/agentes/novo/email" });
  });
  test("a shortcut replaces the filters but keeps the AI column; a saved view of it reads back the same", () => {
    const current = { ...DEFAULT_LEAD_FILTERS, q: "acme", cities: ["Boston"], aiQuestion: "11111111-1111-4111-8111-111111111111", aiAnswer: "yes" };
    const f = applyShortcut(byId("hotNoContact"), current);
    expect(f).toEqual({ ...DEFAULT_LEAD_FILTERS, temperature: "hot", contact: "new", aiQuestion: current.aiQuestion });
    for (const s of SHORTCUTS) expect(parseLeadFilters(JSON.parse(JSON.stringify(s.filters)))).toEqual(s.filters);
  });
});

const best = {
  id: "c1", temperature: "very_hot", permit_count: 5, total_value_usd: 4_830_000, last_permit_date: "2026-03-10", biggest_job_address: "363 E St, South Boston",
  biggest_job_type: "new 4-unit", biggest_job_value_usd: 1_800_000, hook: "Saw your permit at 363 E St", found_at_url: "https://data.boston.gov/permit/1",
} as unknown as CandidateRow;

describe("Por que este lead é quente?", () => {
  test("built from stored facts with their sources; refuted values and e-mail guesses are left out", () => {
    const facts = whyHotFacts({
      level: 4,
      best,
      fields: [
        { id: "f1", lead_id: "l", field: "active_project", value: "Mill St condos", source: "import", source_ref: "imp-1", status: "unverified", excerpt: null, seen_at: "" },
        { id: "f2", lead_id: "l", field: "active_project", value: "Fake job", source: "site", source_ref: "https://x.example", status: "refuted", excerpt: null, seen_at: "" },
        { id: "f3", lead_id: "l", field: "email", value: "pat@x.example", source: "pattern", source_ref: null, status: "unverified", excerpt: null, seen_at: "" },
      ],
      checks: [{ candidate_id: "c1", kind: "has_work", result: "ok", evidence: [{ url: "https://data.boston.gov/permit/1", title: "Permit", excerpt: "New 4-unit building", seen_at: "" }] }],
    });
    const texts = facts.map((f) => f.text);
    expect(texts[0]).toMatch(/^Nível 4 de 4/);
    expect(texts).toContain("5 alvarás, total US$ 4,8 mi, o último em 10/03/2026");
    expect(facts.find((f) => f.text.startsWith("Maior obra"))).toEqual({ text: "Maior obra: 363 E St, South Boston · new 4-unit · US$ 1,8 mi", url: "https://data.boston.gov/permit/1" });
    expect(texts).toContain("active_project: Mill St condos (fonte: import)");
    expect(texts.join(" ")).not.toMatch(/Fake job|pat@x/);
    expect(facts.at(-1)).toEqual({ text: "Prova: New 4-unit building", url: "https://data.boston.gov/permit/1" });
  });
  test("the AI summary keeps only sentences that cite a real fact; invented citations are dropped, none left is refused", () => {
    const input = { company: "Cedarwood", facts: ["a", "b"] };
    expect(checkExplain({ summary: "Está construindo agora [1][2]. Ganhou 3 prêmios [7]. É o melhor cliente do estado! Obra grande [2][9]." }, input)).toEqual({
      summary: "Está construindo agora [1][2]. Obra grande [2].",
      cited: [1, 2],
    });
    expect(() => checkExplain({ summary: "Muito quente." }, input)).toThrow();
    expect(() => checkExplain({ summary: "Muito quente [5]." }, input)).toThrow();
  });
  test("one capped Haiku call in the user's ledger, facts only as untrusted data", async () => {
    expect(explainDef).toMatchObject({ task: "lead_explain", model: MODELS.haiku });
    const t = new FakeTransport({ lead_explain: () => ({ json: { summary: "Obra nova em South Boston [1]." } }) });
    const reserve = vi.fn(async () => "c1");
    const ledger: AiLedger = { dailyCapUsd: async () => 10, spentTodayUsd: async () => 0, record: async () => undefined, reserve, settle: async () => undefined };
    const ctx: AiContext = { workspaceId: "w", runId: null, ledger, transport: t };
    const r = await explainLead(ctx, { company: "Cedarwood", facts: ["Maior obra: 363 E St"] });
    expect(r.data.cited).toEqual([1]);
    expect(t.calls[0].user).toMatch(/<untrusted_facts>\n\[1\] Maior obra: 363 E St/);
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ task: "lead_explain", model: MODELS.haiku }));
  });
});
