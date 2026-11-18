import { describe, expect, test } from "vitest";
import { getOffer, OFFERS, toOpportunityRow } from "@/lib/offers";
import { hvacNewConstruction } from "@/lib/offers/hvac-new-construction";
import type { OfferInput } from "@/lib/offers/types";

const NOW = new Date("2026-11-18T00:00:00Z");
const base = (over: Partial<OfferInput["signal"]> = {}, rest: Partial<OfferInput> = {}): OfferInput => ({
  signal: { kind: "permit", source: "permit", source_ref: "t:1", address: "12 Example Rd, Unit 2", town: "Falmouth", work_class: "New Construction", use: "Residential", value_usd: 400000, issued_on: "2026-10-20", description: "New single family dwelling", source_url: "https://example.com/p1", ...over },
  company: { name: "Acme Builders LLC", phone: "508-555-0100" },
  link_status: "confirmed",
  contacts: {},
  ...rest,
});
const ev = (i: OfferInput, p?: Parameters<typeof hvacNewConstruction.evaluate>[2]) => hvacNewConstruction.evaluate(i, NOW, p);

describe("registry", () => {
  test("unknown id throws", () => expect(() => getOffer("nope")).toThrow(/unknown offer/));
  test("both offers resolve; toString is not an offer", () => {
    expect(getOffer("hvac_new_construction")).toBe(hvacNewConstruction);
    expect(Object.keys(OFFERS)).toContain("building_maintenance");
    expect(() => getOffer("toString")).toThrow();
  });
  test("building_maintenance stub: meta complete, evaluate not_implemented", () => {
    const o = getOffer("building_maintenance");
    expect(o.meta.audience).toBe("property_managers_condo_associations");
    expect(o.meta.signalCodes).toEqual(expect.arrayContaining(["portfolio_size", "berdo_covered_building", "aging_equipment"]));
    const v = o.evaluate(base(), NOW);
    expect(v.fit).toBe("no");
    expect(v.priorityCodes).toEqual(["not_implemented"]);
    expect(v.hookEn).toBeNull();
  });
});

describe("new_build", () => {
  test.each([["New dwelling", "confirmed"], ["new construction of commercial building", "confirmed"], ["ADU over garage", "confirmed"], ["Repair of roof", "no"], ["Install solar panels", "no"], ["Pool", "no"], ["Fence", "no"], ["Demolition of shed", "no"], ["Deck", "no"], ["Siding and windows", "no"], ["Interior work", "missing"]])("%s -> %s", (d, s) => {
    expect(ev(base({ description: d, work_class: "Misc", use: "" })).checks.new_build.state).toBe(s);
  });
  test("bare New work class counts unless a repair word appears", () => {
    expect(ev(base({ description: "", work_class: "New" })).checks.new_build.state).toBe("confirmed");
    expect(ev(base({ description: "pool", work_class: "New" })).checks.new_build.state).toBe("no");
  });
});

describe("recent", () => {
  test.each([["2026-10-20", "confirmed"], ["2026-05-22", "confirmed"], ["2026-05-21", "missing"], ["2025-11-18", "missing"], ["2025-11-17", "no"], [null, "no"]])("%s -> %s", (d, s) => {
    expect(ev(base({ issued_on: d })).checks.recent.state).toBe(s);
  });
  test("a no on recent makes fit no", () => expect(ev(base({ issued_on: "2024-01-01" })).fit).toBe("no"));
});

describe("hvac_fit", () => {
  test("new building of any value", () => expect(ev(base({ value_usd: 1000 })).checks.hvac_fit.state).toBe("confirmed"));
  test("value >= 150k on non-new work", () => expect(ev(base({ description: "interior fit-out", work_class: "Alteration", value_usd: 150000 })).checks.hvac_fit.state).toBe("confirmed"));
  test("below that: missing; other trade listed: missing with evidence", () => {
    const small = ev(base({ description: "interior fit-out", work_class: "Alteration", value_usd: 10000 }));
    expect(small.checks.hvac_fit.state).toBe("missing");
    expect(small.openQuestions).toContain("ask_hvac_scope");
    expect(ev(base({ description: "fit-out, mechanical by sub", work_class: "Alteration", value_usd: 10000 })).checks.hvac_fit.evidence).toBe("hvac_by_other_trade");
  });
});

describe("responsible_party and can_bid", () => {
  test("link confirmed -> confirmed", () => expect(ev(base()).checks.responsible_party.state).toBe("confirmed"));
  test("pending or none -> missing with ask_gc", () => {
    for (const link_status of ["pending", "none"] as const) {
      const v = ev(base({}, { link_status, company: null }));
      expect(v.checks.responsible_party.state).toBe("missing");
      expect(v.openQuestions).toContain("ask_gc");
    }
  });
  test("bids_url or vendor_portal_url -> can_bid confirmed; otherwise missing with ask_taking_bids", () => {
    expect(ev(base({}, { contacts: { bids_url: "https://example.com/bids", source_url: "https://example.com" } })).checks.can_bid).toEqual({ state: "confirmed", evidence: "https://example.com/bids", source_url: "https://example.com" });
    expect(ev(base({}, { contacts: { vendor_portal_url: "https://example.com/vendors" } })).checks.can_bid.state).toBe("confirmed");
    const v = ev(base());
    expect(v.checks.can_bid.state).toBe("missing");
    expect(v.openQuestions).toContain("ask_taking_bids");
  });
});

describe("fit", () => {
  test("yes needs new_build, recent and a contact path", () => {
    expect(ev(base()).fit).toBe("yes");
    expect(ev(base({}, { company: { name: "Acme Builders LLC" } })).fit).toBe("maybe");
    expect(ev(base({}, { company: { name: "Acme Builders LLC" }, contacts: { vendor_portal_url: "https://example.com/v" } })).fit).toBe("yes");
  });
  test("missing new_build is maybe", () => expect(ev(base({ description: "interior work", work_class: "Misc", use: "" })).fit).toBe("maybe"));
  test("no zeroes priority", () => {
    const v = ev(base({ description: "re-roof", work_class: "Misc" }));
    expect(v.fit).toBe("no");
    expect(v.priority).toBe(0);
    expect(v.priorityCodes).toContain("fails_new_build");
  });
  test("permit without company asks for GC but is kept", () => {
    const v = ev(base({}, { company: null, link_status: "none" }));
    expect(v.checks.responsible_party.state).toBe("missing");
    expect(v.openQuestions[0]).toBe("ask_gc");
    expect(v.fit).toBe("maybe");
  });
});

describe("priority", () => {
  test("table points add up", () => {
    const v = ev(base({ issued_on: "2026-11-10", value_usd: 600000 }));
    expect(v.priority).toBe(30 + 18 + 10 + 15 + 10);
    expect(v.priorityCodes).toEqual(["issued_30d", "value_500k", "new_build", "gc_confirmed", "contact_phone"]);
  });
  test("bid path scores higher than phone", () => {
    const a = ev(base({}, { contacts: { bids_url: "https://example.com/bids" } }));
    expect(a.priorityCodes).toContain("contact_bids");
  });
  test("clamped to 0..100", () => {
    const v = ev(base({ issued_on: "2026-11-10", value_usd: 5_000_000 }, { contacts: { bids_url: "https://example.com/b" } }), { preferKinds: ["single_family"] });
    expect(v.priority).toBeLessThanOrEqual(100);
  });
});

describe("hook", () => {
  test("gold style from evidence only", () => {
    expect(ev(base()).hookEn).toBe("Saw the Oct 2026 permit for new single family dwelling at 12 Example Rd in Falmouth — who's handling the HVAC?");
  });
  test("null without address or without date", () => {
    expect(ev(base({ address: null })).hookEn).toBeNull();
    expect(ev(base({ issued_on: null })).hookEn).toBeNull();
  });
  test("long work text cut to 6 words; no person name after 'for'", () => {
    const v = ev(base({ description: "New single family dwelling with attached garage and finished basement for Olive Owner" }));
    expect(v.hookEn).toContain("for new single family dwelling with attached at");
    expect(v.hookEn).not.toMatch(/Olive/);
  });
  test("under 300 chars", () => expect((ev(base({ address: "1 " + "x".repeat(400) })).hookEn ?? "").length).toBeLessThanOrEqual(300));
});

describe("building kind and params", () => {
  test.each([["24 units new apartments", undefined, "multifamily"], ["new building", 3, "multifamily"], ["2 units new house", undefined, "single_family"], ["new townhouses", undefined, "multifamily"], ["new ADU", undefined, "adu"], ["new commercial building", undefined, "commercial"]])("%s", (d, units, kind) => {
    expect(ev(base({ description: d, units: units ?? null, use: "" })).buildingKind).toBe(kind);
  });
  test("commercial by use code", () => expect(ev(base({ description: "new building", use: "COMM" })).buildingKind).toBe("commercial"));
  test("facts snapshot re-scores to the same verdict", () => {
    const v = ev(base());
    expect(ev(v.facts)).toEqual(v);
  });
  test("deprioritized kind and min value demote with codes", () => {
    const v = ev(base({ value_usd: 100000 }), { deprioritizeKinds: ["single_family"], minValueUsd: 200000 });
    expect(v.priorityCodes).toEqual(expect.arrayContaining(["kind_deprioritized", "below_min_value"]));
    expect(v.priority).toBeLessThan(ev(base({ value_usd: 100000 })).priority);
  });
  test("preferred kind promotes", () => expect(ev(base(), { preferKinds: ["single_family"] }).priorityCodes).toContain("kind_preferred"));
  test("wantBidPath puts ask_taking_bids first and bid door first in the row", () => {
    const i = base({}, { contacts: { bids_url: "https://example.com/bids" } });
    expect(ev(base(), { wantBidPath: true }).openQuestions[0]).toBe("ask_taking_bids");
    expect(toOpportunityRow(ev(i), "hvac_new_construction", i).contact_path).toBe("phone");
    expect(toOpportunityRow(ev(i, { wantBidPath: true }), "hvac_new_construction", i, { wantBidPath: true }).contact_path).toBe("bids");
  });
});

describe("toOpportunityRow", () => {
  test("only keys kb_deliver accepts", () => {
    const i = base();
    const row = toOpportunityRow(ev(i), "hvac_new_construction", i, undefined, "00000000-0000-0000-0000-000000000001");
    expect(Object.keys(row).sort()).toEqual(["checks", "contact_path", "contact_value", "hook_en", "kb_signal_id", "offer", "open_questions", "priority", "priority_codes", "signal_date", "source", "source_url", "title"]);
  });
});

describe("profileFit", () => {
  const f = hvacNewConstruction.meta.profileFit;
  test("hvac installer fits, with reasons", () => {
    const r = f({ what_we_do: "HVAC installation and heat pumps", service_area: "Cape Cod", wanted_work: ["new_construction", "multifamily"] });
    expect(r.score).toBe(80);
    expect(r.reasonCodes).toEqual(["does_hvac", "wants_new_construction", "wants_multifamily"]);
    expect(r.missing).toBeUndefined();
  });
  test("bakery gets zero; no region asks", () => {
    const r = f({ what_we_do: "Fresh bread", wanted_work: [] });
    expect(r.score).toBe(0);
    expect(r.missing).toBe("ask_region");
  });
  test("exclusion and assumption", () => {
    expect(f({ what_we_do: "hvac", service_area: "x", not_wanted: "no new construction", wanted_work: ["commercial"] }).reasonCodes).toContain("excluded_by_profile");
    expect(f({ what_we_do: "hvac", service_area: "x" }).assumptionCodes).toEqual(["assume_new_construction_ok"]);
  });
});
