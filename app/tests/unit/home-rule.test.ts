import { describe, expect, test } from "vitest";
import { t } from "@/messages/pt";
import { DEFAULT_HOME_RULE, HOME_PICK, homeMatches, parseHomeRule, pickFirst, ruleInWords, type HomeRow, type HomeRule } from "@/lib/home/rule";
import type { Segment } from "@/lib/leads/types";

type Over = { id: string; name?: string; status?: string; contacted?: boolean; dnc?: boolean; segment?: Segment | null; phone?: string | null; email?: string | null; contact?: string | null; title?: string | null; city?: string | null; origin?: string; temp?: "very_hot" | "hot" | "warm" | "cold" | null; level?: number; usd?: number | null; seen?: string };

// A row as the Home builds it (fictional companies, 508-555-01xx numbers).
function row(o: Over): HomeRow {
  return {
    lead: { id: o.id, status: (o.status ?? "new") as never, level: o.level ?? 1, origin_kind: "import", origin_agent_id: null, first_contacted_at: o.contacted ? "2026-11-01T00:00:00Z" : null, last_touch_at: null, segment: null, first_seen_at: o.seen ?? "2026-11-10T00:00:00Z", do_not_call: o.dnc ?? false },
    best: o.temp !== undefined || o.usd !== undefined ? ({ temperature: o.temp ?? null, biggest_job_value_usd: o.usd ?? null, company_type: null } as never) : null,
    display: { name: o.name ?? `Co ${o.id}`, city: o.city === undefined ? "Boston" : o.city, phone: o.phone === undefined ? "(508) 555-0101" : o.phone, website: null, email: o.email ?? null, contactName: o.contact ?? null, contactTitle: o.title ?? null },
    origins: [{ name: o.origin ?? "Lista A", at: "2026-11-01T00:00:00Z", kind: "list" }],
    agentName: null,
    importName: null,
    segment: o.segment === undefined ? "large" : o.segment,
  };
}
const ids = (rows: HomeRow[]) => rows.map((r) => r.lead.id);
const rule = (p: Partial<HomeRule> = {}): HomeRule => ({ ...DEFAULT_HOME_RULE, ...p });

describe("default rule", () => {
  test("Grande + has phone, never contacted, recommended order, 5 at most", () => {
    const rows = [
      ...Array.from({ length: 7 }, (_, n) => row({ id: `g${n}`, name: `Grande ${n}` })),
      row({ id: "small", segment: "small" }),
      row({ id: "nophone", phone: null }),
    ];
    const picked = pickFirst(rows, DEFAULT_HOME_RULE);
    expect(HOME_PICK).toBe(5);
    expect(ids(picked)).toEqual(["g0", "g1", "g2", "g3", "g4"]);
    expect(homeMatches(rows, DEFAULT_HOME_RULE)).toHaveLength(7);
  });
  test("recommended = the Leads order: hotter first, then by name", () => {
    const rows = [row({ id: "cold", name: "A", temp: "cold" }), row({ id: "hot", name: "Z", temp: "hot" }), row({ id: "none", name: "B" })];
    expect(ids(homeMatches(rows, DEFAULT_HOME_RULE))).toEqual(["hot", "cold", "none"]);
  });
  test("fewer than 5 available: shows what there is; none: empty", () => {
    expect(pickFirst([row({ id: "a" }), row({ id: "b", segment: "small" })], DEFAULT_HOME_RULE)).toHaveLength(1);
    expect(pickFirst([], DEFAULT_HOME_RULE)).toEqual([]);
  });
});

describe("always excluded, whatever the rule says", () => {
  const open = rule({ segments: [], hasPhone: false });
  const rows = [
    row({ id: "ok" }),
    row({ id: "contacted", contacted: true }),
    row({ id: "calllist", status: "call_list" }),
    row({ id: "replied", status: "replied" }),
    row({ id: "meeting", status: "meeting" }),
    row({ id: "won", status: "won" }),
    row({ id: "lost", status: "lost" }),
    row({ id: "discarded", status: "discarded" }),
    row({ id: "dnc", dnc: true }),
  ];
  test("only a never-contacted Novo lead that is not do-not-call gets in", () => {
    expect(ids(homeMatches(rows, open))).toEqual(["ok"]);
  });
  test("the listed leads leave as soon as a call moves them out of Novo", () => {
    const after = rows.map((r) => (r.lead.id === "ok" ? row({ id: "ok", status: "call_list", contacted: true }) : r));
    expect(homeMatches(after, open)).toEqual([]);
  });
});

describe("rule filters reuse the Leads ones", () => {
  const rows = [
    row({ id: "a", segment: "large", city: "Boston", origin: "Lista A", email: "a@x.example", contact: "Ana", title: "Owner", temp: "hot" }),
    row({ id: "b", segment: "residential", city: "Salem", origin: "Lista B", temp: "warm" }),
    row({ id: "c", segment: null, city: "Boston", origin: "Lista B", title: "Project Manager", temp: "cold" }),
    row({ id: "d", segment: "small", phone: null, city: "Boston", origin: "Lista A", temp: "very_hot" }),
  ];
  const pick = (p: Partial<HomeRule>) => ids(homeMatches(rows, rule({ segments: [], hasPhone: false, ...p }))).sort();
  test("types (several), 'Sem tipo'", () => {
    expect(pick({ segments: ["large", "residential"] })).toEqual(["a", "b"]);
    expect(pick({ segments: ["none"] })).toEqual(["c"]);
  });
  test("phone, e-mail, contact name, city, origin, role", () => {
    expect(pick({ hasPhone: true })).toEqual(["a", "b", "c"]);
    expect(pick({ hasEmail: true })).toEqual(["a"]);
    expect(pick({ hasContactName: true })).toEqual(["a"]);
    expect(pick({ city: "Boston" })).toEqual(["a", "c", "d"]);
    expect(pick({ origin: "Lista B" })).toEqual(["b", "c"]);
    expect(pick({ role: "pm" })).toEqual(["c"]);
    expect(pick({ role: "owner" })).toEqual(["a"]);
  });
  test("minimum temperature", () => {
    expect(pick({ minTemperature: "warm" })).toEqual(["a", "b", "d"]);
    expect(pick({ minTemperature: "hot" })).toEqual(["a", "d"]);
    expect(pick({ minTemperature: "very_hot" })).toEqual(["d"]);
  });
});

describe("has phone means a callable number (same test as Prontas para ligar)", () => {
  test("a text like 'ext 4' does not pass; a real number does", () => {
    const rows = [row({ id: "ext", phone: "ext 4" }), row({ id: "ok", phone: "(508) 555-0102" }), row({ id: "short", phone: "555-0101" })];
    expect(ids(homeMatches(rows, DEFAULT_HOME_RULE))).toEqual(["ok"]);
    expect(ids(homeMatches(rows, rule({ hasPhone: false })))).toHaveLength(3);
  });
});

describe("preview parity: the slim row the editor gets matches like the full row", () => {
  test("same result for several rules", () => {
    const full = [
      row({ id: "a", temp: "hot", usd: 900_000, email: "a@x.example", contact: "Ana", title: "Owner" }),
      row({ id: "b", segment: "residential", temp: "warm", usd: 10_000, city: "Salem", origin: "Lista B" }),
      row({ id: "c", segment: null, phone: null, temp: "cold" }),
      row({ id: "d", phone: "ext 4", temp: "very_hot" }),
    ];
    // as the page slims it: only the best-candidate fields the rule reads, no ai
    const slim = full.map((r) => ({ ...r, ai: undefined, best: r.best && ({ temperature: r.best.temperature, company_type: r.best.company_type, biggest_job_value_usd: r.best.biggest_job_value_usd } as typeof r.best) }));
    const rules = [DEFAULT_HOME_RULE, rule({ segments: [], hasPhone: false, order: "biggest" }), rule({ segments: ["residential"], city: "Salem", origin: "Lista B" }), rule({ segments: [], minTemperature: "hot", order: "hottest" }), rule({ hasEmail: true, role: "owner" })];
    for (const r of rules) expect(ids(homeMatches(slim, r))).toEqual(ids(homeMatches(full, r)));
  });
});

describe("orders, nulls last", () => {
  const any: Partial<HomeRule> = { segments: [], hasPhone: false };
  test("Maior obra primeiro", () => {
    const rows = [row({ id: "none", usd: null }), row({ id: "small", usd: 10_000 }), row({ id: "big", usd: 900_000 }), row({ id: "norow" })];
    expect(ids(homeMatches(rows, rule({ ...any, order: "biggest" }))).slice(0, 2)).toEqual(["big", "small"]);
    expect(ids(homeMatches(rows, rule({ ...any, order: "biggest" }))).slice(2).sort()).toEqual(["none", "norow"]);
  });
  test("Mais quentes primeiro", () => {
    const rows = [row({ id: "no", temp: null }), row({ id: "cold", temp: "cold" }), row({ id: "vh", temp: "very_hot" }), row({ id: "w", temp: "warm" })];
    expect(ids(homeMatches(rows, rule({ ...any, order: "hottest" })))).toEqual(["vh", "w", "cold", "no"]);
  });
  test("Mais novos primeiro (first_seen_at)", () => {
    const rows = [row({ id: "old", seen: "2026-01-01T00:00:00Z" }), row({ id: "new", seen: "2026-11-15T00:00:00Z" }), row({ id: "bad", seen: "not a date" }), row({ id: "mid", seen: "2026-06-01T00:00:00Z" })];
    expect(ids(homeMatches(rows, rule({ ...any, order: "newest" })))).toEqual(["new", "mid", "old", "bad"]);
  });
  test("a tie keeps the recommended order", () => {
    const rows = [row({ id: "b", name: "B" }), row({ id: "a", name: "A" })];
    expect(ids(homeMatches(rows, rule({ ...any, order: "biggest" })))).toEqual(["a", "b"]);
  });
});

describe("rule parsing (stored value is not trusted)", () => {
  test("a valid rule is kept; a missing key takes the default", () => {
    expect(parseHomeRule({ ...DEFAULT_HOME_RULE, order: "newest", city: "Salem" })).toEqual({ ...DEFAULT_HOME_RULE, order: "newest", city: "Salem" });
    expect(parseHomeRule({ order: "hottest" })).toEqual({ ...DEFAULT_HOME_RULE, order: "hottest" });
  });
  test("broken or old shapes fall back to the default, never throw", () => {
    for (const bad of [null, undefined, 7, "x", [], { order: "alphabetical" }, { segments: "large" }, { hasPhone: "yes" }, { minTemperature: "lava" }, { role: "ceo" }, { city: 5 }, { segments: ["huge"] }])
      expect(parseHomeRule(bad)).toEqual(DEFAULT_HOME_RULE);
  });
  test("unknown keys are dropped, undefined does not erase a default", () => {
    expect(parseHomeRule({ extra: 1, order: "newest" })).toEqual({ ...DEFAULT_HOME_RULE, order: "newest" });
    expect(parseHomeRule({ segments: undefined })).toEqual(DEFAULT_HOME_RULE);
  });
});

test("the rule in words", () => {
  expect(ruleInWords(DEFAULT_HOME_RULE, t)).toBe("Regra: Grande · tem telefone · nunca contatado · ordem recomendada.");
  expect(ruleInWords(rule({ segments: ["large", "none"], hasPhone: false, hasEmail: true, city: "Salem", minTemperature: "hot", role: "owner", order: "newest" }), t)).toBe(
    "Regra: Grande/Sem tipo · tem e-mail · em Salem · quente ou mais · cargo: dono/fundador · nunca contatado · ordem mais novos primeiro.",
  );
});
