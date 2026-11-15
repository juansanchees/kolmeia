import { describe, expect, test } from "vitest";
import { baselineReport } from "@/lib/leads/baseline";
import { cardLines, citeRows } from "@/lib/profile/view";
import type { LearnedProfile } from "@/lib/profile/types";

describe("profile card", () => {
  test("the card cites up to 5 row numbers per point, in the spec's order", () => {
    expect(citeRows([3, 1, 2])).toBe("(linhas 3, 1, 2)");
    expect(citeRows([1, 2, 3, 4, 5])).toBe("(linhas 1, 2, 3, 4, 5)");
    expect(citeRows([1, 2, 3, 4, 5, 6, 7])).toBe("(linhas 1, 2, 3, 4, 5…)");
    const p: LearnedProfile = {
      points: [
        { key: "where_to_find", text: "Listas de associações", rows: [9] },
        { key: "region", text: "Worcester", rows: [1, 2, 3, 4, 5, 6] },
        { key: "type", text: "Construtoras", rows: [1] },
        { key: "region", text: "Cape Cod", rows: [7] },
      ],
      filter: { companyTypes: [], towns: [] },
      searchQueries: [],
    };
    expect(cardLines(p).map((l) => [l.key, l.label, l.text, l.cite])).toEqual([
      ["type", "Tipo", "Construtoras", "(linhas 1)"],
      ["region", "Região", "Worcester", "(linhas 1, 2, 3, 4, 5…)"],
      ["region", "Região", "Cape Cod", "(linhas 7)"],
      ["where_to_find", "Onde achar", "Listas de associações", "(linhas 9)"],
    ]);
  });

  test("the profile gabarito scores a Caçador run against the training list", () => {
    const list = [{ name: "Alfa Obras" }, { name: "Beta Builders", website: "https://beta.example" }, { name: "Gama Homes" }, { name: "Delta Co" }];
    const found = [{ name: "ALFA OBRAS LLC" }, { name: "Beta Builders Inc", website: "https://www.beta.example/" }, { name: "Outra Empresa" }];
    const r = baselineReport({ found, all: list, hot: [], schedule: "weekly" });
    expect(r.all).toEqual({ gold: 4, matched: 2, precision: 0.667, coverage: 0.5 });
  });
});
