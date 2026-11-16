import { beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_LEAD_FILTERS, leadsCsv, matchesFacets, parseLeadFilters } from "@/lib/leads/view";
import type { LeadListItem, LeadRow } from "@/lib/leads/types";
import { postponed, taskTab } from "@/lib/tasks/view";

vi.mock("server-only", () => ({}));
const getCurrentWorkspace = vi.fn();
const listCsv = vi.fn();
vi.mock("@/lib/workspace", () => ({ getCurrentWorkspace: () => getCurrentWorkspace() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ fake: true }) }));
vi.mock("@/lib/lists/queries", () => ({ listCsv: (...a: unknown[]) => listCsv(...a) }));
const { GET } = await import("@/app/api/leads/lists/[id]/csv/route");

const LIST = "11111111-1111-4111-8111-111111111111";
const get = (id = LIST) => GET(new Request(`https://app.example.com/api/leads/lists/${id}/csv`), { params: Promise.resolve({ id }) });

function item(o: Partial<LeadRow> & { city?: string | null; phone?: string | null; email?: string | null; name?: string } = {}): LeadListItem {
  const lead = {
    id: "l1", workspace_id: "w", best_candidate_id: null, status: "new", origin_kind: "import", origin_agent_id: null, origin_run_id: null,
    origin_import_id: null, owner_id: null, first_seen_at: "", last_seen_at: "", level: 1, level_note: null, handed_off_at: null, handed_off_by: null,
    closer_brief: null, do_not_call: false, do_not_call_at: null, first_contacted_at: null, last_touch_at: null, ...o,
  } as LeadRow;
  return { lead, best: null, display: { name: o.name ?? "Acme", city: o.city ?? null, phone: o.phone ?? null, website: null, email: o.email ?? null }, agentName: null, importName: null, proofOk: 0 };
}

describe("leads phase 1: facet filters on the client mirror lead_facets", () => {
  const f = DEFAULT_LEAD_FILTERS;
  test("contact tabs: new = never contacted", () => {
    const fresh = item();
    const done = item({ first_contacted_at: "2026-11-14T10:00:00Z" });
    expect([matchesFacets(fresh, { ...f, contact: "new" }), matchesFacets(done, { ...f, contact: "new" })]).toEqual([true, false]);
    expect([matchesFacets(fresh, { ...f, contact: "contacted" }), matchesFacets(done, { ...f, contact: "contacted" })]).toEqual([false, true]);
    expect([matchesFacets(fresh, f), matchesFacets(done, f)]).toEqual([true, true]);
  });
  test("city is trimmed, phone/e-mail must be non-blank, levels and origins are any-of", () => {
    expect(matchesFacets(item({ city: " Quincy " }), { ...f, cities: ["Quincy"] })).toBe(true);
    expect(matchesFacets(item({ city: null }), { ...f, cities: ["Quincy"] })).toBe(false);
    expect(matchesFacets(item({ phone: "  " }), { ...f, hasPhone: true })).toBe(false);
    expect(matchesFacets(item({ email: "a@x.example" }), { ...f, hasEmail: true })).toBe(true);
    expect(matchesFacets(item({ level: 2 }), { ...f, levels: [0, 2] })).toBe(true);
    expect(matchesFacets(item({ origin_kind: "agent" }), { ...f, origins: ["import"] })).toBe(false);
  });
  test("a saved view's filters are validated; junk falls back to the defaults", () => {
    expect(parseLeadFilters({ contact: "contacted", cities: ["Boston"] })).toEqual({ ...f, contact: "contacted", cities: ["Boston"] });
    expect(parseLeadFilters({ contact: "drop table" })).toEqual(f);
    expect(parseLeadFilters(null)).toEqual(f);
  });
});

describe("leads phase 1: tasks by New York day", () => {
  const now = new Date("2026-11-15T15:00:00Z"); // 10:00 in New York
  test("today / late / next", () => {
    expect(taskTab("2026-11-15T23:30:00Z", now)).toBe("today"); // 18:30 NY
    expect(taskTab("2026-11-16T04:30:00Z", now)).toBe("today"); // 23:30 NY, still the 15th
    expect(taskTab("2026-11-15T04:00:00Z", now)).toBe("late"); // 23:00 NY on the 14th
    expect(taskTab("2026-11-16T15:00:00Z", now)).toBe("next");
  });
  test("Adiar moves one day, and a late task lands in the future", () => {
    expect(postponed("2026-11-16T15:00:00Z", now)).toBe("2026-11-17T15:00:00.000Z");
    expect(postponed("2026-11-10T15:00:00Z", now)).toBe("2026-11-15T16:00:00.000Z");
  });
});

describe("GET /api/leads/lists/[id]/csv", () => {
  beforeEach(() => {
    getCurrentWorkspace.mockReset();
    listCsv.mockReset();
  });
  test("the closer is refused and nothing is read", async () => {
    getCurrentWorkspace.mockResolvedValue({ id: "w", name: "W", role: "closer" });
    expect((await get()).status).toBe(403);
    expect(listCsv).not.toHaveBeenCalled();
  });
  test("signed out: 401; a bad id: 404", async () => {
    getCurrentWorkspace.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect((await get("../x")).status).toBe(404);
  });
  test.each(["owner", "sdr"])("%s downloads the list as CSV with formulas escaped", async (role) => {
    getCurrentWorkspace.mockResolvedValue({ id: "w", name: "W", role });
    listCsv.mockResolvedValue({ name: "L", csv: leadsCsv([item({ name: "=HYPERLINK(\"http://x.example\")", city: "@SUM(A1)", phone: "+1 508-555-0199" })]) });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const body = await res.text();
    expect(body).toContain(`"'=HYPERLINK(""http://x.example"")"`);
    expect(body).toContain("'@SUM(A1)");
    expect(body).not.toMatch(/(^|,)[=@]/m);
    expect(body).toContain("+1 508-555-0199"); // a plain phone number is not a formula
    expect(listCsv).toHaveBeenCalledWith({ fake: true }, "w", LIST);
  });
});
