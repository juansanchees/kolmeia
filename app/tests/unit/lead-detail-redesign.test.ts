import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("lead modal redesign", () => {
  const detail = read("src/components/leads/LeadDetail.tsx");
  test("modal shows every origin list with its date, or 'Sem lista de origem'", () => {
    expect(detail).toContain("originListsOf(");
    expect(detail).toContain("t.leads.origin.cameFrom");
    expect(detail).toContain("t.leads.origin.none");
    expect(detail).not.toContain("t.qualifier.lists");
  });
  test("type control is sender-only; no archive", () => {
    expect(detail).toMatch(/sender\s*&&[\s\S]{0,400}?LeadTypePicker/);
    for (const s of ["LeadArchiveButton", "t.leads.archive", "lead.archived_at"]) expect(detail).not.toContain(s);
  });
  test("research section: temperature, approach, proof", () => {
    for (const s of ["research-title", "t.leads.research.temperature", "t.leads.research.approach", "proofCount("]) expect(detail).toContain(s);
  });
  test("type picker can clear the override back to automatic", () => {
    const p = read("src/components/leads/LeadTypePicker.tsx");
    expect(p).toContain("setLeadSegmentAction([leadId]");
    expect(p).toMatch(/\|\|\s*null/);
    expect(p).toContain("t.leads.segmentPick.auto");
  });
});
