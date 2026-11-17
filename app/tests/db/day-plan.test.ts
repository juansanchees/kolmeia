import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, anon, as } from "./helpers";

// Migration 0037: the day plan column, the manual ticks and tasks of kind 'meeting' created by members (PGlite, real migrations, fictional data).

let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create();
});
afterAll(async () => {
  await db.pg.close();
});

type Team = { ws: string; owner: string; sdr: string; closer: string; closer2: string };

async function seedTeam(): Promise<Team> {
  const [owner, sdr, closer, closer2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  for (const u of [owner, sdr, closer, closer2]) await db.addUser(u);
  const ws = (await db.query<{ id: string }>(as(owner), "select public.create_workspace('Empresa Plano') as id"))[0].id;
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr'), ($1,$3,'closer'), ($1,$4,'closer')", [ws, sdr, closer, closer2]);
  return { ws, owner, sdr, closer, closer2 };
}
const lead = async (ws: string, owner: string | null = null) =>
  (await db.admin<{ id: string }>("insert into public.leads (workspace_id, origin_kind, level, owner_id) values ($1,'import',1,$2) returning id", [ws, owner]))[0].id;
const newTask = "insert into public.tasks (workspace_id, lead_id, kind, title, due_at, assignee_id) values ($1,$2,$3,'Reunião na obra',now() + interval '1 day',$4) returning id";

describe("0037 home_rules.plan", () => {
  test("the app's upsert saves rule and plan together; the plan must be a small object", async () => {
    const t = await seedTeam();
    const upsert = `insert into public.home_rules (workspace_id, rule, plan, updated_at) values ($1, $2::jsonb, $3::jsonb, now())
      on conflict (workspace_id, user_id) do update set workspace_id = excluded.workspace_id, rule = excluded.rule, plan = excluded.plan, updated_at = excluded.updated_at`;
    await db.query(as(t.sdr), upsert, [t.ws, "{}", JSON.stringify({ order: ["call", "returns", "email", "review"] })]);
    await db.query(as(t.sdr), upsert, [t.ws, "{}", JSON.stringify({ hidden: ["email"] })]);
    expect(await db.query(as(t.sdr), "select plan->'hidden'->>0 as h from public.home_rules")).toEqual([{ h: "email" }]);
    expect(await db.query(as(t.owner), "select * from public.home_rules")).toEqual([]);
    expect((await db.try(as(t.sdr), upsert, [t.ws, "{}", "[]"])).error).toBeDefined();
    expect((await db.try(as(t.sdr), upsert, [t.ws, "{}", JSON.stringify({ x: "y".repeat(5000) })])).error).toBeDefined();
    // an old row (0035, no plan) reads as an empty plan: the app's defaults apply
    await db.query(as(t.owner), "insert into public.home_rules (workspace_id, rule) values ($1,'{}'::jsonb)", [t.ws]);
    expect(await db.query(as(t.owner), "select plan from public.home_rules")).toEqual([{ plan: {} }]);
  });
});

describe("0037 day_plan_marks", () => {
  test("own rows only: a member ticks, unticks and reads only their own; outsiders and anon get nothing", async () => {
    const t = await seedTeam();
    const ins = "insert into public.day_plan_marks (workspace_id, day, item_key) values ($1,'2026-11-17',$2) on conflict do nothing";
    await db.query(as(t.sdr), ins, [t.ws, "call:abc"]);
    await db.query(as(t.sdr), ins, [t.ws, "call:abc"]); // ticking twice is fine (the app upserts ignoring duplicates)
    await db.query(as(t.closer), ins, [t.ws, "task:1"]);
    expect(await db.query(as(t.sdr), "select item_key from public.day_plan_marks")).toEqual([{ item_key: "call:abc" }]);
    expect(await db.query(as(t.closer), "select item_key from public.day_plan_marks")).toEqual([{ item_key: "task:1" }]);
    // nobody deletes or writes someone else's tick
    expect(await db.query(as(t.owner), "delete from public.day_plan_marks returning 1")).toEqual([]);
    expect((await db.try(as(t.owner), "insert into public.day_plan_marks (workspace_id, user_id, day, item_key) values ($1,$2,'2026-11-17','x:1')", [t.ws, t.sdr])).error).toBeDefined();
    expect(await db.query(as(t.sdr), "delete from public.day_plan_marks where item_key = 'call:abc' returning 1")).toHaveLength(1);
    expect((await db.try(as(t.sdr), ins, [t.ws, ""])).error).toBeDefined();
    const outsider = randomUUID();
    await db.addUser(outsider);
    expect((await db.try(as(outsider), ins, [t.ws, "call:x"])).error).toBeDefined();
    expect((await db.try(anon, "select * from public.day_plan_marks")).error).toBeDefined();
  });
});

describe("0037 tasks: meetings and new tasks", () => {
  test("senders create a meeting on any lead of the workspace; it updates like other tasks", async () => {
    const t = await seedTeam();
    const a = await lead(t.ws, t.closer);
    const [{ id }] = await db.query<{ id: string }>(as(t.sdr), newTask, [t.ws, a, "meeting", t.closer]);
    expect(await db.admin("select kind, assignee_id from public.tasks where id = $1", [id])).toEqual([{ kind: "meeting", assignee_id: t.closer }]);
    expect(await db.query(as(t.owner), "update public.tasks set due_at = now() + interval '2 days', done_at = now() where id = $1 returning id", [id])).toHaveLength(1);
    expect(await db.query(as(t.owner), "update public.tasks set done_at = null where id = $1 returning id", [id])).toHaveLength(1);
    // still no free-form writes: an unknown kind, a done_at or a call link on insert, a title change
    expect((await db.try(as(t.sdr), newTask, [t.ws, a, "lunch", null])).error).toBeDefined();
    expect((await db.try(as(t.sdr), "insert into public.tasks (workspace_id, lead_id, due_at, done_at) values ($1,$2,now(),now())", [t.ws, a])).error).toBeDefined();
    expect((await db.try(as(t.sdr), "update public.tasks set title = 'x'")).error).toBeDefined();
    // not for someone outside the workspace, nor on another workspace's lead
    const outsider = randomUUID();
    await db.addUser(outsider);
    expect((await db.try(as(t.sdr), newTask, [t.ws, a, "call", outsider])).error).toBeDefined();
    const other = (await db.query<{ id: string }>(as(outsider), "select public.create_workspace('Outra') as id"))[0].id;
    const foreign = await lead(other);
    expect((await db.try(as(t.sdr), newTask, [t.ws, foreign, "call", null])).error).toBeDefined();
    expect((await db.try(as(outsider), newTask, [t.ws, a, "call", outsider])).error).toBeDefined();
    expect((await db.try(anon, newTask, [t.ws, a, "call", null])).error).toBeDefined();
  });

  test("the closer creates tasks only on her leads, only for herself, and never sees the others' leads' tasks", async () => {
    const t = await seedTeam();
    const hers = await lead(t.ws, t.closer);
    const notHers = await lead(t.ws, t.closer2);
    expect(await db.query(as(t.closer), newTask, [t.ws, hers, "meeting", t.closer])).toHaveLength(1);
    expect((await db.try(as(t.closer), newTask, [t.ws, hers, "meeting", t.sdr])).error).toBeDefined();
    expect((await db.try(as(t.closer), newTask, [t.ws, hers, "meeting", null])).error).toBeDefined();
    expect((await db.try(as(t.closer), newTask, [t.ws, notHers, "call", t.closer])).error).toBeDefined();
    await db.query(as(t.sdr), newTask, [t.ws, notHers, "meeting", t.closer2]);
    expect((await db.query<{ lead_id: string }>(as(t.closer), "select lead_id from public.tasks")).map((r) => r.lead_id)).toEqual([hers]);
    expect(await db.query(as(t.closer), "update public.tasks set done_at = now() where lead_id = $1 returning id", [notHers])).toEqual([]);
    expect(await db.query(as(t.sdr), "select id from public.tasks where workspace_id = $1", [t.ws])).toHaveLength(2);
  });

  test("a sender gives a closer a task only on a lead assigned to her; never a done task or a call link", async () => {
    const t = await seedTeam();
    const hers = await lead(t.ws, t.closer);
    const other = await lead(t.ws, t.closer2);
    const free = await lead(t.ws);
    expect(await db.query(as(t.sdr), newTask, [t.ws, hers, "meeting", t.closer])).toHaveLength(1);
    expect((await db.try(as(t.sdr), newTask, [t.ws, other, "meeting", t.closer])).error).toBeDefined();
    expect((await db.try(as(t.owner), newTask, [t.ws, free, "call", t.closer])).error).toBeDefined();
    // to another sender or to nobody: any lead
    expect(await db.query(as(t.owner), newTask, [t.ws, other, "call", t.sdr])).toHaveLength(1);
    expect(await db.query(as(t.owner), newTask, [t.ws, free, "call", null])).toHaveLength(1);
    // the task the closer can see is the one on her lead
    expect((await db.query<{ lead_id: string }>(as(t.closer), "select lead_id from public.tasks")).map((r) => r.lead_id)).toEqual([hers]);
    const [{ id: callId }] = await db.admin<{ id: string }>("insert into public.call_logs (workspace_id, lead_id, phone_used, outcome) values ($1,$2,'508-555-0100','talked') returning id", [t.ws, free]);
    expect((await db.try(as(t.sdr), "insert into public.tasks (workspace_id, lead_id, due_at, created_from_call_id) values ($1,$2,now(),$3)", [t.ws, free, callId])).error).toBeDefined();
    expect((await db.try(as(t.sdr), "insert into public.tasks (workspace_id, lead_id, due_at, done_at) values ($1,$2,now(),now())", [t.ws, free])).error).toBeDefined();
  });
});

describe("0037 plan_call_stats", () => {
  test("per lead: unanswered calls, newest outcome, called by me since; RLS: the closer only her leads", async () => {
    const t = await seedTeam();
    const a = await lead(t.ws, t.closer);
    const b = await lead(t.ws);
    const call = (leadId: string, outcome: string, by: string, at: string) =>
      db.admin("insert into public.call_logs (workspace_id, lead_id, phone_used, outcome, called_by, called_at) values ($1,$2,'508-555-0100',$3,$4,$5::timestamptz)", [t.ws, leadId, outcome, by, at]);
    await call(a, "no_answer", t.sdr, "2026-11-10T15:00:00Z");
    await call(a, "voicemail", t.sdr, "2026-11-12T15:00:00Z");
    await call(a, "meeting_booked", t.sdr, "2026-11-17T15:00:00Z");
    await call(b, "no_answer", t.owner, "2026-11-16T15:00:00Z");
    const stats = (u: string) => db.query(as(u), "select lead_id, no_answer, last_outcome, by_me_since from public.plan_call_stats($1, '2026-11-17T05:00:00Z')", [t.ws]);
    const sdr = await stats(t.sdr);
    expect(sdr).toEqual(expect.arrayContaining([
      { lead_id: a, no_answer: 2, last_outcome: "meeting_booked", by_me_since: true },
      { lead_id: b, no_answer: 1, last_outcome: "no_answer", by_me_since: false },
    ]));
    expect(sdr).toHaveLength(2);
    expect(await stats(t.closer)).toEqual([{ lead_id: a, no_answer: 2, last_outcome: "meeting_booked", by_me_since: false }]);
    expect(await stats(t.closer2)).toEqual([]);
    expect((await db.try(anon, "select * from public.plan_call_stats($1, now())", [t.ws])).error).toBeDefined();
  });
});
