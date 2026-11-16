import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MIGRATION_PATHS, TestDb, anon, as } from "./helpers";
import { CIPHER } from "./scheduler-seed";

// Migration 0027 (leads phase 1): contacted tracking, facet counts, saved views, named lists, tasks.
// Fictional data only (*.example, 508-555-01xx). Real migrations, non-superuser roles (PGlite).

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
  const ws = (await db.query<{ id: string }>(as(owner), "select public.create_workspace('Empresa F1') as id"))[0].id;
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr'), ($1,$3,'closer'), ($1,$4,'closer')", [ws, sdr, closer, closer2]);
  return { ws, owner, sdr, closer, closer2 };
}

let seq = 0;
/** An imported lead with its fields (superuser setup). */
async function lead(t: Team, f: { city?: string; phone?: string; email?: string; level?: number; owner?: string } = {}): Promise<string> {
  const id = (await db.admin<{ id: string }>("insert into public.leads (workspace_id, origin_kind, level, owner_id) values ($1,'import',$2,$3) returning id", [t.ws, f.level ?? 1, f.owner ?? null]))[0].id;
  const fields: [string, string][] = [["name", `Co ${++seq}`]];
  if (f.city) fields.push(["city", f.city]);
  if (f.phone) fields.push(["phone", f.phone]);
  if (f.email) fields.push(["email", f.email]);
  for (const [field, value] of fields) {
    await db.admin("insert into public.lead_fields (workspace_id, lead_id, field, value, source) values ($1,$2,$3,$4,'import')", [t.ws, id, field, value]);
  }
  await db.admin("update public.leads set level = $2 where id = $1", [id, f.level ?? 1]); // the qualifier recomputes it on field inserts
  return id;
}

const contactOf = (id: string) =>
  db.admin<{ first_contacted_at: string | null; last_touch_at: string | null }>("select first_contacted_at, last_touch_at from public.leads where id = $1", [id]).then((r) => r[0]);
const logCall = (user: string, leadId: string, outcome: string, nextStep = "", nextAt: string | null = null) =>
  db.query(as(user), "select public.log_call($1,null,$2,'','',$3,$4::timestamptz)", [leadId, outcome, nextStep, nextAt]);
type Values = { lead_id: string; contacted: boolean; city: string | null; phone: string | null; email: string | null };
const values = (user: string, ws: string) =>
  db.query<Values>(as(user), "select lead_id, contacted, city, phone, email from public.lead_contact_values($1) order by city, lead_id", [ws]);
const openTasks = (leadId: string) => db.admin<{ title: string }>("select title from public.tasks where lead_id = $1 and done_at is null", [leadId]);

describe("0027 contacted tracking", () => {
  test("a new call closes the earlier call follow-ups: two dated calls leave 1 open task; do-not-call leaves 0", async () => {
    const t = await seedTeam();
    const a = await lead(t, { phone: "508-555-0161" });
    const due = new Date(Date.now() + 86_400_000).toISOString();
    await logCall(t.sdr, a, "voicemail", "Tentar de novo", due);
    await logCall(t.sdr, a, "talked", "Mandar proposta", due);
    expect(await openTasks(a)).toEqual([{ title: "Mandar proposta" }]);
    await logCall(t.sdr, a, "do_not_call", "nunca", due);
    expect(await openTasks(a)).toHaveLength(0);
    expect(await db.admin("select 1 from public.tasks where lead_id = $1", [a])).toHaveLength(2);
  });

  test("a logged call marks the lead contacted; a next-step date becomes a task; do-not-call makes none", async () => {
    const t = await seedTeam();
    const a = await lead(t, { phone: "508-555-0101" });
    const b = await lead(t, { phone: "508-555-0102" });
    expect((await contactOf(a)).first_contacted_at).toBeNull();

    const due = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await logCall(t.sdr, a, "talked", "Mandar portfólio", due);
    const c = await contactOf(a);
    expect(c.first_contacted_at).not.toBeNull();
    expect(c.last_touch_at).toEqual(c.first_contacted_at);
    const [task] = await db.admin<{ kind: string; title: string; due_at: Date; assignee_id: string; created_from_call_id: string; done_at: null }>(
      "select kind, title, due_at, assignee_id, created_from_call_id, done_at from public.tasks where lead_id = $1",
      [a],
    );
    expect(task).toMatchObject({ kind: "call", title: "Mandar portfólio", assignee_id: t.sdr, done_at: null });
    expect(new Date(task.due_at).toISOString()).toBe(due);
    expect(task.created_from_call_id).toBe((await db.admin<{ id: string }>("select id from public.call_logs where lead_id = $1", [a]))[0].id);

    // the first contact stays; the last touch moves
    await db.admin("update public.leads set first_contacted_at = now() - interval '3 days', last_touch_at = now() - interval '3 days' where id = $1", [a]);
    await logCall(t.sdr, a, "voicemail");
    const c2 = await contactOf(a);
    expect(Date.now() - Date.parse(c2.first_contacted_at!)).toBeGreaterThan(2 * 86_400_000);
    expect(Date.now() - Date.parse(c2.last_touch_at!)).toBeLessThan(60_000);
    // the new call (no date) closes the earlier follow-up and opens none
    expect(await db.admin("select 1 from public.tasks where lead_id = $1", [a])).toHaveLength(1);
    expect(await openTasks(a)).toHaveLength(0);

    await logCall(t.sdr, b, "do_not_call", "nunca mais", due);
    expect((await contactOf(b)).first_contacted_at).not.toBeNull();
    expect(await db.admin("select 1 from public.tasks where lead_id = $1", [b])).toHaveLength(0);
  });

  test("hand-off to the closer marks contacted", async () => {
    const t = await seedTeam();
    const a = await lead(t);
    const brief = { who: "Pat", what_they_said: "Quer orçamento", next_step: "Visitar a obra", evidence_urls: [], model: "manual" };
    await db.query(as(t.sdr), "select public.hand_off_lead($1,$2,$3::jsonb)", [a, t.closer, JSON.stringify(brief)]);
    expect((await contactOf(a)).first_contacted_at).not.toBeNull();
  });

  test("a dry_run rehearsal does not mark contacted; a real sent e-mail does", async () => {
    const t = await seedTeam();
    const a = await lead(t, { email: "boss@acme-f1.example" });
    const mb = (await db.query<{ id: string }>(as(t.owner), "select public.save_mailbox($1,$2,$3) as id", [t.ws, "sales-f1@neair.example", CIPHER]))[0].id;
    const camp = (await db.query<{ id: string }>(as(t.owner), "insert into public.email_campaigns (workspace_id, name, mailbox_id) values ($1,'F1',$2) returning id", [t.ws, mb]))[0].id;
    await db.query(as(t.owner), "select public.add_leads_to_campaign($1,$2::uuid[])", [camp, [a]]);
    const prospect = (await db.admin<{ id: string }>("select id from public.email_prospects where lead_id = $1", [a]))[0].id;
    const logRow = async (mode: string, result: string) => {
      const id = (
        await db.admin<{ id: string }>(
          "insert into public.email_send_log (workspace_id, campaign_id, prospect_id, mailbox_address, mode, to_address) values ($1,$2,$3,'sales-f1@neair.example',$4,'boss@acme-f1.example') returning id",
          [t.ws, camp, prospect, mode],
        )
      )[0].id;
      await db.admin("update public.email_send_log set result = $2, finished_at = now() where id = $1", [id, result]);
    };

    await logRow("dry_run", "dry_run");
    await logRow("real", "failed");
    expect((await contactOf(a)).first_contacted_at).toBeNull();
    await logRow("real", "sent");
    expect((await contactOf(a)).first_contacted_at).not.toBeNull();
  });
});

describe("0027 display values", () => {
  test("lead_contact_values reads the displayed city/phone/e-mail, trimmed, and RLS: the closer gets only her leads", async () => {
    const t = await seedTeam();
    const a = await lead(t, { city: " Boston ", phone: "508-555-0111", email: "a@f1.example" });
    const b = await lead(t, { city: "Quincy", owner: t.closer });
    await lead(t, { city: "Quincy", owner: t.closer2 });
    await logCall(t.sdr, a, "talked");

    const all = await values(t.sdr, t.ws);
    expect(all).toHaveLength(3);
    expect(all[0]).toEqual({ lead_id: a, contacted: true, city: "Boston", phone: "508-555-0111", email: "a@f1.example" });
    expect((await values(t.closer, t.ws)).map((r) => r.lead_id)).toEqual([b]);
    expect(await values(randomUUID(), t.ws)).toEqual([]);
    expect((await db.try(anon, "select * from public.lead_contact_values($1)", [t.ws])).error).toBeDefined();
    expect((await db.admin("select 1 from pg_proc where proname = 'lead_facets'"))).toHaveLength(0);
  });
});

describe("0027 lists", () => {
  test("owner/sdr build lists; the closer and anon read and write none; list_stats counts contacted and phones", async () => {
    const t = await seedTeam();
    const a = await lead(t, { phone: "508-555-0121" });
    const b = await lead(t, { owner: t.closer });
    await logCall(t.sdr, a, "talked");
    const list = (await db.query<{ id: string }>(as(t.sdr), "insert into public.lists (workspace_id, name) values ($1,'Construtoras') returning id", [t.ws]))[0].id;
    await db.query(as(t.sdr), "insert into public.list_leads (list_id, lead_id, workspace_id) values ($1,$2,$3), ($1,$4,$3)", [list, a, t.ws, b]);

    expect(await db.query(as(t.owner), "select leads, contacted, with_phone from public.list_stats($1)", [t.ws])).toEqual([{ leads: 2, contacted: 1, with_phone: 1 }]);
    expect(await db.query(as(t.closer), "select * from public.lists")).toHaveLength(0);
    expect(await db.query(as(t.closer), "select * from public.list_leads")).toHaveLength(0);
    expect(await db.query(as(t.closer), "select * from public.list_stats($1)", [t.ws])).toHaveLength(0);
    expect((await db.try(as(t.closer), "insert into public.lists (workspace_id, name) values ($1,'Minha')", [t.ws])).error).toBeDefined();
    expect((await db.try(as(t.closer), "insert into public.list_leads (list_id, lead_id, workspace_id) values ($1,$2,$3)", [list, b, t.ws])).error).toBeDefined();
    expect((await db.try(anon, "select * from public.lists")).error).toBeDefined();

    // a lead of another workspace cannot be put on the list
    const other = await seedTeam();
    const foreign = await lead(other);
    expect((await db.try(as(t.sdr), "insert into public.list_leads (list_id, lead_id, workspace_id) values ($1,$2,$3)", [list, foreign, t.ws])).error).toBeDefined();
  });
});

describe("0027 tasks", () => {
  test("the closer reads and updates only tasks of leads handed to her; only done_at / due_at change", async () => {
    const t = await seedTeam();
    const hers = await lead(t, { phone: "508-555-0131", owner: t.closer });
    const notHers = await lead(t, { phone: "508-555-0132" });
    const due = new Date(Date.now() + 86_400_000).toISOString();
    await logCall(t.sdr, hers, "talked", "Ligar de novo", due);
    await logCall(t.sdr, notHers, "talked", "Ligar de novo", due);

    expect(await db.query(as(t.sdr), "select lead_id from public.tasks where workspace_id = $1", [t.ws])).toHaveLength(2);
    const seen = await db.query<{ id: string; lead_id: string }>(as(t.closer), "select id, lead_id from public.tasks");
    expect(seen.map((r) => r.lead_id)).toEqual([hers]);
    expect(await db.query(as(t.closer2), "select id from public.tasks")).toHaveLength(0);

    expect(await db.query(as(t.closer), "update public.tasks set done_at = now() returning id")).toHaveLength(1);
    expect((await db.admin<{ n: number }>("select count(*)::int as n from public.tasks where done_at is not null and workspace_id = $1", [t.ws]))[0].n).toBe(1);
    expect((await db.try(as(t.sdr), "update public.tasks set title = 'x'")).error).toBeDefined();
    expect((await db.try(as(t.sdr), "insert into public.tasks (workspace_id, lead_id, title, due_at) values ($1,$2,'x',now())", [t.ws, hers])).error).toBeDefined();
    expect((await db.try(anon, "select * from public.tasks")).error).toBeDefined();
  });
});

describe("0027 saved views", () => {
  test("each user reads only their own views; one default per user", async () => {
    const t = await seedTeam();
    await db.query(as(t.sdr), "insert into public.lead_views (workspace_id, name, filters, is_default) values ($1,'Quentes','{\"contact\":\"new\"}',true)", [t.ws]);
    expect(await db.query(as(t.sdr), "select name from public.lead_views")).toEqual([{ name: "Quentes" }]);
    expect(await db.query(as(t.owner), "select name from public.lead_views")).toEqual([]);
    expect((await db.try(as(t.sdr), "insert into public.lead_views (workspace_id, name, is_default) values ($1,'Outra',true)", [t.ws])).error).toBeDefined();
    expect((await db.try(as(t.owner), "insert into public.lead_views (workspace_id, user_id, name) values ($1,$2,'Falsa')", [t.ws, t.sdr])).error).toBeDefined();
    const outsider = randomUUID();
    await db.addUser(outsider);
    expect((await db.try(as(outsider), "insert into public.lead_views (workspace_id, name) values ($1,'Intrusa')", [t.ws])).error).toBeDefined();
  });
});

describe("0027 re-runnable", () => {
  test("running the migration again keeps data and the first contact", async () => {
    const t = await seedTeam();
    const a = await lead(t, { phone: "508-555-0141" });
    await logCall(t.sdr, a, "talked");
    const before = await contactOf(a);
    await db.pg.exec(readFileSync(MIGRATION_PATHS.find((p) => p.includes("0027_"))!, "utf8"));
    expect(await contactOf(a)).toEqual(before);
    expect((await values(t.sdr, t.ws)).map((r) => r.contacted)).toEqual([true]);
  });

  test("the back-fill opens a task for each lead's latest dated call (not do-not-call), once", async () => {
    const t = await seedTeam();
    const a = await lead(t, { phone: "508-555-0151" });
    const b = await lead(t, { phone: "508-555-0152" });
    const c = await lead(t, { phone: "508-555-0153" });
    const due = new Date(Date.now() + 86_400_000).toISOString();
    await logCall(t.sdr, a, "talked", "Primeira", due);
    await logCall(t.sdr, a, "talked", "Segunda", due);
    await logCall(t.sdr, b, "talked", "Antes", due);
    await logCall(t.sdr, b, "do_not_call");
    await logCall(t.sdr, c, "talked");
    // as if these calls were logged before 0027: no task rows yet
    await db.admin("delete from public.tasks where workspace_id = $1", [t.ws]);
    const sql = readFileSync(MIGRATION_PATHS.find((p) => p.includes("0027_"))!, "utf8");
    await db.pg.exec(sql);
    await db.pg.exec(sql);
    expect(await openTasks(a)).toEqual([{ title: "Segunda" }]);
    expect(await db.admin("select 1 from public.tasks where lead_id = $1", [a])).toHaveLength(1);
    expect(await db.admin("select 1 from public.tasks where lead_id = any($1::uuid[])", [[b, c]])).toHaveLength(0);
  });
});
