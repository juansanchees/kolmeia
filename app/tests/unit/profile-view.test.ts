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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isUuid } from "@/lib/profile/view";
import { openProposalId } from "@/lib/profile/queries";

describe("F3c-3 Task 4 review fixes", () => {
  test("isUuid is strict: 36 hex-and-dash characters are not enough", () => {
    expect(isUuid("0b0e5a7e-1c2d-4e3f-8a9b-0123456789ab")).toBe(true);
    expect(isUuid("zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz")).toBe(false);
    expect(isUuid("------------------------------------")).toBe(false);
    expect(isUuid("0b0e5a7e1c2d4e3f8a9b0123456789ab")).toBe(false);
    const page = readFileSync(join(process.cwd(), "src/app/(app)/leads/perfil/[id]/page.tsx"), "utf8");
    expect(page).toContain("isUuid(id)");
  });
  test("the compare form uses the ASCII key cacador", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(app)/leads/perfil/[id]/page.tsx"), "utf8");
    expect(page).toContain('name="cacador"');
    expect(page).toContain(".cacador");
    expect(page).not.toContain("caçador");
  });
  test("an import with a proposed profile reuses it instead of a new AI call", async () => {
    const fake = (rows: { id: string }[]) => ({
      from: () => {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "order", "limit"]) q[m] = () => q;
        q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok);
        return q;
      },
    });
    expect(await openProposalId(fake([{ id: "p1" }]) as never, "imp")).toBe("p1");
    expect(await openProposalId(fake([]) as never, "imp")).toBeNull();
    const actions = readFileSync(join(process.cwd(), "src/app/(app)/leads/perfil/actions.ts"), "utf8");
    expect(actions.indexOf("openProposalId")).toBeGreaterThan(-1);
    expect(actions.indexOf("openProposalId")).toBeLessThan(actions.indexOf("learnProfile("));
  });
  test("the wizard does not link to a profile that cannot exist yet", () => {
    expect(readFileSync(join(process.cwd(), "src/components/imports/ImportWizard.tsx"), "utf8")).not.toContain("t.profile.see");
  });
});
