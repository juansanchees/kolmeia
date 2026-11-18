import { describe, expect, test } from "vitest";
import { reduceCoverage, type CoverageRow } from "@/lib/kb/coverage";

const r = (o: Partial<CoverageRow>): CoverageRow => ({ town: "Exampleton", source: "site_robot", ran_at: "2026-11-18T10:00:00Z", outcome: "ok", queried: 1, rows_in: 2, ...o });

describe("reduceCoverage", () => {
  test("one row per town and source, counts summed, latest time", () => {
    const out = reduceCoverage([r({}), r({ ran_at: "2026-11-18T11:00:00Z", rows_in: 3 }), r({ source: "permit" })]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ outcome: "ok", queried: 2, rows_in: 5, ran_at: "2026-11-18T11:00:00Z" });
  });
  test("ok mixed with a failure is partial, reasons kept", () => {
    const [x] = reduceCoverage([r({}), r({ outcome: "blocked", reason: "site blocked (403/429)" })]);
    expect(x.outcome).toBe("partial");
    expect(x.reason).toBe("site blocked (403/429)");
  });
  test("only failures: robots beats blocked beats down", () => {
    expect(reduceCoverage([r({ outcome: "down" }), r({ outcome: "robots" }), r({ outcome: "blocked" })])[0].outcome).toBe("robots");
    expect(reduceCoverage([r({ outcome: "down" }), r({ outcome: "blocked" })])[0].outcome).toBe("blocked");
  });
  test("town compare ignores case", () => expect(reduceCoverage([r({}), r({ town: "EXAMPLETON" })])).toHaveLength(1));
});
