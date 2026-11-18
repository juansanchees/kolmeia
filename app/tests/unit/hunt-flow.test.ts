import { describe, expect, test } from "vitest";
import { applyInstruction, decidePreference, openRunnerRound, refreshPreference, startCampaign, type Campaign, type HuntDb } from "@/lib/hunt/flow";
import { runnerBlockers } from "@/lib/hunt/rounds";
import { agentReply } from "@/lib/hunt/text";
import { mergeParams, type Outcome, type StoredOpp } from "@/lib/hunt/rescore";
import { hvacNewConstruction } from "@/lib/offers/hvac-new-construction";
import type { CampaignParams, OfferInput } from "@/lib/offers/types";
import type { CoverageRow } from "@/lib/kb/coverage";
import { pt } from "@/messages/pt";
import { en } from "@/messages/en";

// The in-app part of a round, against a fake HuntDb (the SQL side is tested in tests/db/hunt-campaigns.test.ts). Invented data only.
const M = pt.hunt;
const ACCEPT = "essas casas são pequenas demais; nesta busca priorize multifamiliares e descubra por onde apresentar orçamento";
const NOW = new Date();
const issued = new Date(NOW.getTime() - 10 * 86_400_000).toISOString().slice(0, 10);
const facts = (description: string, over: Partial<OfferInput["contacts"]> = {}): OfferInput => ({
  signal: { kind: "permit", source: "permit", source_ref: description, address: "12 Example Rd", town: "Exampleton", work_class: "New Construction", value_usd: 400000, issued_on: issued, description },
  company: { name: "Acme Builders LLC", phone: "508-555-0100" },
  link_status: "confirmed",
  contacts: over,
});
const opp = (id: string, f: OfferInput): StoredOpp => ({ id, priority: hvacNewConstruction.evaluate(f, NOW).priority, facts: f });
const COV: CoverageRow[] = [{ town: "Exampleton", source: "permit", ran_at: "2026-11-01T00:00:00Z", outcome: "ok", queried: 3, rows_in: 3 }];

type Call = { fn: string; args: Record<string, unknown> };
function fake(opps: StoredOpp[], over: Partial<HuntDb> = {}) {
  const calls: Call[] = [];
  const db: HuntDb = {
    async rpc(fn, args) {
      calls.push({ fn, args });
      return (fn === "hunt_campaign_create" ? "camp-1" : fn === "hunt_campaign_apply" ? { round_id: "round-2", n: 2 } : null) as never;
    },
    openRound: async () => ({ id: "round-1", n: 1 }),
    campaignOpps: async () => opps,
    approvedRules: async () => [],
    coverage: async () => COV,
    outcomes: async () => [],
    ...over,
  };
  return { db, calls, names: () => calls.map((c) => c.fn), call: (fn: string) => calls.find((c) => c.fn === fn)! };
}
const camp = (params: CampaignParams = {}): Campaign => ({ id: "camp-1", workspace_id: "ws-1", offer: "hvac_new_construction", params });

describe("startCampaign", () => {
  test("creates the campaign, finishes round 1 as waiting with the runner ask, and answers", async () => {
    const f = fake([]);
    const id = await startCampaign(f.db, M, { ws: "ws-1", offer: "hvac_new_construction", region: "Exampleton, MA", request: "quero mais clientes", params: {} });
    expect(id).toBe("camp-1");
    expect(f.names()).toEqual(["hunt_campaign_create", "hunt_round_finish", "hunt_message_add"]);
    expect(f.call("hunt_campaign_create").args).toMatchObject({ p_ws: "ws-1", p_offer: "hvac_new_construction", p_region: "Exampleton, MA", p_request: "quero mais clientes", p_params: {} });
    const fin = f.call("hunt_round_finish").args;
    expect(fin).toMatchObject({ p_round: "round-1", p_stop_reason: "waiting", p_scores: [] });
    expect(fin.p_summary).toMatchObject({ asks: ["run_pilot"], sources: [{ source: "permit", town: "Exampleton", outcome: "ok" }] });
    expect(f.call("hunt_message_add").args).toMatchObject({ p_role: "agent", p_round: "round-1" });
  });
});

describe("applyInstruction", () => {
  const houses = [opp("h1", facts("New single family dwelling")), opp("m1", facts("New 12 unit apartment building"))];
  test("acceptance sentence: message, merged params, re-score, finish waiting for the bid path, answer", async () => {
    const f = fake(houses);
    const current: CampaignParams = { preferKinds: ["commercial"] };
    await applyInstruction(f.db, M, "pt", camp(current), ACCEPT);
    expect(f.names()).toEqual(["hunt_message_add", "hunt_campaign_apply", "hunt_round_finish", "hunt_message_add"]);
    expect(f.calls[0].args).toMatchObject({ p_role: "user", p_body: ACCEPT });
    const sent = f.call("hunt_campaign_apply").args.p_params as CampaignParams;
    expect(sent).toEqual(mergeParams(current, { deprioritizeKinds: ["single_family", "adu"], preferKinds: ["multifamily"], wantBidPath: true }));
    expect(sent.preferKinds).toEqual(["commercial", "multifamily"]);
    const fin = f.call("hunt_round_finish").args;
    expect(fin.p_round).toBe("round-2");
    expect(fin.p_stop_reason).toBe("waiting");
    expect(fin.p_summary).toMatchObject({ blockers: ["need_bid_path"], demoted: 1 });
    const scores = fin.p_scores as { opportunity_id: string; priority_codes: string[] }[];
    expect(scores.find((s) => s.opportunity_id === "h1")!.priority_codes).toContain("kind_deprioritized");
    const reply = String(f.calls[3].args.p_body);
    expect(reply).toContain("Entendi:");
    expect(reply).toContain(M.round.stop.waiting);
    expect(reply).toContain(M.round.blockerCodes.need_bid_path);
  });

  test("everything done in-app finishes as fulfilled; with a bid path known there is no blocker", async () => {
    const f = fake([opp("m1", facts("New 12 unit apartment building", { bids_url: "https://example.com/bids", bids_source_url: "https://example.com" }))]);
    await applyInstruction(f.db, M, "pt", camp(), ACCEPT);
    expect(f.call("hunt_round_finish").args.p_stop_reason).toBe("fulfilled");
  });

  test("no opportunities yet: the round waits for the operator's run", async () => {
    const f = fake([]);
    await applyInstruction(f.db, M, "pt", camp(), "só recentes");
    expect(f.call("hunt_round_finish").args).toMatchObject({ p_stop_reason: "waiting" });
    expect(f.call("hunt_round_finish").args.p_summary).toMatchObject({ asks: ["run_pilot"] });
  });

  test("what is not understood is said back as a plain question", async () => {
    const f = fake(houses);
    await applyInstruction(f.db, M, "pt", camp(), "faça um bolo");
    expect(String(f.calls.at(-1)!.args.p_body)).toContain("Não entendi");
    expect(f.call("hunt_campaign_apply").args.p_params).toEqual({});
  });

  test("nothing understood is never 'fulfilled': the round waits on a simple question", async () => {
    const f = fake([opp("m1", facts("New 12 unit apartment building", { bids_url: "https://example.com/bids", bids_source_url: "https://example.com" }))]);
    await applyInstruction(f.db, M, "pt", camp(), "faça um bolo");
    const fin = f.call("hunt_round_finish").args;
    expect(fin.p_stop_reason).toBe("waiting");
    expect(fin.p_summary).toMatchObject({ asks: ["say_what_to_change"] });
    const reply = String(f.calls.at(-1)!.args.p_body);
    expect(reply).toContain(M.round.askCodes.say_what_to_change);
    expect(reply).not.toContain(M.round.stop.fulfilled);
  });

  test("english: same flow, english words", async () => {
    const f = fake(houses);
    await applyInstruction(f.db, en.hunt, "en", camp(), "these houses are too small");
    expect(String(f.calls.at(-1)!.args.p_body)).toContain("Understood:");
  });
});

describe("preferences", () => {
  test("approving applies in a new round with the campaign params unchanged; undo does the same", async () => {
    for (const d of ["approved", "undone"] as const) {
      const f = fake([opp("h1", facts("New single family dwelling"))]);
      await decidePreference(f.db, M, camp({ minValueUsd: 5 }), "pref-1", d);
      expect(f.names()).toEqual(["offer_preference_decide", "hunt_campaign_apply", "hunt_round_finish", "hunt_message_add"]);
      expect(f.calls[0].args).toEqual({ p_pref: "pref-1", p_decision: d });
      expect(f.call("hunt_campaign_apply").args.p_params).toEqual({ minValueUsd: 5 });
      expect(String(f.calls[3].args.p_body)).toContain(d === "approved" ? M.reply.approved : M.reply.undone);
    }
  });

  test("three refusals on houses propose a rule; nothing is proposed from two", async () => {
    const outcomes = (n: number): Outcome[] => Array.from({ length: n }, (_, i) => ({ lead_id: `L${i}`, kind: "single_family" as const, call: "not_interested" as const }));
    const three = fake([opp("h1", facts("New single family dwelling"))], { outcomes: async () => outcomes(3) });
    await refreshPreference(three.db, camp());
    expect(three.call("offer_preference_propose").args).toMatchObject({ p_ws: "ws-1", p_rule: { deprioritizeKinds: ["single_family"] }, p_example_lead_ids: ["L0", "L1", "L2"] });
    const two = fake([], { outcomes: async () => outcomes(2) });
    await refreshPreference(two.db, camp());
    expect(two.names()).toEqual([]);
  });
});

describe("pilot runner round", () => {
  /** A fake that keeps rounds like the database: create opens round 1, finish closes it, apply closes any open one and opens the next. */
  function stateful() {
    const rounds: { id: string; n: number; open: boolean }[] = [];
    const calls: Call[] = [];
    const open = (n: number) => (rounds.forEach((r) => (r.open = false)), rounds.push({ id: `round-${n}`, n, open: true }), rounds.at(-1)!);
    const db: HuntDb = {
      async rpc(fn, args) {
        calls.push({ fn, args });
        if (fn === "hunt_campaign_create") return (open(1), "camp-1") as never;
        if (fn === "hunt_campaign_apply") { const r = open(rounds.length + 1); return { round_id: r.id, n: r.n } as never; }
        if (fn === "hunt_round_finish") { const r = rounds.find((x) => x.id === args.p_round)!; if (!r.open) throw new Error("round already finished"); r.open = false; }
        return null as never;
      },
      async openRound() {
        const r = rounds.filter((x) => x.open).at(-1);
        if (!r) throw new Error("openRound: no open round");
        return { id: r.id, n: r.n };
      },
      campaignOpps: async () => [],
      approvedRules: async () => [],
      coverage: async () => COV,
      outcomes: async () => [],
    };
    return { db, calls };
  }

  test("after 'Começar por esta' closed round 1, the runner opens round 2 itself with the stored params and finishes it", async () => {
    const f = stateful();
    const id = await startCampaign(f.db, M, { ws: "ws-1", offer: "hvac_new_construction", region: "Exampleton, MA", request: "quero mais clientes", params: {} });
    await expect(f.db.openRound(id)).rejects.toThrow("no open round");
    const round = await openRunnerRound(f.db, id);
    expect(round).toEqual({ id: "round-2", n: 2 });
    expect(f.calls.find((c) => c.fn === "hunt_campaign_apply")!.args).toEqual({ p_campaign: "camp-1", p_params: null, p_message: null });
    await f.db.rpc("hunt_round_finish", { p_round: round.id, p_scores: [], p_summary: {}, p_stop_reason: "waiting" });
    expect((await openRunnerRound(f.db, id)).n).toBe(3);
  });

  test("runner blockers are stable codes with words, and the runner's reply uses them (no raw code, no raw stop reason)", () => {
    const cov = (source: string, outcome: CoverageRow["outcome"], reason?: string): CoverageRow => ({ town: "Exampleton", source, ran_at: "2026-11-01T00:00:00Z", outcome, queried: 1, rows_in: 0, ...(reason ? { reason } : {}) });
    const b = runnerBlockers([cov("site_robot", "blocked"), cov("kb_match:permit_no", "down"), cov("permit", "robots"), cov("x", "login"), cov("permit_portal", "skipped", "live off"), cov("maps_robot", "ok")], 2);
    expect(b.map((x) => x.code).sort()).toEqual(["live_off", "source_blocked", "source_down", "source_login", "source_robots", "unlinked_permits"]);
    for (const L of [pt.hunt, en.hunt]) {
      for (const x of b) expect(x.ask ? L.round.askCodes : L.round.blockerCodes, x.code).toHaveProperty(x.code);
      for (const c of ["site_robot", "permit_portal", "kb_match:permit_no", "kb_match:applicant_phone", "kb_match:name_town"]) expect(L.cov.sources, c).toHaveProperty(c);
    }
    const reply = agentReply(M, { understood: [], unknown: [], summary: { new: 1, updated: 0, demoted: 0, sources: [], blockers: b.filter((x) => !x.ask).map((x) => x.code), asks: b.filter((x) => x.ask).map((x) => x.code) }, stop: "waiting" });
    expect(reply).toContain(M.round.stop.waiting);
    expect(reply).toContain(M.round.askCodes.live_off);
    expect(reply).not.toMatch(/\b(live_off|unlinked_permits|source_\w+|waiting)\b/);
    expect(runnerBlockers([cov("maps_robot", "ok")], 0)).toEqual([]);
  });
});
