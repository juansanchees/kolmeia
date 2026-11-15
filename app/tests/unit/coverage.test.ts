import { describe, expect, it } from "vitest";
import { MA_TOWNS } from "@/lib/coverage/ma-towns";
import { townOf } from "@/lib/coverage/region";
import { COVERAGE_DAYS, coverageTable, huntHref, type CoverageSearch } from "@/lib/coverage/view";

const NOW = new Date("2026-11-14T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const s = (o: Partial<CoverageSearch>): CoverageSearch => ({ kind: "hunter", label: "x", regionText: null, towns: null, at: daysAgo(1), newCount: null, rows: null, ...o });
const row = (name: string, t: ReturnType<typeof coverageTable>) => t.towns.find((x) => x.name === name)!;
const run = (searches: CoverageSearch[], leadTowns = new Map<string, number>()) => coverageTable({ searches, leadTowns, now: NOW });

describe("coverage table", () => {
  it("a town is covered by a Caçador or search region, an import with leads there, or a manual mark; it expires after 90 days", () => {
    expect(COVERAGE_DAYS).toBe(90);
    const t = run([
      s({ regionText: "Millbury, MA" }),
      s({ kind: "research", regionText: "Worcester County", at: daysAgo(10) }),
      s({ kind: "import", towns: ["Cambridge"], rows: 5, newCount: 5 }),
      s({ kind: "manual", towns: ["Quincy"], at: "2026-11-01" }),
      s({ regionText: "Springfield, MA", at: daysAgo(90) }),
      s({ regionText: "Pittsfield, MA", at: daysAgo(91) }),
    ]);
    for (const n of ["Millbury", "Worcester", "Cambridge", "Quincy", "Springfield"]) expect(row(n, t).covered, n).toBe(true);
    expect(row("Pittsfield", t).covered).toBe(false);
    expect(row("Pittsfield", t).last).toBe(daysAgo(91));
    expect(row("Boston", t).covered).toBe(false);
    expect(row("Boston", t).last).toBeNull();
    expect(row("Millbury", t).searches).toBe(2);
  });

  it("an import with leads in Barnstable marks Barnstable", () => {
    const t = run([s({ kind: "import", towns: ["Barnstable"], rows: 3, newCount: 3 })], new Map([["Barnstable", 3]]));
    expect(row("Barnstable", t)).toMatchObject({ covered: true, leads: 3, searches: 1, county: "Barnstable" });
    expect(townOf("BOSTON , MA")).toBe("Boston");
  });

  it("lead counts per town and the summary over 351 towns", () => {
    const t = run([s({ regionText: "Boston, MA" }), s({ regionText: "Suffolk County" })], new Map([["Boston", 7], ["Revere", 2]]));
    expect(t.towns).toHaveLength(351);
    expect(row("Boston", t).leads).toBe(7);
    expect(row("Revere", t).leads).toBe(2);
    expect(t.summary).toEqual({ covered: 4, uncovered: 347 });
    expect(t.summary.covered + t.summary.uncovered).toBe(MA_TOWNS.length);
    const counties = t.towns.map((x) => x.county);
    expect(counties).toEqual([...counties].sort());
    expect(t.towns.slice(0, 2).map((x) => x.name)).toEqual([...t.towns.slice(0, 2).map((x) => x.name)].sort());
  });

  it("searches outside MA are counted apart and statewide ones mark no town", () => {
    const t = run([s({ regionText: "Providence, RI" }), s({ regionText: "Manchester, NH" }), s({ regionText: "Massachusetts" })]);
    expect(t.outside).toBe(2);
    expect(t.statewide).toBe(1);
    expect(t.summary.covered).toBe(0);
  });

  it("huntHref opens the Caçador with the town", () => {
    expect(huntHref("West Springfield")).toBe("/agentes/novo?regiao=West%20Springfield%2C%20MA");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMarkDate } from "@/lib/coverage/view";

describe("review fixes", () => {
  it("impossible dates are rejected, real ones in range pass", () => {
    expect(isMarkDate("2026-02-30", "2026-11-14")).toBe(false);
    expect(isMarkDate("2026-13-01", "2026-11-14")).toBe(false);
    expect(isMarkDate("2025-02-29", "2026-11-14")).toBe(false);
    expect(isMarkDate("2024-02-29", "2026-11-14")).toBe(true);
    expect(isMarkDate("2026-11-14", "2026-11-14")).toBe(true);
    expect(isMarkDate("2026-11-15", "2026-11-14")).toBe(false);
    expect(isMarkDate("2019-12-31", "2026-11-14")).toBe(false);
    expect(readFileSync(join(process.cwd(), "src/app/(app)/leads/cobertura/actions.ts"), "utf8")).toContain("isMarkDate(");
  });
  it("failed and cancelled runs do not cover", () => {
    expect(readFileSync(join(process.cwd(), "src/lib/coverage/queries.ts"), "utf8")).toMatch(/\.not\("status", "in", "\(failed,cancelled\)"\)/);
  });
});
