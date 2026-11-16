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
  test("type and archive controls are sender-only", () => {
    expect(detail).toMatch(/sender\s*&&[\s\S]{0,400}?LeadTypePicker/);
    expect(detail).toMatch(/sender\s*&&[\s\S]{0,600}?LeadArchiveButton/);
  });
  test("research section: temperature, approach, proof", () => {
    for (const s of ["research-title", "t.leads.research.temperature", "t.leads.research.approach", "proofCount("]) expect(detail).toContain(s);
  });
  test("archive button confirms before archiving, not before unarchiving", () => {
    const b = read("src/components/leads/LeadArchiveButton.tsx");
    expect(b).toContain("archiveLeadsAction([leadId])");
    expect(b).toContain("unarchiveLeadsAction([leadId])");
    expect(b).toContain("t.leads.archive.confirm");
  });
  test("type picker can clear the override back to automatic", () => {
    const p = read("src/components/leads/LeadTypePicker.tsx");
    expect(p).toContain("setLeadSegmentAction([leadId]");
    expect(p).toMatch(/\|\|\s*null/);
    expect(p).toContain("t.leads.segmentPick.auto");
  });
});
