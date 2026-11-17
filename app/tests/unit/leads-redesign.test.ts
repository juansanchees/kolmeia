import { expect, test } from "vitest";
import { segmentOf, stageOf } from "@/lib/leads/classify";
import { activeFilterKeys, DEFAULT_LEAD_FILTERS, filterLeads, hasSiteNoEmail, leadFacetsOf, parseLeadFilters, type FilterRow, type LeadFilters } from "@/lib/leads/view";
import { LEAD_STAGES, type Segment } from "@/lib/leads/types";

const base = { override: null, companyType: null, biggestPermitUsd: null, approach: null, biggestJobType: null, listNames: [] };

test("segmentOf: Grande rules", () => {
  expect(segmentOf({ ...base, companyType: "developer" })).toBe("large");
  expect(segmentOf({ ...base, companyType: "property_manager" })).toBe("large");
  expect(segmentOf({ ...base, companyType: "builder", biggestPermitUsd: 500_000 })).toBe("large");
  expect(segmentOf({ ...base, companyType: "builder", biggestPermitUsd: 499_999 })).toBeNull();
  expect(segmentOf({ ...base, approach: "supplier_signup" })).toBe("large");
  for (const n of ["Administradoras Boston", "INCORPORADORAS 2026", "Construção COMERCIAL", "BERDO lista"])
    expect(segmentOf({ ...base, listNames: [n] })).toBe("large");
});

test("segmentOf: Residencial rules, Grande wins a conflict", () => {
  expect(segmentOf({ ...base, listNames: ["Residencial Worcester"] })).toBe("residential");
  expect(segmentOf({ ...base, listNames: ["EMPREITEIROS MA"] })).toBe("residential");
  expect(segmentOf({ ...base, biggestJobType: "Single-family residential", biggestPermitUsd: 120_000 })).toBe("residential");
  expect(segmentOf({ ...base, biggestJobType: "Single-family residential", biggestPermitUsd: 600_000 })).toBe("large");
  expect(segmentOf({ ...base, companyType: "developer", listNames: ["Residencial"] })).toBe("large");
  expect(segmentOf(base)).toBeNull();
});

test("segmentOf: commercial job types are not Residencial", () => {
  for (const t of ["Non-residential alteration", "Nonresidential", "Warehouse fit-out"])
    expect(segmentOf({ ...base, biggestJobType: t, biggestPermitUsd: 120_000 })).toBeNull();
  expect(segmentOf({ ...base, biggestJobType: "Single-family house", biggestPermitUsd: 120_000 })).toBe("residential");
});

test("segmentOf: manual override wins, null falls back to derived", () => {
  expect(segmentOf({ ...base, companyType: "developer", override: "residential" })).toBe("residential");
  expect(segmentOf({ ...base, override: "small" })).toBe("small");
  expect(segmentOf({ ...base, companyType: "developer", override: null })).toBe("large");
});

test("stageOf follows the spec table; won/lost/discarded are 'closed'", () => {
  const s = (status: string, first: string | null = null) => stageOf({ status: status as never, first_contacted_at: first });
  expect(s("new")).toBe("new");
  expect(s("new", "2026-11-01T00:00:00Z")).toBe("contacted");
  expect(s("call_list")).toBe("contacted");
  expect(s("in_campaign")).toBe("contacted");
  expect(s("replied")).toBe("replied");
  expect(s("with_closer")).toBe("meeting");
  expect(s("meeting")).toBe("meeting");
  for (const x of ["won", "lost", "discarded"]) expect(s(x)).toBe("closed");
  expect(LEAD_STAGES).not.toContain("archived");
});

let n = 0;
function row(name: string, o: { status?: string; segment?: Segment | null; origins?: string[]; temp?: string | null; first?: string | null } = {}): FilterRow {
  n += 1;
  return {
    lead: {
      id: `l${n}`, status: o.status ?? "new", level: 1, origin_kind: "import", origin_agent_id: null, first_contacted_at: o.first ?? null,
      last_touch_at: null, segment: null,
    },
    best: o.temp ? ({ id: `c${n}`, name, temperature: o.temp, approach: null, company_type: "other", total_value_usd: null, biggest_job_value_usd: null, biggest_job_type: null, biggest_job_address: null, permit_count: null, entry_path: null, second_pass: null } as never) : null,
    display: { name, city: null, phone: null, website: null, email: null },
    segment: o.segment ?? null,
    origins: (o.origins ?? []).map((x) => ({ name: x, at: "2026-11-01", kind: "list" as const })),
  } as FilterRow;
}

const rows = [row("a"), row("b", { status: "replied" }), row("c", { status: "lost" })];
const names = (f: Partial<LeadFilters>, rs = rows) => filterLeads(rs, { ...DEFAULT_LEAD_FILTERS, ...f }).map((i) => i.display.name);

test("filterLeads: stage 'all' shows every lead; lost is under 'closed'", () => {
  expect(names({ stage: "all" })).toEqual(["a", "b", "c"]);
  expect(names({ stage: "closed" })).toEqual(["c"]);
  expect(names({ stage: "replied" })).toEqual(["b"]);
});

test("filterLeads: segment tabs, lists any-origin, temperature 'none'", () => {
  const rs = [
    row("a", { segment: "large", origins: ["L1"] }),
    row("b", { segment: "small", origins: ["L2", "L3"], temp: "hot" }),
    row("c"),
  ];
  expect(names({ segment: "large" }, rs)).toEqual(["a"]);
  expect(names({ segment: "none" }, rs)).toEqual(["c"]);
  expect(names({ segment: "all" }, rs).sort()).toEqual(["a", "b", "c"]);
  expect(names({ lists: ["L3", "L1"] }, rs).sort()).toEqual(["a", "b"]);
  expect(names({ temperature: "none" }, rs).sort()).toEqual(["a", "c"]);
  expect(names({ temperature: "hot" }, rs)).toEqual(["b"]);
});

test("leadFacetsOf: stage counts sum to every lead; segment counts sum to segments.all", () => {
  const rs = [
    row("a"), row("b", { first: "2026-11-01T00:00:00Z", segment: "large" }), row("c", { status: "replied", segment: "small" }),
    row("d", { status: "meeting", segment: "residential" }), row("e", { status: "won" }), row("f", { status: "discarded", segment: "large" }), row("g", { status: "lost", segment: "large" }),
  ];
  const facets = leadFacetsOf(rs, DEFAULT_LEAD_FILTERS);
  expect(Object.values(facets.stages).reduce((a, b) => a + b, 0)).toBe(7);
  expect(facets.segments.none + facets.segments.residential + facets.segments.small + facets.segments.large).toBe(facets.segments.all);
  for (const st of LEAD_STAGES) expect(facets.stages[st]).toBe(filterLeads(rs, { ...DEFAULT_LEAD_FILTERS, stage: st }).length);
});

test("activeFilterKeys: legacy hidden filters always surface as chips", () => {
  expect(activeFilterKeys(DEFAULT_LEAD_FILTERS)).toEqual([]);
  const f = parseLeadFilters({ contact: "new", tab: "signal", minPermitUsd: 500_000, companyTypes: ["builder"], q: "acme", stage: "new", segment: "large" });
  expect(new Set(activeFilterKeys(f))).toEqual(new Set(["contact", "tab", "minPermitUsd", "companyTypes"]));
});

test("parseLeadFilters keeps stage, segment, lists and temperature 'none'", () => {
  const f = parseLeadFilters({ stage: "closed", segment: "none", lists: ["X"], temperature: "none" });
  expect(f).toMatchObject({ stage: "closed", segment: "none", lists: ["X"], temperature: "none" });
  // an old saved view with the removed "archived" stage keeps its other filters; only the stage falls back
  expect(parseLeadFilters({ stage: "archived", segment: "large", lists: ["X"] })).toEqual({ ...DEFAULT_LEAD_FILTERS, segment: "large", lists: ["X"] });
  expect(parseLeadFilters({ stage: "bogus" })).toEqual(DEFAULT_LEAD_FILTERS);
});

function prow(name: string, o: { phone?: string; email?: string; website?: string; temp?: "hot" | "warm" | "cold"; level?: number; status?: string; first?: string } = {}): FilterRow {
  return {
    lead: { id: name, status: o.status ?? "new", level: o.level ?? 0, origin_kind: "import", origin_agent_id: null, first_contacted_at: o.first ?? null, last_touch_at: null, segment: null, first_seen_at: "2026-01-01T00:00:00Z" },
    best: o.temp ? ({ temperature: o.temp } as never) : null,
    display: { name, city: null, phone: o.phone ?? null, website: o.website ?? null, email: o.email ?? null },
    segment: null,
    origins: [],
  } as FilterRow;
}

test("filterLeads: default order is the fila do dia (phone, temperature, never contacted, Dados, e-mail, name; closed last)", () => {
  const rs = [
    prow("closed", { phone: "1", temp: "hot", status: "won" }),
    prow("email-only", { email: "a@b.co", temp: "hot" }),
    prow("phone-cold", { phone: "1", temp: "cold" }),
    prow("phone-hot-contacted", { phone: "1", temp: "hot", first: "2026-11-01T00:00:00Z" }),
    prow("phone-hot-new-l1", { phone: "1", temp: "hot", level: 1 }),
    prow("phone-hot-new-l3", { phone: "1", temp: "hot", level: 3 }),
    prow("phone-hot-new-l1-email", { phone: "1", temp: "hot", level: 1, email: "x@y.co" }),
    prow("phone-hot-new-l1-b", { phone: "1", temp: "hot", level: 1, email: "x@y.co" }),
  ];
  expect(names({}, rs)).toEqual([
    "phone-hot-new-l3", "phone-hot-new-l1-b", "phone-hot-new-l1-email", "phone-hot-new-l1", "phone-hot-contacted", "phone-cold", "email-only", "closed",
  ]);
});

test("siteNoEmail facet: filters, counts, ignores its own filter in the count", () => {
  const rs = [prow("a", { website: "a.com" }), prow("b", { website: "b.com", email: "x@b.com" }), prow("c"), prow("d", { website: " " })];
  expect(names({ siteNoEmail: true }, rs)).toEqual(["a"]);
  expect(leadFacetsOf(rs, DEFAULT_LEAD_FILTERS).siteNoEmail).toBe(1);
  expect(leadFacetsOf(rs, { ...DEFAULT_LEAD_FILTERS, siteNoEmail: true }).siteNoEmail).toBe(1);
  expect(activeFilterKeys({ ...DEFAULT_LEAD_FILTERS, siteNoEmail: true })).toEqual(["siteNoEmail"]);
});

test("temperature 'none' = no research: level 4 without research is in, researched with null temperature is out; named temps use the effective one", () => {
  const l4 = prow("l4", { level: 4 });
  const researched = { ...prow("res"), best: { temperature: null } as never } as FilterRow;
  const coldL4 = prow("cold4", { level: 4, temp: "cold" });
  const rs = [l4, researched, coldL4];
  expect(names({ temperature: "none" }, rs)).toEqual(["l4"]);
  expect(names({ temperature: "hot" }, rs).sort()).toEqual(["cold4", "l4"]);
});

test("find-email set and facet leave closed leads out", () => {
  const rs = [prow("a", { website: "a.com" }), prow("w", { website: "w.com", status: "won" }), prow("l", { website: "l.com", status: "lost" }), prow("d", { website: "d.com", status: "discarded" })];
  expect(names({ siteNoEmail: true }, rs)).toEqual(["a"]);
  expect(rs.filter(hasSiteNoEmail).length).toBe(1);
  expect(leadFacetsOf(rs, DEFAULT_LEAD_FILTERS).siteNoEmail).toBe(1);
});
