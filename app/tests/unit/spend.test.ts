import { describe, expect, test } from "vitest";
import { agentLabel, periodStart, sourceRows, spendRows, spendTotal, stepLabel, type SpendCall } from "@/lib/spend/view";

const base: SpendCall = {
  id: "c0", run_id: null, lead_id: null, task: "qualify_light", model: "claude-haiku-5-5",
  input_tokens: 0, output_tokens: 0, web_searches: 0, web_fetches: 0, cost_usd: 0, reserve_usd: 0, status: "ok",
  created_at: "2026-11-14T15:00:00.000Z",
};
const call = (o: Partial<SpendCall>): SpendCall => ({ ...base, ...o });

const calls: SpendCall[] = [
  call({ id: "1", lead_id: "L1", task: "qualify_light", cost_usd: 0.01, input_tokens: 100, output_tokens: 10 }),
  call({ id: "2", lead_id: "L1", task: "qualify_deep", model: "claude-sonnet-5-5", cost_usd: 0.2, web_searches: 3, web_fetches: 2 }),
  call({ id: "3", lead_id: "L2", task: "qualify_deep", model: "claude-sonnet-5-5", cost_usd: 0.3 }),
  call({ id: "4", run_id: "R1", task: "research_verify", model: "claude-sonnet-5-5", cost_usd: 0.4 }),
  call({ id: "5", run_id: "R2", task: "research_plan", cost_usd: 0.05 }),
  call({ id: "6", task: "email_draft", cost_usd: 0.02 }),
  // pending: cost still 0, reserve counts
  call({ id: "7", lead_id: "L2", task: "qualify_deep", model: "claude-sonnet-5-5", status: "pending", cost_usd: 0, reserve_usd: 0.15 }),
  call({ id: "8", task: "profile_learn", cost_usd: 0.03, created_at: "2026-11-13T15:00:00.000Z" }),
];
const names = {
  runAgent: new Map<string, string | null>([["R1", "Caçador Boston"], ["R2", null]]),
  leads: new Map<string, string>([["L1", "Acme Fictícia"], ["L2", "Beta Fictícia"]]),
};

describe("F3c-2 spend view", () => {
  test("spendRows by agent, step, model and lead adds up to the ledger total, pending at its reserve", () => {
    const total = 0.01 + 0.2 + 0.3 + 0.4 + 0.05 + 0.02 + 0.15 + 0.03;
    expect(spendTotal(calls)).toBeCloseTo(total, 6);
    for (const by of ["agent", "step", "model", "lead", "day"] as const) {
      const rows = spendRows(calls, by, names);
      expect(rows.reduce((s, r) => s + r.usd, 0)).toBeCloseTo(total, 6);
      for (let i = 1; i < rows.length; i++) expect(rows[i - 1].usd).toBeGreaterThanOrEqual(rows[i].usd);
    }
    const byAgent = spendRows(calls, "agent", names);
    expect(byAgent.find((r) => r.label === "Qualificador")?.usd).toBeCloseTo(0.66, 6);
    expect(byAgent.find((r) => r.label === "Caçador Boston")?.usd).toBeCloseTo(0.4, 6);
    const byLead = spendRows(calls, "lead", names);
    const l2 = byLead.find((r) => r.key === "L2")!;
    expect(l2.label).toBe("Beta Fictícia");
    expect(l2.usd).toBeCloseTo(0.45, 6);
    expect(l2.leads).toEqual([{ id: "L2", name: "Beta Fictícia", usd: expect.closeTo(0.45, 6) }]);
    const byStep = spendRows(calls, "step", names);
    expect(byStep.find((r) => r.label === "P5 IA forte")).toMatchObject({ searches: 3, fetches: 2 });
    expect(byStep.find((r) => r.label === "P5 IA forte")!.leads.map((l) => l.id).sort()).toEqual(["L1", "L2"]);
    const byDay = spendRows(calls, "day", names);
    expect(byDay.map((r) => r.key).sort()).toEqual(["2026-11-13", "2026-11-14"]);
  });

  test("labels: Qualificador, Perfil aprendido, E-mail, the agent's name, Pesquisa avulsa; P3/P4/P5 step names", () => {
    expect(agentLabel(call({ task: "qualify_places" }), names.runAgent)).toBe("Qualificador");
    expect(agentLabel(call({ task: "profile_learn" }), names.runAgent)).toBe("Perfil aprendido");
    expect(agentLabel(call({ task: "email_classify" }), names.runAgent)).toBe("E-mail");
    expect(agentLabel(call({ task: "research_verify", run_id: "R1" }), names.runAgent)).toBe("Caçador Boston");
    expect(agentLabel(call({ task: "research_verify", run_id: "R2" }), names.runAgent)).toBe("Pesquisa avulsa");
    expect(agentLabel(call({ task: "research_verify" }), names.runAgent)).toBe("Pesquisa avulsa");
    expect(stepLabel("qualify_places")).toBe("P3 Places");
    expect(stepLabel("qualify_light")).toBe("P4 IA leve");
    expect(stepLabel("qualify_deep")).toBe("P5 IA forte");
    expect(stepLabel("nao_existe")).toBe("Outro passo");
  });

  test("periodStart today is New York midnight, 7d and 30d count back from now", () => {
    // 2026-11-14 15:00Z = 10:00 EST -> midnight EST = 05:00Z
    expect(periodStart("today", new Date("2026-11-14T15:00:00Z")).toISOString()).toBe("2026-11-14T05:00:00.000Z");
    // 02:00Z is still the 13th in New York
    expect(periodStart("today", new Date("2026-11-14T02:00:00Z")).toISOString()).toBe("2026-11-13T05:00:00.000Z");
    // summer: EDT, midnight = 04:00Z
    expect(periodStart("today", new Date("2026-07-01T12:00:00Z")).toISOString()).toBe("2026-07-01T04:00:00.000Z");
    // day the clocks go back (2026-11-01): midnight is still EDT
    expect(periodStart("today", new Date("2026-11-01T12:00:00Z")).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    const now = new Date("2026-11-14T15:00:00Z");
    expect(periodStart("7d", now).toISOString()).toBe("2026-11-07T15:00:00.000Z");
    expect(periodStart("30d", now).toISOString()).toBe("2026-10-15T15:00:00.000Z");
  });

  test("source runs add up per provider and kind; a running run counts at its reserve", () => {
    const rows = sourceRows([
      { provider: "apify", kind: "maps", status: "imported", cost_usd: 1.5, reserve_usd: 2 },
      { provider: "apify", kind: "maps", status: "failed", cost_usd: null, reserve_usd: 2 },
      { provider: "apify", kind: "maps", status: "running", cost_usd: null, reserve_usd: 2 },
      { provider: "apollo", kind: "contact", status: "succeeded", cost_usd: 0.5, reserve_usd: 1 },
    ]);
    expect(rows.find((r) => r.provider === "apify")).toMatchObject({ runs: 3, usd: 3.5 });
    expect(rows.reduce((s, r) => s + r.usd, 0)).toBeCloseTo(4, 6);
  });
});
