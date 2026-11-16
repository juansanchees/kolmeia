import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("leads list UI rework", () => {
  const table = read("src/components/leads/LeadsTable.tsx");
  test("old layers are gone", () => {
    for (const s of ["SHORTCUTS", "CONTACT_TABS", "LEAD_TABS", "t.leads.columns.proof", "t.leads.columns.approach"]) expect(table).not.toContain(s);
  });
  test("new layout pieces are wired", () => {
    for (const s of ["LEAD_STAGES", "facets.stages", "facets.segments", "activeFilterKeys(", "SelectionBar", "originText(", "openedFromList", "usePaged(", "leadsCsvAction"]) expect(table).toContain(s);
    expect(table).toMatch(/setTimeout\([\s\S]{0,200}?200\)/); // 200 ms debounce
  });
  test("counts and lookups are memoized, not recomputed in JSX", () => {
    expect(table).not.toMatch(/items\.filter\([^)]*leadInTab/);
    expect(table).not.toMatch(/items\.find\(/);
    expect(table.match(/useMemo\(/g)!.length).toBeGreaterThanOrEqual(4);
  });
  test("selection bar archives, unarchives and sets type in bulk", () => {
    const bar = read("src/components/leads/SelectionBar.tsx");
    for (const s of ["archiveLeadsAction", "unarchiveLeadsAction", "setLeadSegmentAction", "t.leads.archive.confirm", "AddToList", "EmailTools"]) expect(bar).toContain(s);
  });
  test("Filtros panel has origin list, 'Sem pesquisa' and agent", () => {
    const p = read("src/components/leads/FacetPanel.tsx");
    for (const s of ["facets.lists", "noResearch", "agents"]) expect(p).toContain(s);
  });
  test("bulk results stay visible after the selection bar unmounts", () => {
    const bar = read("src/components/leads/SelectionBar.tsx");
    expect(table).toContain('role="status"');
    expect(table).toContain("onResult={");
    expect(bar).toMatch(/onResult\(noticeOf\(await setLeadSegmentAction\(/);
    expect(bar).toMatch(/onResult\(noticeOf\(await \(archivedTab \? unarchiveLeadsAction/);
    expect(bar).toContain("onDone={() => router.refresh()}"); // EmailTools keeps the selection and its own result
  });
  test("a failed CSV never leaves an unhandled rejection", () => {
    expect(table).toMatch(/try \{[\s\S]{0,200}?leadsCsvAction\(/);
    expect(table).toContain("t.leads.toolbar.csvFailed");
  });
});
