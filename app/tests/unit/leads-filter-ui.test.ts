import { describe, expect, it } from "vitest";
import { t } from "@/messages/pt";
import { en } from "@/messages/en";
import { activeHref, leadsCards, leadsMoreLinks } from "@/lib/nav";
import { DEFAULT_LEAD_FILTERS, type LeadFilters } from "@/lib/leads/view";
import { clearAllPatch, extraFilterKeys, pickedIn, SHORTCUT_CHIPS, summaryOf } from "@/lib/leads/filter-ui";

const f = (p: Partial<LeadFilters>): LeadFilters => ({ ...DEFAULT_LEAD_FILTERS, ...p });
const chip = (id: string) => SHORTCUT_CHIPS.find((c) => c.id === id)!;

describe("summary sentence", () => {
  it("says size, stage and every active filter in Portuguese", () => {
    const s = summaryOf(f({ segment: "large", stage: "new", hasPhone: true, cities: ["Cambridge"] }), 93, [], t);
    expect(s).toBe("93 empresas de tamanho Grande · na etapa Novo · com telefone · em Cambridge");
  });
  it("defaults and singular", () => {
    expect(summaryOf(DEFAULT_LEAD_FILTERS, 1, [], t)).toBe("1 empresa de todos os tamanhos · em qualquer etapa");
    expect(summaryOf(f({ segment: "none" }), 2, [], t)).toBe("2 empresas sem tipo · em qualquer etapa");
  });
  it("reads the same in English", () => {
    const s = summaryOf(f({ segment: "large", stage: "new", hasPhone: true, cities: ["Cambridge"] }), 93, [], en);
    expect(s).toBe("93 companies of size Large · at stage New · with a phone · in Cambridge");
  });
  it("covers panel filters, search and AI-only filters", () => {
    const s = summaryOf(f({ q: "acme", lastTouch: "never", entered: "7", nameQ: "development", nameNot: true, temperature: "none", agent: "a1", minLevel: 2 }), 5, [["a1", "Caçador X"]], t);
    for (const p of ['buscando "acme"', "nunca contatadas", "que entraram nesta semana", 'sem "development" no nome', "sem pesquisa", "Agente: Caçador X", "Dados mínimos: 2"]) expect(s).toContain(p);
  });
});

describe("shortcut chips mirror the filters", () => {
  it("a chip is on exactly when its filter is set, wherever it was set", () => {
    expect(chip("never").on(f({ lastTouch: "never" }))).toBe(true);
    expect(chip("never").on(f({ lastTouch: "30" }))).toBe(false);
    expect(chip("week").on(f({ entered: "7" }))).toBe(true);
    expect(chip("week").on(f({ entered: "30" }))).toBe(false);
    expect(chip("hasPhone").on(f({ hasPhone: true }))).toBe(true);
  });
  it("toggling writes the existing filter and back to its default", () => {
    for (const c of SHORTCUT_CHIPS) {
      const on = f(c.patch(true));
      expect(c.on(on)).toBe(true);
      expect(f({ ...on, ...c.patch(false) })).toEqual(DEFAULT_LEAD_FILTERS);
    }
  });
});

describe("panel helpers", () => {
  it("counts picked options per category and keeps AI-only filters as extras", () => {
    const x = f({ cities: ["A", "B"], hasEmail: true, hasPhone: true, minPermitUsd: 10, entered: "today" });
    expect(pickedIn("city", x)).toBe(2);
    expect(pickedIn("contact", x)).toBe(2);
    expect(pickedIn("entered", x)).toBe(1);
    expect(pickedIn("agent", x)).toBe(0);
    expect(extraFilterKeys(x)).toEqual(["minPermitUsd"]);
  });
  it("Limpar tudo resets filters, search, size and stage but keeps the AI column", () => {
    const x = f({ q: "a", segment: "large", stage: "new", cities: ["A"], nameQ: "b", nameNot: true, aiQuestion: "q1" });
    expect({ ...x, ...clearAllPatch(x) }).toEqual({ ...DEFAULT_LEAD_FILTERS, aiQuestion: "q1" });
  });
});

describe("leads nav cards", () => {
  const hrefs = (role: "owner" | "closer") => [...leadsCards(t), ...leadsMoreLinks(role, t)].map((i) => i.href);
  it("sub-routes light their own card; organize links win over Todos", () => {
    expect(activeHref("/leads", hrefs("owner"))).toBe("/leads");
    expect(activeHref("/leads/ligar/abc", hrefs("owner"))).toBe("/leads/ligar");
    expect(activeHref("/leads/tarefas", hrefs("owner"))).toBe("/leads/tarefas");
    expect(activeHref("/leads/listas/123", hrefs("owner"))).toBe("/leads/listas");
    expect(activeHref("/leads/subir", hrefs("owner"))).toBe("/leads");
  });
  it("the closer gets the four cards and no organize links", () => {
    expect(leadsCards(t).map((c) => c.label)).toEqual(["Todos os leads", "Ligar agora", "Retornos marcados", "Resultados"]);
    expect(leadsMoreLinks("closer", t)).toEqual([]);
    expect(leadsMoreLinks("sdr", t).map((l) => l.href)).toEqual(["/leads/listas", "/leads/funil", "/leads/cobertura", "/leads/perfil"]);
  });
});
