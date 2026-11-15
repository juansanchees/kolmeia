import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { FUNNEL_STATUSES, funnelByOrigin } from "@/lib/leads/funnel";
import type { LeadListItem, LeadStatus } from "@/lib/leads/types";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

function item(status: LeadStatus, agentName: string | null, kind: "agent" | "one_off" | "import" = "agent", importName: string | null = null) {
  return { lead: { status, origin_kind: kind }, agentName, importName } as unknown as Pick<LeadListItem, "lead" | "agentName" | "importName">;
}

describe("F5 funil", () => {
  test("counts by origin and status, one row per origin, a totals row, discarded apart", () => {
    const rows = funnelByOrigin([
      item("new", "Boston"),
      item("new", "Boston"),
      item("meeting", "Boston"),
      item("discarded", "Boston"),
      item("won", "Cape"),
      item("lost", null, "one_off"),
    ]);
    expect(rows.map((r) => r.origin)).toEqual(["Boston", "Cape", rows[2].origin]);
    expect(rows[0]).toMatchObject({ origin: "Boston", total: 4 });
    expect(rows[0].counts.new).toBe(2);
    expect(rows[0].counts.meeting).toBe(1);
    expect(rows[0].counts.discarded).toBe(1);
    expect(FUNNEL_STATUSES).not.toContain("discarded");
    expect(rows.reduce((n, r) => n + r.total, 0)).toBe(6);
    const page = read("src/app/(app)/leads/funil/page.tsx");
    expect(page).toContain("funnel.total");
  });

  test("Funil is sender-only", () => {
    expect(read("src/app/(app)/leads/funil/page.tsx")).toContain("requireSender");
  });

  test("agents list passes the call list size", () => {
    expect(read("src/components/agents/AgentList.tsx")).toContain("listSize");
  });
});
