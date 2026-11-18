import { describe, expect, test } from "vitest";
import { effectiveParams, mergeParams, proposePreference, rescore, type StoredOpp } from "@/lib/hunt/rescore";
import { interpretInstruction } from "@/lib/hunt/interpret";
import { stopReason, summarizeRound } from "@/lib/hunt/rounds";
import { hvacNewConstruction } from "@/lib/offers/hvac-new-construction";
import type { OfferInput } from "@/lib/offers/types";

// Invented data only.
const NOW = new Date("2026-11-18T00:00:00Z");
const facts = (description: string, value = 400000): OfferInput => ({
  signal: { kind: "permit", source: "permit", source_ref: description, address: "12 Example Rd", town: "Exampleton", work_class: "New Construction", value_usd: value, issued_on: "2026-10-20", description },
  company: { name: "Acme Builders LLC", phone: "508-555-0100" },
  link_status: "confirmed",
  contacts: {},
});
const stored = (id: string, f: OfferInput): StoredOpp => ({ id, priority: hvacNewConstruction.evaluate(f, NOW).priority, facts: f });
const HOUSE = stored("h1", facts("New single family dwelling"));
const FLATS = stored("m1", facts("New 12 unit apartment building", 2_500_000));
const ACCEPT = { deprioritizeKinds: ["single_family", "adu"], preferKinds: ["multifamily"], wantBidPath: true } as const;

describe("rescore", () => {
  test("the acceptance instruction demotes houses and promotes multifamily, from stored facts", () => {
    const r = rescore([HOUSE, FLATS], "hvac_new_construction", { ...ACCEPT, deprioritizeKinds: [...ACCEPT.deprioritizeKinds], preferKinds: [...ACCEPT.preferKinds] }, [], NOW);
    expect(r.find((x) => x.opportunity_id === "h1")).toMatchObject({ move: "down" });
    expect(r.find((x) => x.opportunity_id === "h1")!.priority_codes).toContain("kind_deprioritized");
    expect(r.find((x) => x.opportunity_id === "m1")!.priority_codes).toContain("kind_preferred");
    expect(r.find((x) => x.opportunity_id === "m1")!.open_questions[0]).toBe("ask_taking_bids");
  });
  test("no params = same", () => expect(rescore([HOUSE], "hvac_new_construction", {}, [], NOW)[0].move).toBe("same"));
  test("rows without facts are skipped", () => expect(rescore([{ id: "x", priority: 10, facts: null }], "hvac_new_construction", {}, [], NOW)).toEqual([]));
  test("approved preferences apply; the campaign instruction wins a conflict", () => {
    expect(effectiveParams({}, [{ deprioritizeKinds: ["single_family"] }])).toEqual({ deprioritizeKinds: ["single_family"] });
    expect(effectiveParams({ preferKinds: ["single_family"], minValueUsd: 5 }, [{ deprioritizeKinds: ["single_family"], minValueUsd: 9 }])).toEqual({ preferKinds: ["single_family"], minValueUsd: 5 });
  });
});

describe("mergeParams", () => {
  const say = (t: string) => interpretInstruction(t, "pt").params;
  test("lists accumulate: apartments, then commercial too", () => {
    expect(mergeParams(mergeParams({}, say("priorize apartamentos")), say("e comerciais também"))).toEqual({ preferKinds: ["multifamily", "commercial"] });
  });
  test("the newest instruction wins a conflict: small houses, then prefer single family", () => {
    const p = mergeParams(mergeParams({}, say("essas casas são pequenas demais")), say("priorize casas unifamiliares"));
    expect(p).toEqual({ deprioritizeKinds: ["adu"], preferKinds: ["single_family"] });
    expect(rescore([HOUSE], "hvac_new_construction", p, [], NOW)[0]).toMatchObject({ move: "up" });
    expect(mergeParams(p, say("evite casas"))).toEqual({ deprioritizeKinds: ["adu", "single_family"] });
  });
  test("scalars are replaced; empty instruction keeps everything", () => {
    expect(mergeParams({ minValueUsd: 5, wantBidPath: true }, { minValueUsd: 9 })).toEqual({ minValueUsd: 9, wantBidPath: true });
    expect(mergeParams({ preferKinds: ["multifamily"] }, {})).toEqual({ preferKinds: ["multifamily"] });
  });
  test("approved preference + campaign params: preference applies, campaign overrides it, other kinds kept", () => {
    const approved = [{ deprioritizeKinds: ["single_family" as const] }, { preferKinds: ["multifamily" as const], minValueUsd: 100 }];
    expect(effectiveParams({}, approved)).toEqual({ deprioritizeKinds: ["single_family"], preferKinds: ["multifamily"], minValueUsd: 100 });
    expect(effectiveParams({ preferKinds: ["single_family"], minValueUsd: 5 }, approved)).toEqual({ preferKinds: ["multifamily", "single_family"], minValueUsd: 5 });
    expect(rescore([HOUSE], "hvac_new_construction", {}, approved, NOW)[0].move).toBe("down");
    expect(rescore([HOUSE], "hvac_new_construction", { preferKinds: ["single_family"] }, approved, NOW)[0].move).toBe("up");
  });
});

describe("summarizeRound / stopReason", () => {
  test("counts new, updated, demoted; sources and asks", () => {
    const s = summarizeRound(
      [{ id: "a", priority: 50 }, { id: "b", priority: 50 }, { id: "c", priority: 50 }],
      [{ id: "a", priority: 70 }, { id: "b", priority: 20 }, { id: "c", priority: 50 }, { id: "d", priority: 40 }],
      [{ town: "Exampleton", source: "permit", ran_at: "2026-11-18T00:00:00Z", outcome: "login", queried: 1, rows_in: 0, reason: "portal login" }],
      [{ code: "permit_portal_login", ask: true }, { code: "live_off" }],
    );
    expect(s).toEqual({ new: 1, updated: 1, demoted: 1, sources: [{ source: "permit", town: "Exampleton", outcome: "login", reason: "portal login" }], blockers: ["live_off"], asks: ["permit_portal_login"] });
  });
  const base = { fulfilled: false, spentUsd: 0, limitUsd: 1, elapsedMs: 0, limitMs: 60_000, newEvidence: false, waitingSteps: 0 };
  test("stop reason waiting when only live steps remain", () => expect(stopReason({ ...base, waitingSteps: 2 })).toBe("waiting"));
  test("fulfilled, limit, exhausted, keep going", () => {
    expect(stopReason({ ...base, fulfilled: true, spentUsd: 5 })).toBe("fulfilled");
    expect(stopReason({ ...base, spentUsd: 1 })).toBe("limit");
    expect(stopReason({ ...base, elapsedMs: 60_000, newEvidence: true })).toBe("limit");
    expect(stopReason(base)).toBe("exhausted");
    expect(stopReason({ ...base, newEvidence: true, waitingSteps: 1 })).toBeNull();
  });
});

describe("proposePreference", () => {
  const queue = [HOUSE, stored("h2", facts("New single family home", 300000)), FLATS];
  const args = { offer: "hvac_new_construction", queue, campaign: {}, approved: [], now: NOW };
  test("3 refusals on houses propose deprioritizing them, with examples and expected effect", () => {
    const p = proposePreference({ ...args, outcomes: [
      { lead_id: "L1", kind: "single_family", call: "not_interested" },
      { lead_id: "L2", kind: "single_family", status: "discarded" },
      { lead_id: "L3", kind: "single_family", feedback: "bad" },
      { lead_id: "L4", kind: "multifamily", call: "no_answer" },
    ] });
    expect(p).toEqual({ offer: "hvac_new_construction", rule: { deprioritizeKinds: ["single_family"] }, example_lead_ids: ["L1", "L2", "L3"], expected_effect: { up: 0, down: 2 } });
  });
  test("2 refusals, or the same lead 3 times, propose nothing", () => {
    expect(proposePreference({ ...args, outcomes: [{ lead_id: "L1", kind: "single_family", call: "not_interested" }, { lead_id: "L2", kind: "single_family", call: "not_interested" }] })).toBeNull();
    expect(proposePreference({ ...args, outcomes: [1, 2, 3].map(() => ({ lead_id: "L1", kind: "single_family" as const, call: "not_interested" as const })) })).toBeNull();
  });
  test("meetings propose preferring; an already approved rule is not proposed again", () => {
    const outcomes = ["L1", "L2", "L3"].map((id) => ({ lead_id: id, kind: "multifamily" as const, call: "meeting_booked" as const }));
    expect(proposePreference({ ...args, outcomes })!.rule).toEqual({ preferKinds: ["multifamily"] });
    expect(proposePreference({ ...args, outcomes, approved: [{ preferKinds: ["multifamily"] }] })).toBeNull();
  });
});
