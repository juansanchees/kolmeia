import { describe, expect, test } from "vitest";
import { baselineReport, parseCsv, reportMarkdown, rowsFromCsv } from "@/lib/leads/baseline";
import { toCsv } from "@/lib/research/sheet";
import type { CandidateRow } from "@/lib/research/rows";

const candidate = (over: { name: string; phone?: string; website?: string }) => ({ phone: null, website: null, ...over }) as unknown as CandidateRow;

describe("baseline", () => {
  test("parseCsv handles quotes, commas, newlines inside quotes, CRLF and our BOM", () => {
    const text = '﻿a,b\r\n"x, y","line1\nline2"\r\n"say ""hi""",z\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b"],
      ["x, y", "line1\nline2"],
      ['say "hi"', "z"],
    ]);
    const rows = parseCsv(toCsv([candidate({ name: 'Acme, "Best" Builders' })]));
    expect(rows[1]).toContain('Acme, "Best" Builders');
  });

  test("rowsFromCsv reads Empresa, Telefone and Site from our export and from a gold sheet", () => {
    const ours = rowsFromCsv(toCsv([candidate({ name: "Acme Builders", phone: "+1 508-555-0100", website: "https://acme.example/" })]));
    expect(ours).toEqual([{ name: "Acme Builders", phone: "+1 508-555-0100", website: "https://acme.example/" }]);
    const gold = rowsFromCsv("Site,Empresa,Cidade,Telefone\nhttps://g.example,Gold Co,Boston,5085550111\nhttps://x.example,,Boston,5085550112\n");
    expect(gold).toEqual([{ name: "Gold Co", phone: "5085550111", website: "https://g.example" }]);
  });

  test("baselineReport: precision and coverage for Todos and Quentes, matching by name, domain or phone", () => {
    const r = baselineReport({
      found: [
        { name: "Acme Builders Inc" },
        { name: "Bay Dev", website: "https://bay.com" },
        { name: "Zeta", phone: "5085550199" },
        { name: "Unknown Co" },
      ],
      all: [
        { name: "ACME BUILDERS" },
        { name: "Bay Developers", website: "https://www.bay.com" },
        { name: "Zeta Homes", phone: "+1 508 555 0199" },
        { name: "Other1" },
        { name: "Other2" },
      ],
      hot: [{ name: "Acme Builders" }],
      schedule: "weekly",
    });
    expect(r.all).toEqual({ gold: 5, matched: 3, precision: 0.75, coverage: 0.6 });
    expect(r.hot).toEqual({ gold: 1, matched: 1, precision: 0.25, coverage: 1 });
    expect(r.matches.map((m) => m.by)).toEqual(["name", "domain", "phone"]);
  });

  test("baselineReport on empty inputs is zeros, never NaN", () => {
    const r = baselineReport({ found: [], all: [], hot: [], schedule: "once" });
    expect(r.all).toEqual({ gold: 0, matched: 0, precision: 0, coverage: 0 });
    expect(r.hot).toEqual({ gold: 0, matched: 0, precision: 0, coverage: 0 });
    expect(r.weeklyGoal).toBe(0);
    expect(r.matches).toEqual([]);
  });

  test("weeklyGoal is the run's company count per week by schedule; the markdown says Juan decides", () => {
    const found = [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }];
    expect(baselineReport({ found, all: [], hot: [], schedule: "weekly" }).weeklyGoal).toBe(4);
    const daily = baselineReport({ found, all: [], hot: [], schedule: "daily" });
    expect(daily.weeklyGoal).toBe(28);
    const md = reportMarkdown(daily, { agentName: "Caçador X", runDate: "14/11/2026", alreadyKnown: 2 });
    expect(md).toContain("(o Juan decide)");
    expect(md).toContain("Proposta de meta semanal: 28 leads novos com prova (o Juan decide).");
    expect(md).toContain("Caçador X");
  });
});
