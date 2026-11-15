import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CALL_STATUS_VECTORS } from "../fixtures/call-status-vectors";
import { TestDb, as, setSchedulerToken, type Query } from "./helpers";
import { beginTick, clock } from "./hunter-seed";
import { TOKEN } from "./scheduler-seed";

// Migration 0020 part B (F5): the call log and its status rule, do-not-call, the call agent and the daily call list.
// Fictional data only (*.example, 508-555-01xx). Real migrations, non-superuser roles (PGlite). Each test gets its own
// workspace, because a call list reads every lead of the workspace.

let db: TestDb;

const code = (e: unknown) => (e as { code?: string } | undefined)?.code;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.pg.close();
});

type Team = { ws: string; owner: string; sdr: string; closer: string; closer2: string; run: string };

async function seedTeam(): Promise<Team> {
  const [owner, sdr, closer, closer2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  for (const u of [owner, sdr, closer, closer2]) await db.addUser(u);
  const ws = (await db.query<{ id: string }>(as(owner), "select public.create_workspace('Empresa Ligação') as id"))[0].id;
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr'), ($1,$3,'closer'), ($1,$4,'closer')", [
    ws,
    sdr,
    closer,
    closer2,
  ]);
  const run = (await db.admin<{ id: string }>("insert into public.research_runs (workspace_id, title, request_text) values ($1,'t','pedido') returning id", [ws]))[0].id;
  return { ws, owner, sdr, closer, closer2, run };
}

let seq = 0;
/** A lead born from a verified candidate (its best candidate), with an optional phone and temperature, then the level. */
async function seedLead(t: Team, opts: { phone?: string | null; temperature?: string | null; level?: number } = {}): Promise<{ lead: string; cand: string }> {
  const n = ++seq;
  const c = (
    await db.admin<{ id: string; lead_id: string }>(
      "insert into public.research_candidates (workspace_id, run_id, name, name_key, phone, temperature, user_decision, verified_at) values ($1,$2,$3,$4,$5,$6,'keep',now()) returning id, lead_id",
      [t.ws, t.run, `Company ${n}`, `company ${n}`, opts.phone ?? null, opts.temperature ?? null],
    )
  )[0];
  await db.admin("update public.leads set level = $2 where id = $1", [c.lead_id, opts.level ?? 2]);
  return { lead: c.lead_id, cand: c.id };
}

const phone = (n: number) => `508-555-01${String(n).padStart(2, "0")}`;

async function callAgent(t: Team, config: Record<string, unknown>, opts: { ligar?: boolean } = {}): Promise<string> {
  const id = (
    await db.query<{ id: string }>(as(t.owner), "insert into public.agents (workspace_id, type, name, config) values ($1,'call','Ligação',$2::jsonb) returning id", [
      t.ws,
      JSON.stringify(config),
    ])
  )[0].id;
  await db.query(as(t.owner), "update public.agents set status = 'paused' where id = $1", [id]);
  if (opts.ligar !== false) await db.query(as(t.owner), "update public.agents set status = 'running' where id = $1", [id]);
  return id;
}

const cfg = (caller: string, over: Record<string, unknown> = {}) => ({ caller_id: caller, per_day: 20, min_level: 1, temperatures: [], ...over });

const build = async (user: string, agent: string) => (await db.query<{ n: number }>(as(user), "select public.build_call_list($1) as n", [agent]))[0].n;
const listOf = async (agent: string) =>
  (await db.admin<{ lead_id: string }>("select lead_id from public.call_list_items where agent_id = $1 order by list_date, position", [agent])).map((r) => r.lead_id);
const logCall = (user: string, lead: string, outcome: string, more: { agent?: string | null; nextAt?: string | null } = {}) =>
  db.query<{ s: string }>(as(user), "select public.log_call($1,$2,$3,'Pat (office manager)','Short note','Call back',$4::timestamptz) as s", [
    lead,
    more.agent ?? null,
    outcome,
    more.nextAt ?? null,
  ]).then((r) => r[0].s);
const leadRow = (id: string) =>
  db.admin<{ status: string; owner_id: string | null; do_not_call: boolean; do_not_call_at: string | null }>(
    "select status, owner_id, do_not_call, do_not_call_at from public.leads where id = $1",
    [id],
  ).then((r) => r[0]);
const callable = async (lead: string, caller: string) =>
  (await db.admin<{ ok: boolean }>("select public.lead_callable($1,$2) as ok", [lead, caller]))[0].ok;
/** Test-only clock travel: every call and list row of the lead happened `days` days earlier. */
const ageLead = async (lead: string, days: number) => {
  await db.admin(`update public.call_logs set called_at = called_at - make_interval(days => $2), created_at = created_at - make_interval(days => $2) where lead_id = $1`, [lead, days]);
  await db.admin("update public.call_list_items set list_date = list_date - $2::int where lead_id = $1", [lead, days]);
};

describe("0020 part B status rule", () => {
  test("status after a call matches the shared vectors", async () => {
    const rows = await db.admin<{ s: string; o: string; after: string }>(
      "select x.s, x.o, public.lead_status_after_call(x.s, x.o) as after from unnest($1::text[], $2::text[]) with ordinality as x(s, o, i) order by x.i",
      [CALL_STATUS_VECTORS.map((v) => v.status), CALL_STATUS_VECTORS.map((v) => v.outcome)],
    );
    expect(rows.map((r) => ({ status: r.s, outcome: r.o, after: r.after }))).toEqual(CALL_STATUS_VECTORS);
    expect(CALL_STATUS_VECTORS).toHaveLength(56);
  });
});

describe("0020 part B call log", () => {
  test("log_call: sender or the assigned closer; phone_used comes from the lead; recorded is always false", async () => {
    const t = await seedTeam();
    const { lead } = await seedLead(t, { phone: phone(1) });
    const { lead: noPhone } = await seedLead(t);
    await db.admin("update public.leads set owner_id = $2 where id = $1", [lead, t.closer]);

    expect(await logCall(t.closer, lead, "talked")).toBe("call_list");
    const [row] = await db.admin<{ phone_used: string; recorded: boolean; called_by: string; spoke_to: string; outcome: string }>(
      "select phone_used, recorded, called_by, spoke_to, outcome from public.call_logs where lead_id = $1",
      [lead],
    );
    expect(row).toEqual({ phone_used: phone(1), recorded: false, called_by: t.closer, spoke_to: "Pat (office manager)", outcome: "talked" });
    expect((await leadRow(lead)).status).toBe("call_list");

    expect(code((await db.try(as(t.closer2), "select public.log_call($1,null,'talked','','','',null)", [lead])).error)).toBe("42501");
    expect(await logCall(t.sdr, lead, "voicemail")).toBe("call_list");

    // no recording ever (MA all-party consent): not even the migration role can store one
    const rec = await db
      .admin("insert into public.call_logs (workspace_id, lead_id, phone_used, outcome, recorded) values ($1,$2,$3,'talked',true)", [t.ws, lead, phone(1)])
      .then(() => null, (e: unknown) => e);
    expect(code(rec)).toBe("23514");
    // no client writes
    for (const u of [t.owner, t.closer]) {
      const r = await db.try(as(u), "insert into public.call_logs (workspace_id, lead_id, phone_used, outcome) values ($1,$2,$3,'talked')", [t.ws, lead, phone(1)]);
      expect(r.error?.message).toMatch(/permission denied/);
    }

    expect(code((await db.try(as(t.owner), "select public.log_call($1,null,'talked','','','',null)", [noPhone])).error)).toBe("55000");
    const yearAway = new Date(Date.now() + 365 * 86_400_000).toISOString();
    expect(code((await db.try(as(t.owner), "select public.log_call($1,null,'talked','','','',$2::timestamptz)", [lead, yearAway])).error)).toBe("22023");
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    expect(code((await db.try(as(t.owner), "select public.log_call($1,null,'talked','','','',$2::timestamptz)", [lead, twoDaysAgo])).error)).toBe("22023");
    expect(code((await db.try(as(t.owner), "select public.log_call($1,null,'sms','','','',null)", [lead])).error)).toBe("22023");
    // the agent, when named, is a call agent of the lead's workspace
    const hunter = (await db.query<{ id: string }>(as(t.owner), "insert into public.agents (workspace_id, type, name) values ($1,'hunter','Caçador') returning id", [t.ws]))[0].id;
    expect(code((await db.try(as(t.owner), "select public.log_call($1,$2,'talked','','','',null)", [lead, hunter])).error)).toBe("22023");

    expect(await logCall(t.closer, lead, "meeting_booked")).toBe("meeting");
    expect((await leadRow(lead)).status).toBe("meeting");
  });

  test("do_not_call blocks every future list, the manual add, and stops active prospects", async () => {
    const t = await seedTeam();
    const { lead, cand } = await seedLead(t, { phone: phone(2), temperature: "hot" });
    const camp = (await db.admin<{ id: string }>("insert into public.email_campaigns (workspace_id, name) values ($1,'Campanha') returning id", [t.ws]))[0].id;
    const prospect = (
      await db.admin<{ id: string }>(
        "insert into public.email_prospects (workspace_id, campaign_id, candidate_id, company_name, email, email_source) values ($1,$2,$3,'Company','pat@company.example','manual') returning id",
        [t.ws, camp, cand],
      )
    )[0].id;
    const msg = (
      await db.admin<{ id: string }>(
        "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body) values ($1,$2,$3,'sequence',2,'Following up','Short follow-up.') returning id",
        [t.ws, camp, prospect],
      )
    )[0].id;
    expect(await callable(lead, t.closer)).toBe(false); // in an active campaign

    expect(await logCall(t.owner, lead, "do_not_call")).toBe("lost");
    const l = await leadRow(lead);
    expect(l).toMatchObject({ status: "lost", do_not_call: true });
    expect(l.do_not_call_at).not.toBeNull();
    expect((await db.admin("select status, stop_reason from public.email_prospects where id = $1", [prospect]))[0]).toEqual({ status: "stopped", stop_reason: "asked_to_stop" });
    expect((await db.admin("select status, cancel_reason from public.email_messages where id = $1", [msg]))[0]).toEqual({ status: "cancelled", cancel_reason: "do_not_call" });

    // the next day, even back to "new" by hand: never listed, never added
    await ageLead(lead, 2);
    await db.admin("update public.leads set status = 'new' where id = $1", [lead]);
    expect(await callable(lead, t.closer)).toBe(false);
    const agent = await callAgent(t, cfg(t.closer));
    expect(await build(t.owner, agent)).toBe(0);
    expect(code((await db.try(as(t.owner), "select public.add_to_call_list($1,$2)", [lead, agent])).error)).toBe("55000");
    // a last call can still be recorded
    expect(await logCall(t.owner, lead, "no_answer")).toBe("call_list");
    expect((await leadRow(lead)).do_not_call).toBe(true);
  });

  test("wrong number comes back only with a new phone", async () => {
    const t = await seedTeam();
    const { lead, cand } = await seedLead(t, { phone: phone(3) });
    const agent = await callAgent(t, cfg(t.closer));
    expect(await build(t.owner, agent)).toBe(1);
    expect(await logCall(t.closer, lead, "wrong_number")).toBe("call_list");
    await ageLead(lead, 2);
    expect(await callable(lead, t.closer)).toBe(false);
    expect(await build(t.owner, agent)).toBe(0);
    await db.admin("update public.research_candidates set phone = $2 where id = $1", [cand, "(508) 555-0103"]); // same number, other format
    expect(await callable(lead, t.closer)).toBe(false);
    await db.admin("update public.research_candidates set phone = $2 where id = $1", [cand, phone(13)]);
    expect(await callable(lead, t.closer)).toBe(true);
    expect(await build(t.owner, agent)).toBe(1);
  });
});

describe("0020 part B call list", () => {
  test("the call list: phone, not do_not_call, not in an active campaign, not called today, callbacks first, then temperature and level", async () => {
    const t = await seedTeam();
    const cold3 = await seedLead(t, { phone: phone(10), temperature: "cold", level: 3 });
    const veryHot1 = await seedLead(t, { phone: phone(11), temperature: "very_hot", level: 1 });
    const hot2 = await seedLead(t, { phone: phone(12), temperature: "hot", level: 2 });
    const hot4 = await seedLead(t, { phone: phone(14), temperature: "hot", level: 4 });
    const callback = await seedLead(t, { phone: phone(15), temperature: "cold", level: 1 });
    const warm1 = await seedLead(t, { phone: phone(16), temperature: "warm", level: 1 });
    // an imported lead: no candidate, the phone comes from its fields; no temperature, so it goes last
    const imported = (await db.admin<{ id: string }>("insert into public.leads (workspace_id, origin_kind) values ($1,'import') returning id", [t.ws]))[0].id;
    await db.admin("insert into public.lead_fields (workspace_id, lead_id, field, value, source, source_ref) values ($1,$2,'phone',$3,'import','seed')", [t.ws, imported, phone(17)]);
    await db.admin("update public.leads set level = 1 where id = $1", [imported]);
    // out: no phone, do-not-call, active prospect, someone else's lead, called today, a callback not due yet, level 0, closed
    const noPhone = await seedLead(t);
    const dnc = await seedLead(t, { phone: phone(18), temperature: "very_hot" });
    await db.admin("update public.leads set do_not_call = true, do_not_call_at = now() where id = $1", [dnc.lead]);
    const inCampaign = await seedLead(t, { phone: phone(19), temperature: "very_hot" });
    const camp = (await db.admin<{ id: string }>("insert into public.email_campaigns (workspace_id, name) values ($1,'Campanha') returning id", [t.ws]))[0].id;
    await db.admin("insert into public.email_prospects (workspace_id, campaign_id, candidate_id, company_name, email, email_source) values ($1,$2,$3,'Company','pat@company.example','manual')", [
      t.ws,
      camp,
      inCampaign.cand,
    ]);
    const others = await seedLead(t, { phone: phone(20), temperature: "very_hot" });
    await db.admin("update public.leads set owner_id = $2 where id = $1", [others.lead, t.closer2]);
    const calledToday = await seedLead(t, { phone: phone(21), temperature: "very_hot" });
    await logCall(t.owner, calledToday.lead, "no_answer");
    const later = await seedLead(t, { phone: phone(22), temperature: "very_hot" });
    await logCall(t.owner, later.lead, "talked", { nextAt: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    await ageLead(later.lead, 2);
    const level0 = await seedLead(t, { phone: phone(23), temperature: "very_hot", level: 0 });
    const won = await seedLead(t, { phone: phone(24), temperature: "very_hot" });
    await db.admin("update public.leads set status = 'won' where id = $1", [won.lead]);
    // the callback was due an hour ago
    await logCall(t.owner, callback.lead, "talked", { nextAt: new Date(Date.now() - 3_600_000).toISOString() });
    await ageLead(callback.lead, 1);
    expect([noPhone, dnc, inCampaign, level0].length).toBe(4);

    // a temperature filter keeps only those temperatures (and leaves leads without one out); rolled back
    const hotAgent = await callAgent(t, cfg(t.closer, { temperatures: ["hot"] }));
    const hotOnly = await db.run(as(t.sdr), async (q: Query) => {
      await q("select public.build_call_list($1)", [hotAgent]);
      return (await q<{ lead_id: string }>("select lead_id from public.call_list_items where agent_id = $1 order by position", [hotAgent])).map((r) => r.lead_id);
    });
    expect(hotOnly).toEqual([hot4.lead, hot2.lead]);

    const agent = await callAgent(t, cfg(t.closer));
    expect(await build(t.sdr, agent)).toBe(7);
    const expected = [callback.lead, veryHot1.lead, hot4.lead, hot2.lead, warm1.lead, cold3.lead, imported];
    expect(await listOf(agent)).toEqual(expected);
    const positions = await db.admin<{ position: number; caller_id: string; list_date: string }>(
      "select position, caller_id, list_date::text = public.call_day()::text as today from public.call_list_items where agent_id = $1 order by position",
      [agent],
    );
    expect(positions.map((p) => p.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(positions.map((p) => p.caller_id))).toEqual(new Set([t.closer]));
    for (const id of expected) expect(await leadRow(id), id).toMatchObject({ owner_id: t.closer, status: "call_list" });
    expect((await leadRow(others.lead)).owner_id).toBe(t.closer2);
    expect((await leadRow(won.lead)).status).toBe("won");

    // the manual add: sender only, a callable lead, appended after the list and not counted against per_day
    const extra = await seedLead(t, { phone: phone(25), temperature: "cold", level: 0 });
    expect(code((await db.try(as(t.closer), "select public.add_to_call_list($1,$2)", [extra.lead, agent])).error)).toBe("42501");
    expect(code((await db.try(as(t.owner), "select public.add_to_call_list($1,$2)", [others.lead, agent])).error)).toBe("55000");
    await db.query(as(t.owner), "select public.add_to_call_list($1,$2)", [extra.lead, agent]);
    expect((await listOf(agent)).at(-1)).toBe(extra.lead);
    expect(await leadRow(extra.lead)).toMatchObject({ owner_id: t.closer, status: "call_list" });
    expect(code((await db.try(as(t.owner), "select public.add_to_call_list($1,$2)", [extra.lead, agent])).error)).toBe("55000"); // already listed today
  });

  test("build is idempotent per day and never passes per_day", async () => {
    const t = await seedTeam();
    for (let i = 0; i < 5; i++) await seedLead(t, { phone: phone(30 + i), temperature: "warm" });
    const agent = await callAgent(t, cfg(t.closer, { per_day: 3 }));
    expect(await build(t.sdr, agent)).toBe(3);
    expect(await build(t.closer, agent)).toBe(0);
    expect((await db.query<{ n: number }>(as(t.closer), "select public.build_my_call_lists() as n"))[0].n).toBe(0);
    const listed = await listOf(agent);
    expect(listed).toHaveLength(3);
    await logCall(t.closer, listed[0], "no_answer", { agent });
    await logCall(t.closer, listed[1], "voicemail", { agent });
    expect(await build(t.owner, agent)).toBe(0);
    expect(await listOf(agent)).toEqual(listed);
    // not the caller and not a sender; a paused agent builds nothing
    expect(code((await db.try(as(t.closer2), "select public.build_call_list($1)", [agent])).error)).toBe("42501");
    await db.query(as(t.owner), "update public.agents set status = 'paused' where id = $1", [agent]);
    expect(code((await db.try(as(t.owner), "select public.build_call_list($1)", [agent])).error)).toBe("55000");
  });

  test("the closer reads only her list rows and the calls of her leads", async () => {
    const t = await seedTeam();
    for (let i = 0; i < 4; i++) await seedLead(t, { phone: phone(40 + i), temperature: "hot" });
    const mine = await callAgent(t, cfg(t.closer, { per_day: 2 }));
    const hers = await callAgent(t, cfg(t.closer2, { per_day: 2 }));
    expect(await build(t.owner, mine)).toBe(2);
    expect((await db.query<{ n: number }>(as(t.closer2), "select public.build_my_call_lists() as n"))[0].n).toBe(2);
    const [m1] = await listOf(mine);
    const [h1] = await listOf(hers);
    await logCall(t.closer, m1, "talked");
    await logCall(t.closer2, h1, "talked");
    await logCall(t.owner, h1, "voicemail");

    const rows = await db.query<{ agent_id: string; caller_id: string }>(as(t.closer), "select agent_id, caller_id from public.call_list_items");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.agent_id === mine && r.caller_id === t.closer)).toBe(true);
    const calls = await db.query<{ lead_id: string }>(as(t.closer), "select lead_id from public.call_logs");
    expect(calls.map((c) => c.lead_id)).toEqual([m1]);
    expect(await db.query(as(t.closer), "select id from public.agents")).toEqual([]);
    expect(code((await db.try(as(t.closer), "select public.build_call_list($1)", [hers])).error)).toBe("42501");
    expect(code((await db.try(as(t.closer), "select public.log_call($1,null,'talked','','','',null)", [h1])).error)).toBe("42501");
    // senders see everything of the workspace; another workspace sees nothing
    expect(await db.query(as(t.sdr), "select id from public.call_list_items")).toHaveLength(4);
    expect(await db.query(as(t.sdr), "select id from public.call_logs")).toHaveLength(3);
    const stranger = await seedTeam();
    expect(await db.query(as(stranger.owner), "select id from public.call_list_items")).toEqual([]);
    expect(await db.query(as(stranger.owner), "select id from public.call_logs")).toEqual([]);
    expect(code((await db.try(as(stranger.owner), "select public.build_call_list($1)", [mine])).error)).toBe("42501");
    // internal helpers are not callable by clients
    for (const fn of ["lead_callable($1,$2)", "lead_phone($1)", "lead_in_active_campaign($1)"]) {
      const r = await db.try(as(t.owner), `select public.${fn}`, fn.includes("$2") ? [m1, t.closer] : [m1]);
      expect(r.error?.message, fn).toMatch(/permission denied/);
    }
  });
});

describe("0020 part B call agent", () => {
  test("call agent: born draft, paused only with a valid config, then only Ligar/Pausar; config frozen; a running call agent is never picked by the hunter or sources clock", async () => {
    const t = await seedTeam();
    const insert = async (config: unknown) =>
      (
        await db.query<{ id: string; status: string }>(as(t.owner), "insert into public.agents (workspace_id, type, name, status, config) values ($1,'call','Ligação','running',$2::jsonb) returning id, status", [
          t.ws,
          JSON.stringify(config),
        ])
      )[0];
    const pause = (id: string) => db.try(as(t.owner), "update public.agents set status = 'paused' where id = $1", [id]);
    const bad = [
      cfg(randomUUID()), // not a member
      cfg(t.closer, { per_day: 0 }),
      cfg(t.closer, { per_day: 51 }),
      cfg(t.closer, { per_day: 2.5 }),
      cfg(t.closer, { min_level: 5 }),
      cfg(t.closer, { temperatures: ["hot", "boiling"] }),
      cfg(t.closer, { temperatures: ["hot", "hot"] }),
      cfg(t.closer, { extra: 1 }), // unknown key
      { caller_id: t.closer, per_day: 20, min_level: 1 }, // missing key
      cfg("not-a-uuid"),
    ];
    for (const c of bad) {
      const a = await insert(c);
      expect(a.status).toBe("draft");
      expect(code((await pause(a.id)).error), JSON.stringify(c)).toBe("23514");
    }
    const a = await insert(cfg(t.sdr, { temperatures: ["very_hot", "warm"] })); // any role can be the caller
    expect((await pause(a.id)).error).toBeUndefined();
    await db.query(as(t.owner), "update public.agents set status = 'paused' where id = $1", [a.id]);
    expect(code((await db.try(as(t.owner), "update public.agents set config = $2::jsonb where id = $1", [a.id, JSON.stringify(cfg(t.sdr, { per_day: 5 }))])).error)).toBe("23514");
    await db.query(as(t.owner), "update public.agents set status = 'running' where id = $1", [a.id]);
    expect(code((await db.try(as(t.owner), "update public.agents set status = 'done' where id = $1", [a.id])).error)).toBe("23514");
    expect(code((await db.try(as(t.owner), "update public.agents set status = 'draft' where id = $1", [a.id])).error)).toBe("23514");
    // the e-mail agent insert is unchanged
    expect((await db.query<{ status: string }>(as(t.owner), "insert into public.agents (workspace_id, type, name) values ($1,'email','E-mail') returning status", [t.ws]))[0].status).toBe("draft");

    // the clocks ignore it
    const tick = await beginTick(db);
    const due = (await db.query<{ r: { run_ids: string[] } }>(clock, "select public.hunter_due_work($1) as r", [tick]))[0].r;
    expect(due.run_ids ?? []).toEqual([]);
    await setSchedulerToken(db, TOKEN);
    const stick = (await db.query<{ r: { tick_id: string } }>(clock, "select public.source_begin_tick() as r"))[0].r.tick_id;
    expect((await db.query<{ n: number }>(clock, "select public.source_enqueue_agent_runs($1) as n", [stick]))[0].n).toBe(0);
    expect(await db.admin("select id from public.research_runs where agent_id = $1", [a.id])).toEqual([]);
    expect((await db.admin<{ status: string }>("select status from public.agents where id = $1", [a.id]))[0].status).toBe("running");
  });

  test("removing a member frees her leads and pauses the call agents she was the caller of", async () => {
    const t = await seedTeam();
    for (let i = 0; i < 2; i++) await seedLead(t, { phone: phone(50 + i), temperature: "hot" });
    const mine = await callAgent(t, cfg(t.closer));
    const hers = await callAgent(t, cfg(t.closer2));
    expect(await build(t.owner, mine)).toBe(2);
    const listed = await listOf(mine);
    await db.query(as(t.owner), "delete from public.workspace_members where workspace_id = $1 and user_id = $2", [t.ws, t.closer]);
    for (const id of listed) expect(await leadRow(id)).toMatchObject({ owner_id: null, status: "call_list" });
    const st = await db.admin<{ id: string; status: string }>("select id, status from public.agents where id = any($1::uuid[]) order by id", [[mine, hers]]);
    expect(Object.fromEntries(st.map((r) => [r.id, r.status]))).toEqual({ [mine]: "paused", [hers]: "running" });
    // her list rows stay, but she reads nothing any more; the agent cannot be turned on again with her as the caller
    expect(await db.query(as(t.closer), "select id from public.call_list_items")).toEqual([]);
    expect(code((await db.try(as(t.owner), "update public.agents set status = 'running' where id = $1", [mine])).error)).toBe("23514");
  });
});
