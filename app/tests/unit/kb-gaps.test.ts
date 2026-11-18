import { describe, expect, test, vi } from "vitest";
import { resolveGaps, type GapDeps, type GapOpp } from "@/lib/kb/gaps";
import { contactPath } from "@/lib/offers/row";
import type { SiteRead } from "@/lib/qualifier/site/reader";

const facts = (phones: string[], links: string[]) => ({ name: null, phones: phones.map((value) => ({ value, url: "https://example.com", excerpt: "" })), emails: [], address: null, city: null, state: null, zip: null, links, text: "" });
const site = (o: Partial<SiteRead> & { phones?: string[]; links?: string[] } = {}): SiteRead => ({ outcome: o.outcome ?? "ok", finalHome: "https://example.com/", pages: o.outcome && o.outcome !== "ok" ? [] : [{ url: "https://example.com/", text: "", facts: facts(o.phones ?? [], o.links ?? []) }] });
const deps = (over: Partial<GapDeps> = {}): GapDeps => ({ live: true, now: () => new Date("2026-11-18T12:00:00Z"), readSite: async () => site(), ...over });
const opp = (over: Partial<GapOpp> = {}): GapOpp => ({
  signal: { kind: "permit", source: "permit", source_ref: "t:1", town: "Falmouth", permit_no: "P-1" },
  company: { name: "Acme Builders LLC", website: "https://example.com" },
  link_status: "confirmed",
  contacts: {},
  ...over,
});
const acme = { name: "Acme Builders LLC", phone: "508-555-0100", website: "https://example.com" };

describe("site step", () => {
  test("site 403 records blocked and continues", async () => {
    const r = await resolveGaps(opp(), deps({ readSite: async () => site({ outcome: "site_blocked" }) }));
    expect(r.coverage).toEqual([expect.objectContaining({ source: "site_robot", outcome: "blocked", town: "Falmouth" })]);
    expect(r.contacts).toEqual({});
  });
  test("a thrown 403 is blocked too, a timeout is down", async () => {
    expect((await resolveGaps(opp(), deps({ readSite: async () => { throw new Error("HTTP 403"); } }))).coverage[0].outcome).toBe("blocked");
    const t = await resolveGaps(opp(), deps({ readSite: async () => { throw new Error("timeout"); } }));
    expect(t.coverage[0]).toMatchObject({ outcome: "down", reason: "timeout" });
  });
  test("robots disallow records robots", async () => {
    const r = await resolveGaps(opp(), deps({ readSite: async () => site({ outcome: "robots" }) }));
    expect(r.coverage[0]).toMatchObject({ outcome: "robots", reason: "robots.txt disallows" });
  });
  test("live off records skipped and reads nothing", async () => {
    const readSite = vi.fn();
    const r = await resolveGaps(opp(), deps({ live: false, readSite }));
    expect(readSite).not.toHaveBeenCalled();
    expect(r.coverage[0]).toMatchObject({ outcome: "skipped", reason: "live off" });
  });
  test("vendor portal link sets contact_path vendor_portal; bids link and phone found", async () => {
    const r = await resolveGaps(opp(), deps({ readSite: async () => site({ links: ["https://example.com/vendor-portal", "https://example.com/about"] }) }));
    expect(r.contacts.vendor_portal_url).toBe("https://example.com/vendor-portal");
    expect(r.contacts.source_url).toBe("https://example.com/");
    expect(contactPath({ contacts: r.contacts }).path).toBe("vendor_portal");
    const b = await resolveGaps(opp(), deps({ readSite: async () => site({ phones: ["(508) 555-0111"], links: ["https://example.com/subcontractors"] }) }));
    expect(b.contacts).toMatchObject({ phone: "(508) 555-0111", bids_url: "https://example.com/subcontractors" });
  });
  test("wantBidPath reads the site before the lookups", async () => {
    const order: string[] = [];
    const d = deps({ readSite: async () => (order.push("site"), site()), byPermitNo: async () => (order.push("permit"), []) });
    await resolveGaps(opp({ link_status: "none" }), d, { wantBidPath: true });
    await resolveGaps(opp({ link_status: "none" }), d);
    expect(order).toEqual(["site", "permit", "permit", "site"]);
  });
});

describe("matching steps", () => {
  const unlinked = (extra: Partial<GapOpp> = {}) => opp({ company: null, link_status: "none", ...extra });
  test("permit number match confirms the link; later steps do not run", async () => {
    const byPhone = vi.fn();
    const r = await resolveGaps(unlinked(), deps({ byPermitNo: async () => [acme], byPhone }));
    expect(r.link).toMatchObject({ status: "confirmed", via: "permit_no" });
    expect(r.company?.name).toBe("Acme Builders LLC");
    expect(byPhone).not.toHaveBeenCalled();
    expect(r.coverage.map((c) => c.source)).toEqual(["kb_match:permit_no", "site_robot"]);
  });
  test("falls through: phone key, then name + town", async () => {
    const byPhone = vi.fn(async (k: string) => (k === "5085550123" ? [] : [acme]));
    const byNameTown = vi.fn(async (k: string, t: string) => (k === "pat person" && t === "Falmouth" ? [acme] : []));
    const r = await resolveGaps(unlinked({ applicant: { name: "Pat Person", phone: "(508) 555-0123" } }), deps({ byPermitNo: async () => [], byPhone, byNameTown }));
    expect(byPhone).toHaveBeenCalledWith("5085550123");
    expect(r.link).toMatchObject({ status: "confirmed", via: "name_town" });
    expect(r.coverage.slice(0, 3).map((c) => c.outcome)).toEqual(["empty", "empty", "ok"]);
  });
  test("two candidates stay pending, nothing guessed", async () => {
    const r = await resolveGaps(unlinked(), deps({ byPermitNo: async () => [acme, { name: "Acme Builders Inc" }] }));
    expect(r.link).toMatchObject({ status: "pending", candidates: [expect.anything(), expect.anything()] });
    expect(r.company).toBeNull();
    expect(r.coverage[0]).toMatchObject({ outcome: "partial", rows_in: 2 });
  });
  test("a lookup that throws records the failure and the next step runs", async () => {
    const r = await resolveGaps(unlinked({ applicant: { phone: "508-555-0123" } }), deps({ byPermitNo: async () => { throw new Error("db down"); }, byPhone: async () => [acme] }));
    expect(r.coverage[0]).toMatchObject({ source: "kb_match:permit_no", outcome: "down" });
    expect(r.link?.via).toBe("applicant_phone");
  });
  test("permit without company and no lookups: no link, no site row", async () => {
    const r = await resolveGaps(unlinked(), deps());
    expect(r.link).toBeUndefined();
    expect(r.company).toBeNull();
    expect(r.coverage).toEqual([]);
  });
  test("an already confirmed link skips the lookups", async () => {
    const byPermitNo = vi.fn();
    await resolveGaps(opp(), deps({ byPermitNo }));
    expect(byPermitNo).not.toHaveBeenCalled();
  });
});
