import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { interpretInstruction } from "@/lib/hunt/interpret";
import { mergeParams, proposePreference, rescore, type StoredOpp } from "@/lib/hunt/rescore";
import { stopReason, summarizeRound } from "@/lib/hunt/rounds";
import { getOffer, toOpportunityRow } from "@/lib/offers";
import type { CampaignParams, OfferInput } from "@/lib/offers/types";
import { TestDb, as, service } from "./helpers";

// 0042: campaigns with rounds, saved conversation, instructions re-scoring stored facts, approved preferences.
// Invented data only (Acme*, 508-555-01xx, example.com).
let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create();
});
afterAll(async () => {
  await db.pg.close();
});

const NOW = new Date("2026-11-18T00:00:00Z");
const OFFER = "hvac_new_construction";
const ACCEPT = "essas casas são pequenas demais; nesta busca priorize multifamiliares e descubra por onde apresentar orçamento";
const code = (e: unknown) => (e as { code?: string } | undefined)?.code;
let seq = 0;

async function seed() {
  const [owner, sdr, closer, other] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  for (const u of [owner, sdr, closer, other]) await db.addUser(u);
  const ws = (await db.query<{ id: string }>(as(owner), "select public.create_workspace('Empresa A') as id"))[0].id;
  await db.query(as(other), "select public.create_workspace('Empresa B')");
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr'), ($1,$3,'closer')", [ws, sdr, closer]);
  return { ws, owner, sdr, closer, other };
}
const facts = (description: string, value: number): OfferInput => ({
  signal: { kind: "permit", source: "permit", source_ref: `P-${++seq}`, address: `${seq} Example Rd`, town: "Exampleton", work_class: "New Construction", value_usd: value, issued_on: "2026-10-20", description, source_url: "https://example.com/permits" },
  company: { name: `Acme ${seq} LLC`, phone: `508-555-01${String(seq % 100).padStart(2, "0")}` },
  link_status: "confirmed",
  contacts: {},
});
const create = (user: string, ws: string, params: CampaignParams = {}, request = "quero mais clientes") =>
  db.query<{ id: string }>(as(user), "select public.hunt_campaign_create($1,$2,'Exampleton',$3,$4::jsonb) as id", [ws, OFFER, request, JSON.stringify(params)]).then((r) => r[0].id);

/** Delivers one company per input, each with one opportunity scored under `params` and tagged with the campaign. */
async function deliver(ws: string, campaign: string, inputs: OfferInput[], params: CampaignParams = {}) {
  const rows = [];
  for (const [i, f] of inputs.entries()) {
    const co = (await db.admin<{ id: string }>("insert into public.kb_companies (name, name_key) values ($1,$2) returning id", [f.company!.name, `acme ${++seq}`]))[0].id;
    const sig = (await db.admin<{ id: string }>("insert into public.kb_signals (company_id, kind, source, source_ref) values ($1,'permit','permit',$2) returning id", [co, f.signal.source_ref]))[0].id;
    const v = getOffer(OFFER).evaluate(f, NOW, params);
    rows.push({ row: i + 1, name: f.company!.name, name_key: `acme ${co}`, phone: f.company!.phone, kb_company_id: co, opportunities: [{ ...toOpportunityRow(v, OFFER, f, params, sig), campaign_id: campaign }] });
  }
  return db.query<{ r: { import_id: string } }>(service, "select public.kb_deliver($1,null,'Base Kolmeia: teste',$2::jsonb) as r", [ws, JSON.stringify(rows)]).then((x) => x[0].r);
}
type Opp = { id: string; priority: number; previous_priority: number | null; round_seen: number | null; facts: OfferInput | null; title: string };
const oppsOf = (user: string, campaign: string) =>
  db.query<Opp>(as(user), "select id, priority, previous_priority, round_seen, facts, title from public.lead_opportunities where campaign_id = $1 order by title", [campaign]);
const paramsOf = (user: string, campaign: string) => db.query<{ params: CampaignParams }>(as(user), "select params from public.hunt_campaigns where id = $1", [campaign]).then((r) => r[0].params);
const approvedRules = (user: string, ws: string) =>
  db.query<{ rule: CampaignParams }>(as(user), "select rule from public.offer_preferences where workspace_id = $1 and offer = $2 and status = 'approved' order by proposed_at", [ws, OFFER]).then((r) => r.map((x) => x.rule));

/** The app's round: merge the instruction into the campaign's params, apply (new round), re-score stored facts in TS, write back. */
async function runRound(user: string, ws: string, campaign: string, params: Partial<CampaignParams>, message: string | null, stop = "exhausted") {
  const merged = mergeParams(await paramsOf(user, campaign), params);
  const { round_id, n } = (await db.query<{ r: { round_id: string; n: number } }>(as(user), "select public.hunt_campaign_apply($1,$2::jsonb,$3) as r", [campaign, JSON.stringify(merged), message]))[0].r;
  const before = await oppsOf(user, campaign);
  const scores = rescore(before as StoredOpp[], OFFER, await paramsOf(user, campaign), await approvedRules(user, ws), NOW);
  const summary = summarizeRound(before, scores.map((s) => ({ id: s.opportunity_id, priority: s.priority })), [], []);
  const updated = (await db.query<{ n: number }>(as(user), "select public.hunt_round_finish($1,$2::jsonb,$3::jsonb,$4) as n", [round_id, JSON.stringify(scores), JSON.stringify(summary), stop]))[0].n;
  return { round_id, n, updated, scores };
}

describe("hunt campaigns (0042)", () => {
  it("instruction applies to this campaign immediately", async () => {
    const t = await seed();
    const c = await create(t.sdr, t.ws);
    await deliver(t.ws, c, [facts("New single family dwelling", 400000), facts("New 12 unit apartment building", 2_500_000)]);
    const before = await oppsOf(t.sdr, c);
    const i = interpretInstruction(ACCEPT, "pt");
    const r = await runRound(t.sdr, t.ws, c, i.params, ACCEPT);
    expect(r.n).toBe(2);
    expect(r.updated).toBe(2);
    expect(await paramsOf(t.owner, c)).toEqual({ deprioritizeKinds: ["single_family", "adu"], preferKinds: ["multifamily"], wantBidPath: true });
    const [flats, house] = await oppsOf(t.sdr, c);
    expect(flats.title).toMatch(/apartment/);
    expect(house.priority).toBeLessThan(house.previous_priority!);
    expect(flats.priority).toBeGreaterThanOrEqual(flats.previous_priority!);
    expect([house.round_seen, flats.round_seen]).toEqual([2, 2]);
    expect([flats.previous_priority, house.previous_priority]).toEqual(before.map((o) => o.priority));
  });

  it("other campaign params untouched", async () => {
    const t = await seed();
    const a = await create(t.sdr, t.ws);
    const b = await create(t.sdr, t.ws, { minValueUsd: 1000 }, "manutenção");
    await deliver(t.ws, a, [facts("New single family dwelling", 400000)]);
    await deliver(t.ws, b, [facts("New single family home", 300000)]);
    const bBefore = await oppsOf(t.sdr, b);
    const { round_id } = (await db.query<{ r: { round_id: string } }>(as(t.sdr), "select public.hunt_campaign_apply($1,$2::jsonb,null) as r", [a, JSON.stringify(interpretInstruction(ACCEPT, "pt").params)]))[0].r;
    // a score for campaign B's opportunity sent through A's round is ignored
    const n = (await db.query<{ n: number }>(as(t.sdr), "select public.hunt_round_finish($1,$2::jsonb,'{}'::jsonb,'exhausted') as n", [round_id, JSON.stringify([{ opportunity_id: bBefore[0].id, priority: 1, priority_codes: [], open_questions: [] }])]))[0].n;
    expect(n).toBe(0);
    expect(await paramsOf(t.sdr, b)).toEqual({ minValueUsd: 1000 });
    expect(await oppsOf(t.sdr, b)).toEqual(bBefore);
  });

  it("round 2 reuses round 1 opportunities (no new rows, priorities updated)", async () => {
    const t = await seed();
    const c = await create(t.sdr, t.ws);
    await deliver(t.ws, c, [facts("New single family dwelling", 400000), facts("New 6 unit condominium", 1_200_000)]);
    const ids = (await oppsOf(t.sdr, c)).map((o) => o.id).sort();
    await runRound(t.sdr, t.ws, c, interpretInstruction(ACCEPT, "pt").params, ACCEPT);
    const after = await oppsOf(t.sdr, c);
    expect(after.map((o) => o.id).sort()).toEqual(ids);
    expect(after.every((o) => o.round_seen === 2 && o.previous_priority !== null)).toBe(true);
    expect(after.some((o) => o.priority !== o.previous_priority)).toBe(true);
    const n = await db.admin<{ n: string }>("select count(*) n from public.lead_opportunities where workspace_id = $1", [t.ws]);
    expect(Number(n[0].n)).toBe(2);
  });

  it("preference only after approval", async () => {
    const t = await seed();
    const c = await create(t.sdr, t.ws);
    await deliver(t.ws, c, [facts("New single family dwelling", 400000), facts("New single family home", 350000), facts("New 12 unit apartment building", 2_500_000)]);
    const queue = (await oppsOf(t.sdr, c)) as StoredOpp[];
    const leads = await db.admin<{ id: string }>("select id from public.leads where workspace_id = $1 order by id limit 3", [t.ws]);
    const p = proposePreference({ offer: OFFER, queue, campaign: {}, approved: [], now: NOW, outcomes: leads.map((l) => ({ lead_id: l.id, kind: "single_family" as const, call: "not_interested" as const })) })!;
    expect(p.expected_effect).toEqual({ up: 0, down: 2 });
    const pref = (await db.query<{ id: string }>(as(t.sdr), "select public.offer_preference_propose($1,$2,$3::jsonb,$4::uuid[],$5::jsonb) as id", [t.ws, OFFER, JSON.stringify(p.rule), p.example_lead_ids, JSON.stringify(p.expected_effect)]))[0].id;
    // proposing the same rule again returns the same row
    expect((await db.query<{ id: string }>(as(t.sdr), "select public.offer_preference_propose($1,$2,$3::jsonb,$4::uuid[],$5::jsonb) as id", [t.ws, OFFER, JSON.stringify(p.rule), p.example_lead_ids, JSON.stringify(p.expected_effect)]))[0].id).toBe(pref);
    const r1 = await runRound(t.sdr, t.ws, c, {}, null);
    expect(r1.scores.every((s) => s.move === "same")).toBe(true);
    // the closer reads it but cannot decide
    expect(await db.query(as(t.closer), "select id from public.offer_preferences where id = $1", [pref])).toHaveLength(1);
    expect(code((await db.try(as(t.closer), "select public.offer_preference_decide($1,'approved')", [pref])).error)).toBe("42501");
    await db.query(as(t.owner), "select public.offer_preference_decide($1,'approved')", [pref]);
    const r2 = await runRound(t.sdr, t.ws, c, {}, null);
    expect(r2.scores.filter((s) => s.move === "down")).toHaveLength(2);
    expect(code((await db.try(as(t.owner), "select public.offer_preference_decide($1,'approved')", [pref])).error)).toBe("22023");
  });

  it("undo restores previous priorities", async () => {
    const t = await seed();
    const c = await create(t.sdr, t.ws);
    await deliver(t.ws, c, [facts("New single family dwelling", 400000), facts("New 12 unit apartment building", 2_500_000)]);
    const initial = (await oppsOf(t.sdr, c)).map((o) => o.priority);
    const lead = (await db.admin<{ id: string }>("select id from public.leads where workspace_id = $1 limit 1", [t.ws]))[0].id;
    const pref = (await db.query<{ id: string }>(as(t.sdr), "select public.offer_preference_propose($1,$2,'{\"deprioritizeKinds\":[\"single_family\"]}'::jsonb,$3::uuid[],'{\"up\":0,\"down\":1}'::jsonb) as id", [t.ws, OFFER, [lead]]))[0].id;
    await db.query(as(t.sdr), "select public.offer_preference_decide($1,'approved')", [pref]);
    await runRound(t.sdr, t.ws, c, {}, null);
    expect((await oppsOf(t.sdr, c)).map((o) => o.priority)).not.toEqual(initial);
    await db.query(as(t.sdr), "select public.offer_preference_decide($1,'undone')", [pref]);
    await runRound(t.sdr, t.ws, c, {}, null);
    expect((await oppsOf(t.sdr, c)).map((o) => o.priority)).toEqual(initial);
    expect(await db.admin("select status, decided_by from public.offer_preferences where id = $1", [pref])).toEqual([{ status: "undone", decided_by: t.sdr }]);
  });

  it("reopen keeps messages and rounds", async () => {
    const t = await seed();
    const c = await create(t.sdr, t.ws);
    await deliver(t.ws, c, [facts("New single family dwelling", 400000)]);
    await db.query(as(t.sdr), "select public.hunt_message_add($1,'agent','proposals shown',null)", [c]);
    await runRound(t.sdr, t.ws, c, interpretInstruction(ACCEPT, "pt").params, ACCEPT);
    const lead = (await db.admin<{ id: string }>("select id from public.leads where workspace_id = $1 limit 1", [t.ws]))[0].id;
    await db.query(as(t.sdr), "select public.offer_preference_propose($1,$2,'{\"preferKinds\":[\"multifamily\"]}'::jsonb,$3::uuid[],null)", [t.ws, OFFER, [lead]]);
    // a later session (another member) reads everything back from the database
    const msgs = await db.query<{ role: string; body: string; n: number | null }>(as(t.owner),
      "select m.role, m.body, r.n from public.hunt_messages m left join public.hunt_rounds r on r.id = m.round_id where m.campaign_id = $1 order by m.created_at, m.id", [c]);
    expect(msgs.map((m) => [m.role, m.body])).toEqual(expect.arrayContaining([["user", "quero mais clientes"], ["agent", "proposals shown"], ["user", ACCEPT]]));
    expect(msgs.find((m) => m.body === ACCEPT)!.n).toBe(2);
    const rounds = await db.query<{ n: number; stop_reason: string | null; ended_at: string | null; summary: unknown; params_snapshot: unknown }>(as(t.closer),
      "select n, stop_reason, ended_at, summary, params_snapshot from public.hunt_rounds where campaign_id = $1 order by n", [c]);
    expect(rounds.map((r) => r.n)).toEqual([1, 2]);
    expect(rounds[0].ended_at).not.toBeNull();
    expect(rounds[1]).toMatchObject({ stop_reason: "exhausted", summary: { new: 0, demoted: 1 }, params_snapshot: { wantBidPath: true } });
    expect(await db.query(as(t.owner), "select id from public.offer_preferences where workspace_id = $1 and status = 'proposed'", [t.ws])).toHaveLength(1);
  });

  it("stop reason waiting when only live steps remain", async () => {
    const t = await seed();
    const c = await create(t.sdr, t.ws);
    const stop = stopReason({ fulfilled: false, spentUsd: 0, limitUsd: 1, elapsedMs: 10, limitMs: 60_000, newEvidence: false, waitingSteps: 1 })!;
    const r = await runRound(t.sdr, t.ws, c, {}, null, stop);
    expect((await db.admin<{ stop_reason: string }>("select stop_reason from public.hunt_rounds where id = $1", [r.round_id]))[0].stop_reason).toBe("waiting");
    // a finished round cannot be finished again; a bad reason is refused
    expect(code((await db.try(as(t.sdr), "select public.hunt_round_finish($1,'[]'::jsonb,'{}'::jsonb,'exhausted')", [r.round_id])).error)).toBe("22023");
    const r2 = (await db.query<{ r: { round_id: string } }>(as(t.sdr), "select public.hunt_campaign_apply($1,'{}'::jsonb,null) as r", [c]))[0].r;
    expect(code((await db.try(as(t.sdr), "select public.hunt_round_finish($1,'[]'::jsonb,'{}'::jsonb,'tired')", [r2.round_id])).error)).toBe("22023");
  });

  it("non-member cannot read or write campaigns", async () => {
    const t = await seed();
    const c = await create(t.sdr, t.ws);
    const lead = (await deliver(t.ws, c, [facts("New single family dwelling", 400000)])) && (await db.admin<{ id: string }>("select id from public.leads where workspace_id = $1 limit 1", [t.ws]))[0].id;
    const pref = (await db.query<{ id: string }>(as(t.sdr), "select public.offer_preference_propose($1,$2,'{\"preferKinds\":[\"multifamily\"]}'::jsonb,$3::uuid[],null) as id", [t.ws, OFFER, [lead]]))[0].id;
    const round = (await db.admin<{ id: string }>("select id from public.hunt_rounds where campaign_id = $1", [c]))[0].id;
    for (const tbl of ["hunt_campaigns", "hunt_rounds", "hunt_messages", "offer_preferences", "lead_opportunities"]) {
      expect(await db.query(as(t.other), `select * from public.${tbl}`), tbl).toHaveLength(0);
    }
    for (const [sql, params] of [
      ["select public.hunt_campaign_create($1,'hvac_new_construction',null,'x','{}'::jsonb)", [t.ws]],
      ["select public.hunt_message_add($1,'user','hi',null)", [c]],
      ["select public.hunt_campaign_apply($1,'{}'::jsonb,'x')", [c]],
      ["select public.hunt_round_finish($1,'[]'::jsonb,'{}'::jsonb,'exhausted')", [round]],
      ["select public.offer_preference_decide($1,'approved')", [pref]],
      ["select public.offer_preference_propose($1,'hvac_new_construction','{\"preferKinds\":[\"multifamily\"]}'::jsonb,'{}'::uuid[],null)", [t.ws]],
    ] as const) {
      expect(code((await db.try(as(t.other), sql, [...params])).error), sql).toBe("42501");
    }
    // nobody writes the tables directly
    expect((await db.try(as(t.owner), "insert into public.hunt_campaigns (workspace_id, offer) values ($1,'x')", [t.ws])).error).toBeTruthy();
    expect((await db.try(as(t.owner), "update public.hunt_campaigns set params = '{}'::jsonb where id = $1", [c])).error).toBeTruthy();
    // a campaign of another workspace cannot be attached on delivery
    const ws2 = (await db.admin<{ id: string }>("select workspace_id as id from public.workspace_members where user_id = $1", [t.other]))[0].id;
    expect(code((await db.try(service, "select public.kb_deliver($1,null,'x',$2::jsonb)", [ws2, JSON.stringify([{ row: 1, name: "Acme X", name_key: "acme x", kb_company_id: (await db.admin<{ id: string }>("insert into public.kb_companies (name, name_key) values ('Acme X','acme x z') returning id"))[0].id, opportunities: [{ offer: OFFER, campaign_id: c }] }])])).error)).toBe("22023");
  });

  it("closer role cannot apply instructions", async () => {
    const t = await seed();
    const c = await create(t.sdr, t.ws);
    expect(await db.query(as(t.closer), "select id from public.hunt_campaigns where id = $1", [c])).toHaveLength(1);
    expect(code((await db.try(as(t.closer), "select public.hunt_campaign_apply($1,'{\"wantBidPath\":true}'::jsonb,'x')", [c])).error)).toBe("42501");
    expect(code((await db.try(as(t.closer), "select public.hunt_message_add($1,'user','hi',null)", [c])).error)).toBe("42501");
    expect(code((await db.try(as(t.closer), "select public.hunt_campaign_create($1,'hvac_new_construction',null,'x','{}'::jsonb)", [t.ws])).error)).toBe("42501");
  });

  it("two instructions accumulate; the newest wins a conflict; SQL stores what TS sends", async () => {
    const t = await seed();
    const c = await create(t.sdr, t.ws);
    await deliver(t.ws, c, [facts("New single family dwelling", 400000)]);
    await runRound(t.sdr, t.ws, c, interpretInstruction("priorize apartamentos", "pt").params, "priorize apartamentos");
    await runRound(t.sdr, t.ws, c, interpretInstruction("e comerciais também", "pt").params, "e comerciais também");
    expect(await paramsOf(t.sdr, c)).toEqual({ preferKinds: ["multifamily", "commercial"] });
    await runRound(t.sdr, t.ws, c, interpretInstruction("essas casas são pequenas demais", "pt").params, null);
    const before = (await oppsOf(t.sdr, c))[0].priority;
    await runRound(t.sdr, t.ws, c, interpretInstruction("priorize casas unifamiliares", "pt").params, null);
    expect(await paramsOf(t.sdr, c)).toEqual({ preferKinds: ["multifamily", "commercial", "single_family"], deprioritizeKinds: ["adu"] });
    const house = (await oppsOf(t.sdr, c))[0];
    expect(house.priority).toBeGreaterThan(before);
    // null keeps the current params; a kind in both lists is refused
    await db.query(as(t.sdr), "select public.hunt_campaign_apply($1,null,null)", [c]);
    expect((await paramsOf(t.sdr, c)).preferKinds).toContain("single_family");
    expect(code((await db.try(as(t.sdr), "select public.hunt_campaign_apply($1,'{\"preferKinds\":[\"adu\"],\"deprioritizeKinds\":[\"adu\"]}'::jsonb,null)", [c])).error)).toBe("22023");
  });

  it("params are validated; the full params are stored, a null drops a key", async () => {
    const t = await seed();
    for (const bad of [{ preferKinds: ["castle"] }, { minValueUsd: "lots" }, { evil: 1 }, { maxAgeDays: 0 }, { preferKinds: ["adu"], deprioritizeKinds: ["adu"] }]) {
      expect(code((await db.try(as(t.sdr), "select public.hunt_campaign_create($1,'hvac_new_construction',null,'x',$2::jsonb)", [t.ws, JSON.stringify(bad)])).error), JSON.stringify(bad)).toBe("22023");
    }
    const c = await create(t.sdr, t.ws, { wantBidPath: true, minValueUsd: 5 });
    await db.query(as(t.sdr), "select public.hunt_campaign_apply($1,'{\"wantBidPath\":true,\"minValueUsd\":null,\"maxAgeDays\":90}'::jsonb,null)", [c]);
    expect(await paramsOf(t.sdr, c)).toEqual({ wantBidPath: true, maxAgeDays: 90 });
  });

  it("kb_coverage: a member reads operator rows and own rows, a non-member gets a permission error", async () => {
    const t = await seed();
    const ws2 = (await db.admin<{ workspace_id: string }>("select workspace_id from public.workspace_members where user_id = $1", [t.other]))[0].workspace_id;
    const job = (ws: string | null, city: string, source: string, outcome: string | null, rows: number, reason: string | null) =>
      db.admin("insert into public.kb_jobs (kind, source, city, status, workspace_id, outcome, queried, rows_in, reason) values ('pilot',$1,$2,'done',$3,$4,5,$5,$6)", [source, city, ws, outcome, rows, reason]);
    await job(null, "Exampleton", "permit", "ok", 7, null);
    await job(t.ws, "Exampleton", "site_robot", "blocked", 0, "site blocked (403/429)");
    await job(ws2, "Otherville", "permit", "ok", 3, null);
    await job(null, "Exampleton", "maps_robot", null, 0, null);
    const rows = await db.query<{ town: string; source: string; outcome: string; rows_in: number; reason: string | null }>(as(t.closer), "select * from public.kb_coverage($1)", [t.ws]);
    expect(rows.map((r) => `${r.town}/${r.source}/${r.outcome}/${r.rows_in}`).sort()).toEqual(["Exampleton/permit/ok/7", "Exampleton/site_robot/blocked/0"]);
    expect(rows.find((r) => r.source === "site_robot")?.reason).toBe("site blocked (403/429)");
    expect(code((await db.try(as(t.other), "select * from public.kb_coverage($1)", [t.ws])).error)).toBe("42501");
    expect(code((await db.try(service, "select * from public.kb_coverage($1)", [t.ws])).error)).toBe("42501");
  });
});
