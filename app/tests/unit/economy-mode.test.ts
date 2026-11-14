import { describe, expect, test } from "vitest";
import { runTask, taskMeta, type AiCallRecord, type AiLedger, type AiReservation, type TaskDef } from "@/lib/ai/gateway";
import { MODELS } from "@/lib/ai/models";
import { PRICES, worstCaseUsd } from "@/lib/ai/pricing";
import { fitWebToBudget, MODEL_BY_RIGOR, routeFor, WEB_LIMITS_BY_RIGOR, type ResearchStep } from "@/lib/ai/routing";
import { minReserveUsdFor, reserveUsdFor, TASK_DEFS, WEB_LIMITS } from "@/lib/ai/tasks";
import { RIGORS, SECOND_PASS_BY_RIGOR } from "@/lib/research/types";
import { z } from "zod";
import { FakeTransport } from "../engine/fake-ai";

// Modo econômico (kolmeia/docs/superpowers/specs/2026-11-14-modo-economico-design.md): routing per step and rigor,
// smaller web budgets in Rápida, and calls that shrink to fit the run's remaining cost cap. No network.

const STEPS: ResearchStep[] = ["discover", "collect", "verify", "second"];

describe("routing per task and rigor", () => {
  test("only the steps whose output is checked later move to Haiku, and never in strict", () => {
    expect(MODEL_BY_RIGOR.quick).toEqual({ discover: MODELS.haiku, collect: MODELS.haiku, verify: MODELS.sonnet, second: MODELS.opus });
    expect(MODEL_BY_RIGOR.careful).toEqual({ discover: MODELS.haiku, collect: MODELS.haiku, verify: MODELS.sonnet, second: MODELS.opus });
    expect(MODEL_BY_RIGOR.strict).toEqual({ discover: MODELS.sonnet, collect: MODELS.sonnet, verify: MODELS.sonnet, second: MODELS.opus });
  });

  test("the steps that decide truth never leave their model, at any rigor", () => {
    for (const rigor of RIGORS) {
      expect(routeFor("verify", rigor).model).toBe(MODELS.sonnet);
      expect(routeFor("second", rigor).model).toBe(MODELS.opus);
    }
    expect(TASK_DEFS.planDef.model).toBe(MODELS.opus);
    expect(TASK_DEFS.secondDef.model).toBe(MODELS.opus);
    expect(TASK_DEFS.questionsDef.model).toBe(MODELS.sonnet);
  });

  test("every routed model has a price (cost accounting stays exact)", () => {
    for (const rigor of RIGORS) for (const step of STEPS) expect(PRICES[routeFor(step, rigor).model]).toBeDefined();
  });

  test("Rápida: fewer searches and page opens per call than Cuidadosa, and no second pass", () => {
    for (const step of ["discover", "collect", "verify"] as const) {
      const q = WEB_LIMITS_BY_RIGOR.quick[step];
      const c = WEB_LIMITS_BY_RIGOR.careful[step];
      expect(q.search.maxUses).toBeLessThan(c.search.maxUses);
      expect(q.fetch.maxUses).toBeLessThan(c.fetch.maxUses);
    }
    expect(SECOND_PASS_BY_RIGOR.quick).toBe(false);
    // Cuidadosa and Rigorosa keep the limits measured on 10/11/2026.
    expect(WEB_LIMITS_BY_RIGOR.careful).toEqual(WEB_LIMITS);
    expect(WEB_LIMITS_BY_RIGOR.strict).toEqual(WEB_LIMITS);
  });

  test("reserves per step: Rápida's whole first pass fits in US$ 1; strict is unchanged", () => {
    expect({ d: reserveUsdFor("discover", "quick"), c: reserveUsdFor("collect", "quick"), v: reserveUsdFor("verify", "quick") }).toEqual({ d: 0.09, c: 0.32, v: 0.65 });
    expect(reserveUsdFor("discover", "quick") + reserveUsdFor("collect", "quick")).toBeLessThan(1 - minReserveUsdFor("verify", "quick"));
    expect({ d: reserveUsdFor("discover", "strict"), c: reserveUsdFor("collect", "strict"), v: reserveUsdFor("verify", "strict") }).toEqual({ d: 0.97, c: 1.35, v: 0.85 });
    // The smallest verify call (1 search, 1 page, no continuation) that discover and collect leave room for.
    expect(minReserveUsdFor("verify", "quick")).toBe(0.25);
  });
});

describe("fitWebToBudget: a call shrinks to fit what is left of the run's cap", () => {
  const web = { search: { maxUses: 8 }, fetch: { maxUses: 6 } };

  test("a call that fits is left as it is", () => {
    const fit = fitWebToBudget(MODELS.sonnet, 16_000, web, 1, 5);
    expect(fit).toEqual({ web, maxContinuations: 1, reserveUsd: worstCaseUsd(MODELS.sonnet, 16_000, web, 1), trimmed: false });
  });

  test("for any remaining budget the shrunk reserve never passes it, and it is the worst case of the call sent", () => {
    for (let cents = 1; cents <= 200; cents++) {
      const remaining = cents / 100;
      const fit = fitWebToBudget(MODELS.sonnet, 16_000, web, 1, remaining);
      if (!fit) {
        expect(worstCaseUsd(MODELS.sonnet, 16_000, { search: { maxUses: 1 }, fetch: { maxUses: 1 } }, 0)).toBeGreaterThan(remaining);
        continue;
      }
      expect(fit.reserveUsd).toBeLessThanOrEqual(remaining);
      expect(fit.reserveUsd).toBe(worstCaseUsd(MODELS.sonnet, 16_000, fit.web, fit.maxContinuations));
      expect(fit.web.search!.maxUses).toBeGreaterThanOrEqual(1);
      expect(fit.web.fetch!.maxUses).toBeGreaterThanOrEqual(1);
    }
  });

  test("order: searches and pages down to 2 + 1 first, then no continuation, then 1 + 1, then it gives up", () => {
    const soft = worstCaseUsd(MODELS.sonnet, 16_000, { search: { maxUses: 2 }, fetch: { maxUses: 1 } }, 1);
    expect(fitWebToBudget(MODELS.sonnet, 16_000, web, 1, soft)).toMatchObject({ web: { search: { maxUses: 2 }, fetch: { maxUses: 1 } }, maxContinuations: 1, trimmed: true });
    const noCont = worstCaseUsd(MODELS.sonnet, 16_000, { search: { maxUses: 2 }, fetch: { maxUses: 1 } }, 0);
    expect(fitWebToBudget(MODELS.sonnet, 16_000, web, 1, noCont)).toMatchObject({ web: { search: { maxUses: 2 }, fetch: { maxUses: 1 } }, maxContinuations: 0 });
    const min = worstCaseUsd(MODELS.sonnet, 16_000, { search: { maxUses: 1 }, fetch: { maxUses: 1 } }, 0);
    expect(fitWebToBudget(MODELS.sonnet, 16_000, web, 1, min)).toMatchObject({ web: { search: { maxUses: 1 }, fetch: { maxUses: 1 } }, maxContinuations: 0 });
    expect(fitWebToBudget(MODELS.sonnet, 16_000, web, 1, min - 0.01)).toBeNull();
  });

  test("a task's own reserve floor is respected", () => {
    expect(fitWebToBudget(MODELS.haiku, 1_000, web, 1, 0.4, 0.5)).toBeNull();
  });
});

describe("gateway: shrinking happens only against the run cap, and the model is told", () => {
  class Ledger implements AiLedger {
    reservations: AiReservation[] = [];
    rows: AiCallRecord[] = [];
    async dailyCapUsd() {
      return 10;
    }
    async spentTodayUsd() {
      return 0;
    }
    async record(r: AiCallRecord) {
      this.rows.push(r);
    }
    async reserve(r: AiReservation) {
      this.reservations.push(r);
      return `id-${this.reservations.length}`;
    }
    async settle(_id: string, r: AiCallRecord) {
      this.rows.push(r);
    }
  }
  const schema = z.object({ answer: z.string() });
  const webDef: TaskDef<{ q: string }, z.infer<typeof schema>, string> = {
    task: "research_collect",
    model: MODELS.sonnet,
    promptVersion: "t-1",
    system: "sys",
    schema,
    effort: "medium",
    maxTokens: 16_000,
    web: { search: { maxUses: 8 }, fetch: { maxUses: 6 } },
    buildUser: (i) => i.q,
    normalize: (p) => p.answer,
  };

  test("with US$ 0.50 left, the call asks for fewer searches and reserves at most US$ 0.50", async () => {
    const ledger = new Ledger();
    const fake = new FakeTransport({ research_collect: () => ({ json: { answer: "x" } }) });
    const out = await runTask({ workspaceId: "ws", runId: "r", ledger, transport: fake, runBudget: { spentUsd: 1.5, maxUsd: 2 } }, webDef, { q: "find" });
    const sent = fake.calls[0];
    expect(ledger.reservations[0].reserveUsd).toBeLessThanOrEqual(0.5);
    expect(ledger.reservations[0].reserveUsd).toBe(worstCaseUsd(MODELS.sonnet, 16_000, sent.web, sent.maxContinuations));
    expect(sent.web!.search!.maxUses).toBeLessThan(8);
    expect(sent.user).toBe(`find\nWeb budget for this step: at most ${sent.web!.search!.maxUses} web searches and ${sent.web!.fetch!.maxUses} page opens (web fetch).`);
    expect(out.web).toMatchObject({ trimmed: true, limits: sent.web });
  });

  test("without a run budget (daily caps only) nothing shrinks; the full budget line is sent", async () => {
    const ledger = new Ledger();
    const fake = new FakeTransport({ research_collect: () => ({ json: { answer: "x" } }) });
    const out = await runTask({ workspaceId: "ws", runId: null, ledger, transport: fake }, webDef, { q: "find" });
    expect(fake.calls[0].web).toEqual(webDef.web);
    expect(fake.calls[0].user).toContain("at most 8 web searches and 6 page opens");
    expect(out.web?.trimmed).toBe(false);
  });

  test("when even the smallest call does not fit, it is run_cap and nothing is sent", async () => {
    const fake = new FakeTransport({ research_collect: () => ({ json: { answer: "x" } }) });
    const ctx = { workspaceId: "ws", runId: "r", ledger: new Ledger(), transport: fake, runBudget: { spentUsd: 1.9, maxUsd: 2 } };
    await expect(runTask(ctx, webDef, { q: "find" })).rejects.toMatchObject({ code: "run_cap" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("collect keeps a phone only with the page that shows it (any model)", () => {
  const cand = (phone: string, phone_source_url: string) => ({
    name: "Acme Builders",
    city: "Worcester",
    state: "MA",
    region: "",
    website: "https://acme.example",
    phone,
    phone_source_url,
    company_type: "builder" as const,
    size_note: "",
    entry_path: "directory" as const,
    found_at: { url: "https://dir.example/list", title: "Dir", excerpt: "Acme" },
  });
  const run = (c: ReturnType<typeof cand>) => {
    const meta = taskMeta({ seenUrls: ["https://dir.example/list", "https://acme.example/contact"] }, true);
    const input = { want: 10 } as Parameters<typeof TASK_DEFS.collectDef.normalize>[1];
    return TASK_DEFS.collectDef.normalize({ candidates: [c], sources_tried: [], jobs_without_builder: [], exhausted: false }, input, meta).candidates[0];
  };

  test("source returned by a web tool: phone and source kept", () => {
    expect(run(cand("(508) 555-0101", "https://acme.example/contact"))).toMatchObject({ phone: "(508) 555-0101", phoneSourceUrl: "https://acme.example/contact" });
  });

  test("source not returned (invented) or missing: the phone is dropped, not kept without a source", () => {
    expect(run(cand("(508) 555-0101", "https://invented.example/contact"))).toMatchObject({ phone: null, phoneSourceUrl: null });
    expect(run(cand("(508) 555-0101", ""))).toMatchObject({ phone: null, phoneSourceUrl: null });
  });
});
