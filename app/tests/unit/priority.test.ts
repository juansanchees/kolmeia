import { describe, expect, test } from "vitest";
import { priorityOf } from "@/lib/leads/classify";
import { toTableRow } from "@/lib/leads/table";
import type { LeadListItem } from "@/lib/leads/types";

const r = (o: { phone?: boolean; temp?: "very_hot" | "hot" | "warm" | "cold" | null; match?: boolean; status?: "new" | "call_list" | "lost"; contacted?: boolean; level?: number; email?: boolean } = {}) => ({
  lead: { status: o.status ?? "call_list", level: o.level ?? 0, first_contacted_at: o.contacted ? "2026-11-01T00:00:00Z" : null },
  best: { temperature: o.temp ?? null },
  display: { phone: o.phone ? "508-555-0101" : null, email: o.email ? "pat@acme.example" : null },
  profileMatch: o.match,
});

describe("priorityOf (Fila do dia)", () => {
  test("phone > temperature > fits the approved profile > never contacted > Dados > e-mail; closed last", () => {
    expect(priorityOf(r({ phone: true }))).toBeGreaterThan(priorityOf(r({ temp: "very_hot", match: true, level: 4, email: true })));
    expect(priorityOf(r({ temp: "warm" }))).toBeGreaterThan(priorityOf(r({ temp: "cold", match: true, status: "new", level: 3, email: true })));
    expect(priorityOf(r({ match: true }))).toBeGreaterThan(priorityOf(r({ status: "new", level: 3, email: true })));
    expect(priorityOf(r({ match: true })) - priorityOf(r())).toBe(200);
    expect(priorityOf(r({ match: false }))).toBe(priorityOf(r()));
    expect(priorityOf(r({ status: "lost", phone: true, match: true }))).toBe(-1);
  });

  test("the slim table row carries profileMatch", () => {
    const item = { lead: { id: "l1", segment: null }, best: null, display: { name: "Acme" }, agentName: null, importName: null, proofOk: 0, profileMatch: true } as unknown as LeadListItem;
    expect(toTableRow(item, []).profileMatch).toBe(true);
  });
});
