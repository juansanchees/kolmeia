import { describe, expect, test } from "vitest";
import type { CoverageRow } from "@/lib/kb/coverage";
import { proposeSearches } from "@/lib/hunt/proposals";

// Invented profiles only.
const HVAC = { what_we_do: "HVAC installation, heat pumps and service contracts", service_area: "Cape Cod, MA", wanted_work: ["new_construction", "multifamily", "maintenance"], good_customer: "Builders and property managers", not_wanted: "" };
const cov = (source: string, outcome: CoverageRow["outcome"]): CoverageRow => ({ town: "Exampleton", source, ran_at: "2026-11-01T00:00:00Z", outcome, queried: 1, rows_in: 1 });

describe("proposeSearches", () => {
  test("HVAC installer: new construction and building maintenance, different audiences and sources, one recommended", () => {
    const p = proposeSearches(HVAC, [cov("permit", "ok")]);
    expect(p.length).toBeGreaterThanOrEqual(2);
    expect(p.length).toBeLessThanOrEqual(3);
    const nc = p.find((x) => x.offer === "hvac_new_construction")!;
    const bm = p.find((x) => x.offer === "building_maintenance")!;
    expect(nc && bm).toBeTruthy();
    expect(nc.buyerCodes).not.toEqual(bm.buyerCodes);
    expect(nc.sourceCodes).not.toEqual(bm.sourceCodes);
    expect(p.filter((x) => x.recommended)).toHaveLength(1);
    expect(p[0].recommended).toBe(true);
    expect(p[0].offer).toBe("hvac_new_construction");
    expect(p[0].recommendReasonCodes).toEqual(["best_profile_fit", "coverage_ok"]);
    expect(nc.whyFitCodes).toContain("does_hvac");
    expect(p.every((x) => x.question === undefined)).toBe(true);
    // sorted by score
    expect(p.map((x) => x.score)).toEqual([...p.map((x) => x.score)].sort((a, b) => b - a));
  });

  test("bakery gets neither offer", () => {
    expect(proposeSearches({ what_we_do: "Fresh bread and pastries", service_area: "Exampleton", wanted_work: [] }, [])).toEqual([]);
  });

  test("no region: the recommended proposal asks for it", () => {
    const p = proposeSearches({ ...HVAC, service_area: "" }, []);
    expect(p[0].question).toBe("ask_region");
    expect(p.slice(1).every((x) => x.question === undefined)).toBe(true);
  });

  test("assumptions surface when the profile is silent on wanted work; blocked coverage is reported", () => {
    const p = proposeSearches({ ...HVAC, wanted_work: [] }, [cov("permit", "login")]);
    const nc = p.find((x) => x.offer === "hvac_new_construction")!;
    expect(nc.assumptionCodes).toContain("assume_new_construction_ok");
    expect(nc.recommendReasonCodes).toContain("coverage_blocked");
  });

  test("deterministic", () => expect(proposeSearches(HVAC, [])).toEqual(proposeSearches(HVAC, [])));
});
