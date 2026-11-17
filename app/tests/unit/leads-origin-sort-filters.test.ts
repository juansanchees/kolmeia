import { describe, expect, it } from "vitest";
import { activeFilterKeys, clearPatch, DEFAULT_LEAD_FILTERS, enteredOk, filterLeads, filtersFromParams, lastTouchOk, leadFacetsOf, originKeysOf, parseLeadFilters, roleOf, sortRows, type FilterRow } from "@/lib/leads/view";

type Opt = { agent?: string | null; lists?: string[]; kind?: "import" | "agent" | "one_off"; importName?: string | null; seen?: string; touch?: string | null; phone?: string; contact?: string; title?: string };
function row(name: string, o: Opt = {}): FilterRow {
  return {
    lead: { id: name, status: "new", level: 0, origin_kind: o.kind ?? "import", origin_agent_id: null, first_contacted_at: null, last_touch_at: o.touch ?? null, segment: null, first_seen_at: o.seen ?? "2026-01-01T12:00:00Z" },
    best: null,
    display: { name, city: null, phone: o.phone ?? null, website: null, email: null, contactName: o.contact ?? null, contactTitle: o.title ?? null },
    agentName: o.agent ?? null,
    importName: o.importName ?? null,
    origins: (o.lists ?? []).map((n) => ({ name: n, at: "2026-01-01T00:00:00Z", kind: "list" as const })),
  } as FilterRow;
}
const ids = (rows: FilterRow[]) => rows.map((r) => r.lead.id);
const base = { ...DEFAULT_LEAD_FILTERS };

describe("origin filter", () => {
  const rows = [
    row("A", { kind: "agent", agent: "Caçador X", lists: ["Lista 1"] }),
    row("B", { lists: ["Lista 1", "Lista 2"] }),
    row("C", { kind: "agent", agent: "Caçador X" }),
    row("D", { importName: "Planilha Y" }),
    row("E", { kind: "one_off" }),
    row("F"),
  ];
  it("keys follow the Origem column, with label fallbacks", () => {
    expect(originKeysOf(rows[3])).toEqual(["Importado · Planilha Y"]);
    expect(originKeysOf(rows[4])).toEqual(["Pesquisa avulsa"]);
    expect(originKeysOf(rows[5])).toEqual(["Importado"]);
    expect(originKeysOf(rows[0]).sort()).toEqual(["Caçador X", "Lista 1"]);
  });
  it("matches agent and list, and any list, not only the first", () => {
    expect(ids(filterLeads(rows, { ...base, lists: ["Caçador X"] })).sort()).toEqual(["A", "C"]);
    expect(ids(filterLeads(rows, { ...base, lists: ["Lista 2"] }))).toEqual(["B"]);
    expect(ids(filterLeads(rows, { ...base, lists: ["Lista 1"] })).sort()).toEqual(["A", "B"]);
  });
  it("counts, highest first", () => {
    const l = leadFacetsOf(rows, base).lists;
    expect(l[0].n).toBe(2);
    expect(l.find((x) => x.value === "Lista 1")?.n).toBe(2);
    expect(l.find((x) => x.value === "Importado · Planilha Y")?.n).toBe(1);
  });
});

describe("sort", () => {
  it("A-Z with accents, nulls last both ways", () => {
    const rs = [row("Zé"), row("Ábaco"), row("Bola")];
    expect(ids(sortRows(rs, { key: "company", dir: "asc" }))).toEqual(["Ábaco", "Bola", "Zé"]);
    const t = [row("x", { touch: null }), row("y", { touch: "2026-02-01T00:00:00Z" }), row("z", { touch: "2026-03-01T00:00:00Z" })];
    expect(ids(sortRows(t, { key: "lastContact", dir: "asc" }))).toEqual(["y", "z", "x"]);
    expect(ids(sortRows(t, { key: "lastContact", dir: "desc" }))).toEqual(["z", "y", "x"]);
    expect(sortRows(t, null)).toBe(t);
  });
});

describe("date presets (New York days)", () => {
  // 15 Jun 2026 15:00 New York (EDT, UTC-4) = 19:00Z
  const now = new Date("2026-06-15T19:00:00Z");
  const edt = (d: string, hm = "00:00") => new Date(`2026-06-${d}T${hm}:00-04:00`).toISOString();
  it("entered: today starts at NY midnight; 7/30 include 6/29 days before", () => {
    expect(enteredOk(edt("15"), "today", now)).toBe(true);
    expect(enteredOk(edt("14", "23:59"), "today", now)).toBe(false);
    expect(enteredOk(edt("09"), "7", now)).toBe(true);
    expect(enteredOk(edt("08", "23:59"), "7", now)).toBe(false);
    expect(enteredOk(new Date("2026-05-17T00:00:00-04:00").toISOString(), "30", now)).toBe(true);
    expect(enteredOk(new Date("2026-05-16T23:59:00-04:00").toISOString(), "30", now)).toBe(false);
    expect(enteredOk(edt("14", "23:59"), "yesterday", now)).toBe(true);
    expect(enteredOk(edt("14", "00:00"), "yesterday", now)).toBe(true);
    expect(enteredOk(edt("13", "23:59"), "yesterday", now)).toBe(false);
    expect(enteredOk(edt("15"), "yesterday", now)).toBe(false); // today is not yesterday
    expect(enteredOk(null, "7", now)).toBe(false);
    expect(enteredOk(null, "all", now)).toBe(true);
  });
  it("NY day, not UTC: 02:00Z on the 16th is still the 15th in New York", () => {
    expect(enteredOk("2026-06-16T02:00:00Z", "today", new Date("2026-06-16T03:00:00Z"))).toBe(true);
    expect(enteredOk("2026-06-15T03:00:00Z", "today", new Date("2026-06-16T03:00:00Z"))).toBe(false);
  });
  it("last contact: never, older than N days", () => {
    expect(lastTouchOk(null, "never", now)).toBe(true);
    expect(lastTouchOk(edt("14"), "never", now)).toBe(false);
    expect(lastTouchOk(edt("08", "23:59"), "7", now)).toBe(false);
    expect(lastTouchOk(edt("07", "23:59"), "7", now)).toBe(true);
    expect(lastTouchOk(null, "90", now)).toBe(false);
  });
});

describe("name, role, search, clear", () => {
  it("company contains / does not contain, accent and case insensitive; blank = no filter", () => {
    const rs = [row("Construções Silva"), row("Realty Group")];
    expect(ids(filterLeads(rs, { ...base, nameQ: "CONSTRUCOES" }))).toEqual(["Construções Silva"]);
    expect(ids(filterLeads(rs, { ...base, nameQ: "realty", nameNot: true }))).toEqual(["Construções Silva"]);
    expect(ids(filterLeads(rs, { ...base, nameQ: "  " }))).toHaveLength(2);
    expect(activeFilterKeys({ ...base, nameQ: "  " })).not.toContain("nameQ");
  });
  it("clearing the name chip also resets contains/not", () => {
    const f = { ...base, nameQ: "x", nameNot: true };
    expect(clearPatch(activeFilterKeys(f))).toMatchObject({ nameQ: "", nameNot: false });
    expect(clearPatch(["entered"])).toEqual({ entered: "all" });
  });
  it("role classifier", () => {
    expect(roleOf("Co-Founder & President")).toBe("owner");
    expect(roleOf("President")).toBe("owner");
    expect(roleOf("Vice President of Operations")).toBe("other");
    expect(roleOf("Assistant to the President")).toBe("other");
    expect(roleOf("Senior Estimator")).toBe("estimator");
    expect(roleOf("Pre-Construction Manager")).toBe("estimator");
    expect(roleOf("Project Manager")).toBe("pm");
    expect(roleOf("PM")).toBe("pm");
    expect(roleOf("Sócio")).toBe("owner");
    expect(roleOf("Office Admin")).toBe("other");
    expect(roleOf("")).toBeNull();
    expect(roleOf(null)).toBeNull();
  });
  it("role and contact-name filters", () => {
    const rs = [row("A", { title: "Owner", contact: "Ana" }), row("B", { title: "Admin" }), row("C")];
    expect(ids(filterLeads(rs, { ...base, role: "owner" }))).toEqual(["A"]);
    expect(ids(filterLeads(rs, { ...base, role: "other" }))).toEqual(["B"]);
    expect(ids(filterLeads(rs, { ...base, hasContactName: true }))).toEqual(["A"]);
  });
  it("search covers contact name and phone in any format", () => {
    const rs = [row("A", { phone: "+1 (508) 290-6144", contact: "João Souza" }), row("B", { phone: "617-555-0100" })];
    expect(ids(filterLeads(rs, { ...base, q: "508.290.6144" }))).toEqual(["A"]);
    expect(ids(filterLeads(rs, { ...base, q: "joao" }))).toEqual(["A"]);
  });
  it("an old saved view without the new keys loads with defaults", () => {
    expect(parseLeadFilters({ q: "x", lists: ["L"], cities: ["Boston"] })).toEqual({ ...DEFAULT_LEAD_FILTERS, q: "x", lists: ["L"], cities: ["Boston"] });
  });
});

describe("filtersFromParams (Home's Analisar links)", () => {
  const from = (q: string) => filtersFromParams((k) => new URLSearchParams(q).get(k));
  it("reads entered, segment and noName", () => {
    expect(from("entered=yesterday")).toEqual({ entered: "yesterday" });
    expect(from("segment=large&noName=1")).toEqual({ segment: "large", noContactName: true });
    expect(from("segment=none")).toEqual({ segment: "none" });
  });
  it("ignores unknown values", () => {
    expect(from("entered=lastyear&segment=huge&noName=yes")).toEqual({});
    expect(from("entered=all&segment=all")).toEqual({});
    expect(from("")).toEqual({});
  });
  it("noName keeps only companies without a contact name", () => {
    const f = { ...DEFAULT_LEAD_FILTERS, noContactName: true };
    const row = (contactName: string | null) => ({ lead: { id: "x", first_seen_at: "2026-05-15T12:00:00Z", last_touch_at: null }, best: null, display: { name: "Co", contactName }, segment: "large" }) as unknown as FilterRow;
    expect(filterLeads([row(null), row("Ana"), row("  ")], f)).toHaveLength(2);
    expect(activeFilterKeys(f)).toEqual(["noContactName"]);
  });
});
