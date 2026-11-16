import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { originLabel } from "@/lib/leads/view";
import { originListsOf } from "@/lib/leads/queries";
import { originText, toTableRow } from "@/lib/leads/table";
import { TABLE_BEST_COLUMNS, type LeadListItem } from "@/lib/leads/types";

const read = (p: string) => readFileSync(p, "utf8");

const lead = {
  id: "l1", workspace_id: "w", best_candidate_id: "c1", status: "new", origin_kind: "import", origin_agent_id: null, origin_run_id: null,
  origin_import_id: "i1", owner_id: null, first_seen_at: "2026-11-01T00:00:00Z", last_seen_at: "2026-11-01T00:00:00Z", level: 2, level_note: null,
  handed_off_at: null, handed_off_by: null, closer_brief: { secret: "closer_brief" }, do_not_call: false, do_not_call_at: null,
  first_contacted_at: null, last_touch_at: null, archived_at: null, segment: null,
};
const importOnly = {
  lead, best: null, display: { name: "Acme Fictional", city: "Boston", phone: null, website: null, email: null }, agentName: null, importName: "Planilha", proofOk: 0,
} as unknown as LeadListItem;
const fullItem = {
  ...importOnly,
  best: { id: "c1", name: "Acme", hook: "long hook", notes: "long notes", temperature: "hot", approach: "direct", company_type: "builder", total_value_usd: 1, biggest_job_value_usd: 1, biggest_job_type: "x", biggest_job_address: "y", permit_count: 1, entry_path: null, second_pass: null },
} as unknown as LeadListItem;

test("toTableRow keeps only what the table uses", () => {
  const r = toTableRow(fullItem, []);
  expect(Object.keys(r.best!).sort()).toEqual([...TABLE_BEST_COLUMNS].sort());
  expect(Object.keys(r.lead).sort()).toEqual(["first_contacted_at", "id", "last_touch_at", "level", "origin_agent_id", "origin_kind", "segment", "status"]);
  expect(JSON.stringify(r)).not.toContain("closer_brief");
});

test("toTableRow: effective segment from origins and override", () => {
  expect(toTableRow(importOnly, [{ name: "Administradoras Boston", at: "2026-11-01T00:00:00Z", kind: "list" }]).segment).toBe("large");
  expect(toTableRow({ ...importOnly, lead: { ...importOnly.lead, segment: "small" } }, []).segment).toBe("small");
});

test("import-only lead with no visible lists: Sem tipo and originLabel fallback", () => {
  const r = toTableRow(importOnly, []);
  expect(r.segment).toBeNull();
  expect(originText(r)).toBe(originLabel(importOnly));
  expect(originText({ ...r, origins: [{ name: "Lista A", at: "2026-11-01T00:00:00Z", kind: "list" }] })).toBe("Lista A");
});

test("originListsOf merges imports and lists, skips undone imports, sorts by date, dedupes by name", async () => {
  const tables: Record<string, unknown[]> = {
    lead_import_rows: [
      { lead_id: "l1", import_id: "i1" }, { lead_id: "l1", import_id: "i2" }, { lead_id: "l2", import_id: "i3" },
    ],
    lead_imports: [
      { id: "i1", list_name: "Planilha Out", created_at: "2026-10-01T00:00:00Z", status: "done" },
      { id: "i2", list_name: "Antiga", created_at: "2026-09-01T00:00:00Z", status: "undone" },
      { id: "i3", list_name: "Outra", created_at: "2026-10-05T00:00:00Z", status: "undone" },
    ],
    list_leads: [
      { lead_id: "l1", list_id: "g1", added_at: "2026-11-02T00:00:00Z" }, { lead_id: "l1", list_id: "g2", added_at: "2026-11-03T00:00:00Z" },
    ],
    lists: [{ id: "g1", name: "Administradoras" }, { id: "g2", name: "Administradoras" }],
  };
  const db = {
    from(table: string) {
      const q = { select: () => q, in: () => q, then: (res: (v: unknown) => unknown) => res({ data: tables[table], error: null }) };
      return q;
    },
  };
  const map = await originListsOf(db as never, ["l1", "l2"]);
  expect(map.get("l1")).toEqual([
    { name: "Planilha Out", at: "2026-10-01T00:00:00Z", kind: "import" },
    { name: "Administradoras", at: "2026-11-02T00:00:00Z", kind: "list" },
  ]);
  expect(map.get("l2") ?? []).toEqual([]);
});

test("bulk status/segment/csv actions are sender-only, capped at 5000 and call the RPCs", () => {
  const code = read("src/app/(app)/leads/lead-actions.ts");
  // each body ends at the next function boundary, so one function's requireSender never counts for another
  const bodyOf = (fn: string) => {
    const m = new RegExp(`(?:export )?async function ${fn}\\b`).exec(code)!;
    const rest = code.slice(m.index + m[0].length);
    const next = rest.search(/\n(?:export )?async function /);
    return next < 0 ? rest : rest.slice(0, next);
  };
  for (const fn of ["setLeadsStatusAction", "setLeadSegmentAction", "leadsCsvAction"]) expect(bodyOf(fn)).toContain("requireSender");
  expect(bodyOf("setLeadsStatusAction")).toContain('z.enum(["lost", "discarded"])');
  expect(code).toContain('"set_leads_status"');
  expect(code).not.toMatch(/archive/i);
  expect(code).toContain('"set_leads_segment"');
  expect(code).toMatch(/\.max\(5000\)/);
});
