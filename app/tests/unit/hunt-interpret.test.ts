import { describe, expect, test } from "vitest";
import { interpretInstruction, phraseInterpreter } from "@/lib/hunt/interpret";

describe("interpretInstruction", () => {
  test("Juan's acceptance sentence", () => {
    const r = interpretInstruction("essas casas são pequenas demais; nesta busca priorize multifamiliares e descubra por onde apresentar orçamento", "pt");
    expect(r.params).toEqual({ deprioritizeKinds: ["single_family", "adu"], preferKinds: ["multifamily"], wantBidPath: true });
    expect(r.understoodCodes).toEqual(["deprioritize_small_houses", "prefer_multifamily", "want_bid_path"]);
    expect(r.unknown).toEqual([]);
  });
  test("English equivalent", () => {
    const r = interpretInstruction("These houses are too small. For this search prioritize multifamily and find out how to submit a bid", "en");
    expect(r.params).toEqual({ deprioritizeKinds: ["single_family", "adu"], preferKinds: ["multifamily"], wantBidPath: true });
    expect(r.unknown).toEqual([]);
  });
  test.each([
    ["foque em condomínios e apartamentos", "pt", { preferKinds: ["multifamily"] }],
    ["focus on apartments and condos", "en", { preferKinds: ["multifamily"] }],
    ["evite comerciais", "pt", { deprioritizeKinds: ["commercial"] }],
    ["no commercial", "en", { deprioritizeKinds: ["commercial"] }],
    ["priorize lojas e escritórios", "pt", { preferKinds: ["commercial"] }],
    ["casas grandes", "pt", { preferKinds: ["single_family"] }],
    ["large homes", "en", { preferKinds: ["single_family"] }],
    ["só obras acima de 500 mil", "pt", { minValueUsd: 500_000 }],
    ["valor mínimo de US$ 1.200.000", "pt", { minValueUsd: 1_200_000 }],
    ["only jobs over $2 million", "en", { minValueUsd: 2_000_000 }],
    ["at least $750,000", "en", { minValueUsd: 750_000 }],
    ["mais de 300 mil dólares", "pt", { minValueUsd: 300_000 }],
    ["over 2M", "en", { minValueUsd: 2_000_000 }],
    ["prédios com mais de 20 unidades", "pt", { preferKinds: ["multifamily"] }],
    ["20+ units", "en", { preferKinds: ["multifamily"] }],
    ["buildings with more than 40 units", "en", { preferKinds: ["multifamily"] }],
    ["só os recentes", "pt", { maxAgeDays: 90 }],
    ["últimos 6 meses", "pt", { maxAgeDays: 180 }],
    ["only recent ones", "en", { maxAgeDays: 90 }],
    ["last 30 days", "en", { maxAgeDays: 30 }],
    ["vendor portal please", "en", { wantBidPath: true }],
    ["cadastro de fornecedor", "pt", { wantBidPath: true }],
  ] as const)("%s", (text, lang, params) => {
    const r = interpretInstruction(text, lang);
    expect(r.params).toEqual(params);
    expect(r.understoodCodes.length).toBeGreaterThan(0);
  });
  test("a verbless clause keeps the polarity of the one before", () => {
    expect(interpretInstruction("evite casas e comerciais", "pt").params).toEqual({ deprioritizeKinds: ["single_family", "commercial"] });
  });
  test("pt 'no' is not a negation", () => expect(interpretInstruction("priorize prédios no centro", "pt").params).toEqual({ preferKinds: ["multifamily"] }));
  test("unknown text is returned, nothing guessed", () => {
    const r = interpretInstruction("liga só de manhã; priorize multifamiliares", "pt");
    expect(r.params).toEqual({ preferKinds: ["multifamily"] });
    expect(r.unknown).toEqual(["liga só de manhã"]);
    expect(interpretInstruction("blue sky thinking", "en")).toEqual({ params: {}, understoodCodes: [], unknown: ["blue sky thinking"] });
  });
  test("a bare number, or a number of units/days, is not money", () => {
    for (const t of ["mais de 20 unidades", "at least 750,000", "mais de 6 meses", "mais de 20 mil unidades", "more than 30 days"]) {
      expect(interpretInstruction(t, "pt").params.minValueUsd, t).toBeUndefined();
    }
  });
  test("new construction is the offer, not recency", () => {
    for (const [t, lang] of [["só obras novas", "pt"], ["only new construction", "en"], ["apenas construções novas", "pt"]] as const) {
      const r = interpretInstruction(t, lang);
      expect(r.params, t).toEqual({});
      expect(r.understoodCodes).toEqual(["new_construction_scope"]);
      expect(r.unknown).toEqual([]);
    }
    expect(interpretInstruction("só obras novas e recentes", "pt").params).toEqual({ maxAgeDays: 90 });
  });
  test.each([
    ["evite casas grandes", "pt"], ["não quero casas grandes", "pt"], ["sem casas grandes", "pt"],
    ["avoid big houses", "en"], ["no large homes", "en"], ["don't want large houses", "en"],
  ] as const)("negated large houses lose priority: %s", (text, lang) => {
    const r = interpretInstruction(text, lang);
    expect(r.params).toEqual({ deprioritizeKinds: ["single_family"] });
    expect(r.understoodCodes).toEqual(["deprioritize_large_houses"]);
  });
  test("large houses without a negation still move up", () => expect(interpretInstruction("priorize casas grandes", "pt").params).toEqual({ preferKinds: ["single_family"] }));
  test("Interpreter interface", () => expect(phraseInterpreter.interpret("condos", "en").params).toEqual({ preferKinds: ["multifamily"] }));
});
