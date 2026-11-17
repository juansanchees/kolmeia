import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = (p: string) => readFileSync(p, "utf8");

describe("leads final review fixes", () => {
  it("shows the origin line only to senders", () => {
    expect(src("src/components/leads/LeadDetail.tsx")).toMatch(/\{sender && \(\s*<p[^>]*>\s*<span[^>]*>\{t\.leads\.origin\.cameFrom\}/);
  });
  it("sorts the csv items by the incoming id order", () => {
    expect(src("src/app/(app)/leads/lead-actions.ts")).toContain("items.sort(");
  });
  it("hides type tabs and the empty origin group for the closer", () => {
    expect(src("src/components/leads/LeadsTable.tsx")).toMatch(/\{canCreate && \(\s*<div role="group" aria-label=\{L\.segments\.label\}/);
    expect(src("src/components/leads/FacetPanel.tsx")).toContain('(c !== "origin" || lists.some((l) => l !== ptMessages.leads.origin.noneOption))');
  });
  it("reports the RPC count in bulk notices", () => {
    const s = src("src/app/(app)/leads/lead-actions.ts");
    expect(s).toContain('typeof data === "number" ? data');
    expect(s).not.toContain("n: ids.data.length })");
  });
});
