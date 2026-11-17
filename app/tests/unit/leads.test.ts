import { describe, expect, it } from "vitest";
import { t } from "@/messages/pt";
import type { CandidateRow } from "@/lib/research/rows";
import { DEFAULT_LEAD_FILTERS, displayOf, filterLeads, isStaleProof, leadsCsv, originLabel, proofCount } from "@/lib/leads/view";
import type { LeadFieldRow, LeadListItem, LeadRow, LeadStatus } from "@/lib/leads/types";

function cand(o: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: "c1", run_id: "r1", name: "Acme Builders", name_key: "acme builders", city: null, state: "MA", region: null, website: null, phone: null,
    public_email: null, email_type: null, company_type: "builder", size_note: null, temperature: null, approach: null, ask_for_name: null,
    ask_for_title: null, name_confidence: null, name_source_url: null, name_note: null, permit_count: null, total_value_usd: null,
    last_permit_date: null, biggest_job_address: null, biggest_job_value_usd: null, biggest_job_type: null, biggest_job_description: null,
    signal_match: null, google_rating: null, review_count: null, hook: null, supplier_portal_url: null, notes: null, user_decision: "pending",
    second_pass: null, is_partial: false, verified_at: "2026-11-01T00:00:00Z", entry_path: null, found_at_url: null, found_at_title: null,
    found_at_excerpt: null, found_at_seen_at: null, phone_source_url: null, email_source_url: null, rating_source_url: null,
    ...o,
  };
}

let n = 0;
function item(best: Partial<CandidateRow>, o: { status?: LeadStatus; agent?: string | null; agentName?: string | null; proofOk?: number; level?: number } = {}): LeadListItem {
  n += 1;
  const lead: LeadRow = {
    id: `l${n}`, workspace_id: "w", best_candidate_id: `c${n}`, status: o.status ?? "new",
    origin_kind: o.agent ? "agent" : "one_off", origin_agent_id: o.agent ?? null, origin_run_id: "r1", origin_import_id: null, owner_id: null,
    first_seen_at: "2026-11-01T00:00:00Z", last_seen_at: "2026-11-01T00:00:00Z", level: o.level ?? 0, level_note: null,
    handed_off_at: null, handed_off_by: null, closer_brief: null, do_not_call: false, do_not_call_at: null, first_contacted_at: null, last_touch_at: null, archived_at: null, segment: null,
  };
  const b = cand({ id: `c${n}`, ...best });
  return { lead, best: b, display: displayOf(b, []), agentName: o.agentName ?? null, importName: null, proofOk: o.proofOk ?? 0 };
}

function field(f: Partial<LeadFieldRow> & Pick<LeadFieldRow, "field" | "value">): LeadFieldRow {
  return { id: `f${f.field}${f.value}`, lead_id: "l", source: "import", source_ref: "imp1", status: "unverified", excerpt: null, seen_at: "2026-11-01T00:00:00Z", ...f };
}

function importOnly(fields: LeadFieldRow[], o: { importName?: string | null } = {}): LeadListItem {
  n += 1;
  const lead: LeadRow = {
    id: `l${n}`, workspace_id: "w", best_candidate_id: null, status: "new", origin_kind: "import", origin_agent_id: null, origin_run_id: null,
    origin_import_id: "imp1", owner_id: null, first_seen_at: "2026-11-01T00:00:00Z", last_seen_at: "2026-11-01T00:00:00Z", level: 0, level_note: null,
    handed_off_at: null, handed_off_by: null, closer_brief: null, do_not_call: false, do_not_call_at: null, first_contacted_at: null, last_touch_at: null, archived_at: null, segment: null,
  };
  return { lead, best: null, display: displayOf(null, fields), agentName: null, importName: o.importName === undefined ? "Lista Teste" : o.importName, proofOk: 0 };
}

describe("F3a leads", () => {
  it("isStaleProof: more than 90 days is stale; a bad date is not", () => {
    const now = new Date("2026-11-14T12:00:00Z");
    expect(isStaleProof("2026-08-15T11:00:00Z", now)).toBe(true);
    expect(isStaleProof("2026-08-16T12:00:00Z", now)).toBe(false);
    expect(isStaleProof("x", now)).toBe(false);
    expect(isStaleProof(null, now)).toBe(false);
    expect(isStaleProof(undefined, now)).toBe(false);
  });

  it("proofCount counts ok checks that carry evidence", () => {
    const ev = { url: "https://x.test", title: "t", excerpt: "e", seen_at: "2026-11-01T00:00:00Z" };
    expect(
      proofCount([
        { result: "ok", evidence: [ev] },
        { result: "ok", evidence: [] },
        { result: "no", evidence: [ev] },
        { result: "unknown", evidence: [] },
      ]),
    ).toBe(1);
  });

  it("filterLeads: search matches name, city and phone, ignoring case and accents", () => {
    const items = [
      item({ name: "ACME Builders", city: "Boston", phone: "+1 (508) 555-0199" }),
      item({ name: "Oak Homes", city: "Falmouth" }),
      item({ name: "Sao Construction" }),
    ];
    const f = (q: string) => filterLeads(items, { ...DEFAULT_LEAD_FILTERS, q }).map((i) => i.display.name);
    expect(f("acme")).toEqual(["ACME Builders"]);
    expect(f("falmouth")).toEqual(["Oak Homes"]);
    expect(f("5085550199")).toEqual(["ACME Builders"]);
    expect(f("são")).toEqual(["Sao Construction"]);
  });

  it("filterLeads: temperature, agent, \"Pesquisa avulsa\", status and tab; hottest first", () => {
    const items = [
      item({ name: "Cold Co", temperature: "cold", approach: "call" }, { agent: "a1" }),
      item({ name: "Hot Co", temperature: "hot", approach: "call" }, { agent: "a1", status: "replied" }),
      item({ name: "Very Co", temperature: "very_hot", approach: "call" }),
      item({ name: "Warm Co", temperature: "warm", approach: "email" }, { agent: "a2" }),
      item({ name: "Refuted Co", temperature: "hot", approach: "call", second_pass: "refuted" }),
    ];
    const names = (f: Partial<typeof DEFAULT_LEAD_FILTERS>) => filterLeads(items, { ...DEFAULT_LEAD_FILTERS, ...f }).map((i) => i.display.name);
    expect(names({})[0]).toBe("Very Co");
    expect(names({ temperature: "hot" })).toEqual(expect.arrayContaining(["Hot Co", "Refuted Co"]));
    expect(names({ temperature: "hot" })).toHaveLength(2);
    expect(names({ agent: "a1" })).toEqual(["Hot Co", "Cold Co"]);
    expect(names({ agent: "one_off" })).toEqual(["Very Co", "Refuted Co"]);
    expect(names({ status: "replied" })).toEqual(["Hot Co"]);
    expect(names({ tab: "call" })).not.toContain("Refuted Co");
    expect(names({ tab: "all" })).toContain("Refuted Co");
    const temps = filterLeads(items, DEFAULT_LEAD_FILTERS).map((i) => i.best?.temperature);
    expect(temps).toEqual(["very_hot", "hot", "hot", "warm", "cold"]);
  });

  it("originLabel: the agent's name, or \"Pesquisa avulsa\"", () => {
    expect(originLabel(item({}, { agent: "a1", agentName: "Caçador Cape" }), t)).toBe("Caçador Cape");
    expect(originLabel(item({}, { agent: "a1", agentName: null }), t)).toBe("Pesquisa avulsa");
    expect(originLabel(item({}), t)).toBe("Pesquisa avulsa");
  });

  it("leadsCsv: the research columns plus Status and Agente", () => {
    const csv = leadsCsv([item({ name: "Acme" }, { agent: "a1", agentName: "Cape" }), item({ name: "Oak" })], t);
    const rows = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(rows).toHaveLength(3);
    expect(rows[0].endsWith("Status,Agente")).toBe(true);
    expect(rows[1].endsWith("novo,Cape")).toBe(true);
    expect(rows[2].endsWith("novo,Pesquisa avulsa")).toBe(true);
  });

  it("displayOf prefers the best candidate and falls back to the oldest unrefuted field", () => {
    const best = cand({ name: "Acme Builders", phone: "+1 508-555-0100", city: null });
    const fields = [
      field({ field: "city", value: "Worcester" }),
      field({ field: "phone", value: "508-555-0111", seen_at: "2026-11-05T00:00:00Z" }),
    ];
    expect(displayOf(best, fields)).toEqual({ companyType: "builder", name: "Acme Builders", city: "Worcester", phone: "+1 508-555-0100", website: null, email: null, contactName: null, contactTitle: null });
    const only = [
      field({ field: "name", value: "Refuted Co", status: "refuted", seen_at: "2026-10-01T00:00:00Z" }),
      field({ field: "name", value: "Newer Name", seen_at: "2026-11-05T00:00:00Z" }),
      field({ field: "name", value: "Oldest Name", seen_at: "2026-11-02T00:00:00Z" }),
      field({ field: "email", value: "hi@acme.example" }),
    ];
    expect(displayOf(null, only)).toMatchObject({ name: "Oldest Name", email: "hi@acme.example", phone: null });
    expect(displayOf(null, []).name).toBe("(sem nome)");
  });

  it("filterLeads keeps import-only leads only in Todos and finds them by name, city and phone", () => {
    const imp = importOnly([field({ field: "name", value: "Acme Test Builders" }), field({ field: "city", value: "Millbury" }), field({ field: "phone", value: "508-555-0142" })]);
    const hot = item({ name: "Hot Co", temperature: "hot", approach: "call" });
    const items = [imp, hot];
    const names = (f: Partial<typeof DEFAULT_LEAD_FILTERS>) => filterLeads(items, { ...DEFAULT_LEAD_FILTERS, ...f }).map((i) => i.display.name);
    expect(names({})).toEqual(["Acme Test Builders", "Hot Co"]); // fila do dia: the one with a phone comes first
    expect(names({ tab: "call" })).toEqual(["Hot Co"]);
    expect(names({ tab: "new" })).toEqual([]);
    expect(names({ temperature: "hot" })).toEqual(["Hot Co"]);
    expect(names({ q: "acme test" })).toEqual(["Acme Test Builders"]);
    expect(names({ q: "millbury" })).toEqual(["Acme Test Builders"]);
    expect(names({ q: "5085550142" })).toEqual(["Acme Test Builders"]);
  });

  it("originLabel says Importado · list", () => {
    expect(originLabel(importOnly([field({ field: "name", value: "A" })]), t)).toBe("Importado · Lista Teste");
    expect(originLabel(importOnly([field({ field: "name", value: "A" })], { importName: null }), t)).toBe("Importado");
  });

  it("leadsCsv writes import-only leads and neutralises a formula from an import", () => {
    const evil = importOnly([
      field({ field: "name", value: '=HYPERLINK("http://x","y")' }),
      field({ field: "note", value: "=1+1" }),
      field({ field: "phone", value: "508-555-0142" }),
    ]);
    const csv = leadsCsv([evil, item({ name: "Oak" })], t);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csv).not.toContain("=1+1"); // a note is not exported
    const rows = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain("508-555-0142");
    expect(rows[1].endsWith("novo,Importado · Lista Teste")).toBe(true);
    expect(rows[2].endsWith("novo,Pesquisa avulsa")).toBe(true);
  });

  it("filterLeads keeps leads at or above the chosen level", () => {
    const items = [item({}, { level: 0 }), item({}, { level: 2 }), item({}, { level: 4 })];
    expect(filterLeads(items, DEFAULT_LEAD_FILTERS)).toHaveLength(3);
    expect(filterLeads(items, { ...DEFAULT_LEAD_FILTERS, minLevel: 2 }).map((i) => i.lead.level).sort()).toEqual([2, 4]);
    expect(filterLeads(items, { ...DEFAULT_LEAD_FILTERS, minLevel: 4 })).toHaveLength(1);
  });
});
