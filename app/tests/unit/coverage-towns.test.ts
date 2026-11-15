import { describe, expect, it } from "vitest";
import { MA_COUNTIES, MA_TOWNS } from "@/lib/coverage/ma-towns";
import { foldPlace, townOf, townsInRegion } from "@/lib/coverage/region";

const inCounty = (c: string) => MA_TOWNS.filter((t) => t.county === c).map((t) => t.name);

describe("MA towns list", () => {
  it("351 unique towns in 14 counties; Barnstable County has 15", () => {
    expect(MA_TOWNS).toHaveLength(351);
    expect(new Set(MA_TOWNS.map((t) => t.name)).size).toBe(351);
    expect(MA_COUNTIES).toHaveLength(14);
    expect(inCounty("Barnstable")).toHaveLength(15);
    for (const c of MA_COUNTIES) expect(inCounty(c).length).toBeGreaterThanOrEqual(1);
    expect(MA_TOWNS.every((t) => (MA_COUNTIES as readonly string[]).includes(t.county))).toBe(true);
  });

  it("spot checks", () => {
    const c = (n: string) => MA_TOWNS.find((t) => t.name === n)?.county;
    expect(c("Boston")).toBe("Suffolk");
    expect(c("Worcester")).toBe("Worcester");
    expect(c("Millbury")).toBe("Worcester");
    expect(c("Springfield")).toBe("Hampden");
    expect(c("Barnstable")).toBe("Barnstable");
    expect(c("Nantucket")).toBe("Nantucket");
    expect(c("Plymouth")).toBe("Plymouth");
    expect(c("Cambridge")).toBe("Middlesex");
  });
});

describe("region", () => {
  it("foldPlace lowers, strips accents and punctuation", () => {
    expect(foldPlace("  São-Paulo,  MA. ")).toBe("sao paulo ma");
  });

  it("townOf folds case, spaces and a state suffix", () => {
    expect(townOf("BOSTON ")).toBe("Boston");
    expect(townOf("Boston, MA")).toBe("Boston");
    expect(townOf("boston massachusetts")).toBe("Boston");
    expect(townOf("Manchester by the Sea")).toBe("Manchester-by-the-Sea");
    expect(townOf("Bostonia")).toBeNull();
    expect(townOf(null)).toBeNull();
    expect(townOf("")).toBeNull();
  });

  it("townsInRegion: longest names first and whole words", () => {
    expect(townsInRegion("West Springfield and Andover").towns).toEqual(["West Springfield", "Andover"]);
    expect(townsInRegion("North Andover").towns).toEqual(["North Andover"]);
  });

  it("counties and Cape Cod", () => {
    const w = townsInRegion("Worcester County").towns;
    expect(w.slice().sort()).toEqual(inCounty("Worcester").sort());
    expect(w.length).toBeGreaterThan(1);
    expect(townsInRegion("Cape Cod").towns.slice().sort()).toEqual(inCounty("Barnstable").sort());
    expect(townsInRegion("condado de Norfolk").towns.slice().sort()).toEqual(inCounty("Norfolk").sort());
    const ann = townsInRegion("Cape Ann").towns;
    expect(ann.filter((t) => inCounty("Barnstable").includes(t))).toEqual([]);
  });

  it("statewide and outside MA", () => {
    expect(townsInRegion("Massachusetts")).toMatchObject({ towns: [], statewide: true });
    expect(townsInRegion("Providence, RI")).toMatchObject({ towns: [], outside: true });
    const r = townsInRegion("Boston, MA and Providence, RI");
    expect(r.towns).toEqual(["Boston"]);
    expect(r.outside).toBe(false);
  });
});
