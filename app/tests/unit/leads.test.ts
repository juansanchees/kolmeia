import { describe, expect, it } from "vitest";
import type { CandidateRow } from "@/lib/research/rows";
import { DEFAULT_LEAD_FILTERS, filterLeads, isStaleProof, leadsCsv, originLabel, proofCount } from "@/lib/leads/view";
import type { LeadListItem, LeadRow, LeadStatus } from "@/lib/leads/types";

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
function item(best: Partial<CandidateRow>, o: { status?: LeadStatus; agent?: string | null; agentName?: string | null; proofOk?: number } = {}): LeadListItem {
  n += 1;
  const lead: LeadRow = {
    id: `l${n}`, workspace_id: "w", best_candidate_id: `c${n}`, status: o.status ?? "new",
    origin_kind: o.agent ? "agent" : "one_off", origin_agent_id: o.agent ?? null, origin_run_id: "r1", owner_id: null,
    first_seen_at: "2026-11-01T00:00:00Z", last_seen_at: "2026-11-01T00:00:00Z",
  };
  return { lead, best: cand({ id: `c${n}`, ...best }), agentName: o.agentName ?? null, proofOk: o.proofOk ?? 0 };
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
    const f = (q: string) => filterLeads(items, { ...DEFAULT_LEAD_FILTERS, q }).map((i) => i.best.name);
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
    const names = (f: Partial<typeof DEFAULT_LEAD_FILTERS>) => filterLeads(items, { ...DEFAULT_LEAD_FILTERS, ...f }).map((i) => i.best.name);
    expect(names({})[0]).toBe("Very Co");
    expect(names({ temperature: "hot" })).toEqual(expect.arrayContaining(["Hot Co", "Refuted Co"]));
    expect(names({ temperature: "hot" })).toHaveLength(2);
    expect(names({ agent: "a1" })).toEqual(["Hot Co", "Cold Co"]);
    expect(names({ agent: "one_off" })).toEqual(["Very Co", "Refuted Co"]);
    expect(names({ status: "replied" })).toEqual(["Hot Co"]);
    expect(names({ tab: "call" })).not.toContain("Refuted Co");
    expect(names({ tab: "all" })).toContain("Refuted Co");
    const temps = filterLeads(items, DEFAULT_LEAD_FILTERS).map((i) => i.best.temperature);
    expect(temps).toEqual(["very_hot", "hot", "hot", "warm", "cold"]);
  });

  it("originLabel: the agent's name, or \"Pesquisa avulsa\"", () => {
    expect(originLabel(item({}, { agent: "a1", agentName: "Caçador Cape" }))).toBe("Caçador Cape");
    expect(originLabel(item({}, { agent: "a1", agentName: null }))).toBe("Pesquisa avulsa");
    expect(originLabel(item({}))).toBe("Pesquisa avulsa");
  });

  it("leadsCsv: the research columns plus Status and Agente", () => {
    const csv = leadsCsv([item({ name: "Acme" }, { agent: "a1", agentName: "Cape" }), item({ name: "Oak" })]);
    const rows = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(rows).toHaveLength(3);
    expect(rows[0].endsWith("Status,Agente")).toBe(true);
    expect(rows[1].endsWith("novo,Cape")).toBe(true);
    expect(rows[2].endsWith("novo,Pesquisa avulsa")).toBe(true);
  });
});
