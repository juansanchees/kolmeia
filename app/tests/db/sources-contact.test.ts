import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { TestDb, anon, anonWithToken, as, setSchedulerToken, tryCommit } from "./helpers";
import { OTHER_TOKEN, TOKEN } from "./scheduler-seed";
import { beginQualifierTick, qclock } from "./qualifier-seed";
import { clock } from "./hunter-seed";
import { seedSources } from "./sources-seed";

// Migration 0016: the contact scraper (P2b). The Qualificador asks (token path, one lead per claim), the sources clock
// starts the run and stores what comes back. Fictional data only. PGlite, real migrations.

const ZERO = "00000000-0000-4000-8000-000000000000";
const ENTRY_POINTS: [string, unknown[]][] = [
  ["select public.qualifier_request_contacts($1,$2,'https://a.example.com/')", [ZERO, ZERO]],
  ["select public.source_contact_leads($1,$2)", [ZERO, ZERO]],
  ["select public.source_add_contacts($1,$2,'[]'::jsonb,0,0)", [ZERO, ZERO]],
];

let db: TestDb;
const code = (e: Error | undefined) => (e as (Error & { code?: string }) | undefined)?.code;
beforeAll(async () => {
  db = await TestDb.create();
  await setSchedulerToken(db, TOKEN);
});
afterEach(async () => {
  await db.admin("update public.qualifier_ticks set finished_at = now() where finished_at is null");
  await db.admin("update public.source_ticks set finished_at = now() where finished_at is null");
  await db.admin("delete from public.source_runs");
  await db.admin("delete from public.leads");
});
afterAll(async () => {
  await db.pg.close();
});

const addLead = async (ws: string) => (await db.admin<{ id: string }>("insert into public.leads (workspace_id, origin_kind) values ($1,'import') returning id", [ws]))[0].id;
const hold = (tick: string, lead: string) =>
  db.admin("update public.qualifier_queue set locked_by = $1, locked_until = now() + interval '180 seconds' where lead_id = $2", [tick, lead]);
const ask = (tick: string, lead: string, url = "https://acme.example.com/") =>
  db.query<{ r: boolean }>(qclock, "select public.qualifier_request_contacts($1,$2,$3) as r", [tick, lead, url]).then((x) => x[0].r);
const sourceTick = async () => {
  await setSchedulerToken(db, TOKEN);
  return (await db.query<{ r: { tick_id: string } }>(clock, "select public.source_begin_tick() as r"))[0].r.tick_id;
};
const runs = () =>
  db.admin<{ id: string; kind: string; status: string; reserve_usd: string; cost_usd: string | null; n: number; label: string }>(
    "select r.id, r.kind, r.status, r.reserve_usd, r.cost_usd, query->>'label' as label, (select count(*)::int from public.source_run_leads l where l.run_id = r.id) as n from public.source_runs r where r.kind = 'contact' order by r.created_at, r.id");

describe("0016 contact scraper", () => {
  test("every entry point refuses no token and a wrong token (42501); users cannot execute them", async () => {
    await setSchedulerToken(db, TOKEN);
    for (const actor of [anon, anonWithToken(OTHER_TOKEN)]) {
      for (const [sql, params] of ENTRY_POINTS) expect(code((await db.try(actor, sql, params)).error), sql).toBe("42501");
    }
    const { owner } = await seedSources(db);
    for (const [sql, params] of ENTRY_POINTS) expect((await db.try(as(owner), sql, params)).error?.message, sql).toMatch(/permission denied/);
    // the token alone is not enough: an open tick is needed, and a lead the tick holds
    expect(code((await db.try(qclock, ENTRY_POINTS[0][0], [ZERO, ZERO])).error)).toBe("55000");
    expect(code((await db.try(clock, ENTRY_POINTS[2][0], [ZERO, ZERO])).error)).toBe("55000");
  });

  test("a lead is not asked for without an Apify connection or past the day's cap; a bad URL is refused", async () => {
    const a = await seedSources(db);
    await db.admin("delete from public.source_connections where workspace_id = $1 and provider = 'apify'", [a.ws]);
    const l1 = await addLead(a.ws);
    const tick = await beginQualifierTick(db);
    await hold(tick, l1);
    expect(await ask(tick, l1)).toBe(false);
    expect(await runs()).toHaveLength(0);
    await db.admin("update public.qualifier_ticks set finished_at = now()");

    const b = await seedSources(db, { apifyCap: 0.5 });
    await db.admin("insert into public.source_runs (workspace_id, provider, kind, max_results, reserve_usd, status, cost_usd) values ($1,'apify','maps',10,0.5,'imported',0.3)", [b.ws]);
    const l2 = await addLead(b.ws);
    const t2 = await beginQualifierTick(db);
    await hold(t2, l2);
    expect(await ask(t2, l2)).toBe(false); // 0.30 spent + 0.50 reserve > 0.50
    expect((await tryCommit(db, qclock, "select public.qualifier_request_contacts($1,$2,'ftp://x.example.com')", [t2, l2])).error).toMatchObject({ code: "22023" });
    expect((await tryCommit(db, qclock, "select public.qualifier_request_contacts($1,$2,'https://a.example.com/ x')", [t2, l2])).error).toMatchObject({ code: "22023" });
    expect(await runs()).toHaveLength(0);
  });

  test("ten leads share one contact run and its 0.50 reserve; the eleventh opens a second", async () => {
    const { ws } = await seedSources(db, { apifyCap: 5 });
    const tick = await beginQualifierTick(db);
    const leads: string[] = [];
    for (let i = 0; i < 11; i++) {
      const l = await addLead(ws);
      leads.push(l);
      await hold(tick, l);
      expect(await ask(tick, l, `https://site${i}.example.com/`)).toBe(true);
    }
    const r = await runs();
    expect(r.map((x) => [x.kind, x.status, Number(x.reserve_usd), x.n, x.label])).toEqual([
      ["contact", "queued", 0.5, 10, "Contatos"],
      ["contact", "queued", 0.5, 1, "Contatos"],
    ]);
    // asking again for a lead already in an open run changes nothing
    expect(await ask(tick, leads[0], `https://site0.example.com/`)).toBe(true);
    expect((await runs()).map((x) => x.n)).toEqual([10, 1]);
    // the day's Apify spend counts both reserves
    const [s] = await db.admin<{ v: string }>("select public.source_spent_today($1) as v", [ws]);
    expect(Number(s.v)).toBeCloseTo(1.0, 6);
    expect((await db.admin<{ start_url: string }>("select start_url from public.source_run_leads where lead_id = $1", [leads[3]]))[0].start_url).toBe("https://site3.example.com/");
  });

  test("a claimed run is closed to new leads; a lead answered in the last 30 days is not asked again, a failed one is", async () => {
    const { ws } = await seedSources(db, { apifyCap: 5 });
    const tick = await beginQualifierTick(db);
    const a = await addLead(ws);
    const b = await addLead(ws);
    await hold(tick, a);
    await hold(tick, b);
    expect(await ask(tick, a)).toBe(true);
    await db.admin("update public.source_runs set start_claimed_at = now() where kind = 'contact'");
    expect(await ask(tick, b)).toBe(true);
    expect((await runs()).map((x) => x.n)).toEqual([1, 1]);
    await db.admin("update public.source_runs set status = 'imported' where id = (select run_id from public.source_run_leads where lead_id = $1)", [a]);
    expect(await ask(tick, a)).toBe(false);
    await db.admin("update public.source_runs set status = 'failed' where id = (select run_id from public.source_run_leads where lead_id = $1)", [a]);
    expect(await ask(tick, a)).toBe(true);
  });

  test("p2b is a step: the queue, the log and step_done take it", async () => {
    const { ws } = await seedSources(db);
    const lead = await addLead(ws);
    const tick = await beginQualifierTick(db);
    await hold(tick, lead);
    const done = (step: string, outcome: string, next: string) =>
      tryCommit(db, qclock, "select public.qualifier_step_done($1,$2,$3,$4,$5,null)", [tick, lead, step, outcome, next]);
    expect((await done("p2", "ok", "p2b")).error).toBeUndefined();
    expect((await db.admin<{ next_step: string }>("select next_step from public.qualifier_queue where lead_id = $1", [lead]))[0].next_step).toBe("p2b");
    expect((await done("p2b", "queued", "p3")).error).toBeUndefined();
    expect((await db.admin("select 1 from public.qualifier_step_log where lead_id = $1 and step = 'p2b'", [lead])).length).toBe(1);
    expect(code((await done("p2c", "ok", "p3")).error)).toBe("22023");
  });

  test("contact e-mails land as apify_contact with the page URL and re-queue the lead", async () => {
    const { ws } = await seedSources(db, { apifyCap: 5 });
    const a = await addLead(ws);
    const b = await addLead(ws);
    const c = await addLead(ws);
    const tick = await beginQualifierTick(db);
    for (const l of [a, b, c]) {
      await hold(tick, l);
      await ask(tick, l, `https://${l.slice(0, 8)}.example.com/`);
    }
    await db.admin("update public.qualifier_ticks set finished_at = now()");
    const [run] = await runs();
    // a and b are finished (b is dead); c is still in the queue
    await db.admin("update public.qualifier_queue set next_step = 'done', done_reason = 'complete', locked_by = null, locked_until = null where lead_id = $1", [a]);
    await db.admin("update public.qualifier_queue set next_step = 'done', done_reason = 'dead', locked_by = null, locked_until = null where lead_id = $1", [b]);
    const st = await sourceTick();
    await db.query(clock, "select public.source_mark_started($1,$2,'runABC123','dsXYZ789')", [st, run.id]);
    const leadsOf = (await db.query<{ r: { lead_id: string; start_url: string }[] }>(clock, "select public.source_contact_leads($1,$2) as r", [st, run.id]))[0].r;
    expect(leadsOf.map((x) => x.lead_id).sort()).toEqual([a, b, c].sort());
    const rows = [
      { lead_id: a, value: "Info@Acme.example.com", url: "https://acme.example.com/contact" },
      { lead_id: b, value: "b@acme.example.com", url: "https://acme.example.com/b" },
    ];
    const n = (await db.query<{ n: number }>(clock, "select public.source_add_contacts($1,$2,$3::jsonb,5,0.12) as n", [st, run.id, JSON.stringify(rows)]))[0].n;
    expect(n).toBe(2);
    const f = await db.admin<{ value: string; source: string; status: string; source_ref: string }>("select value, source, status, source_ref from public.lead_fields where lead_id = $1 and field = 'email'", [a]);
    expect(f).toEqual([{ value: "info@acme.example.com", source: "apify_contact", status: "confirmed", source_ref: "https://acme.example.com/contact" }]);
    const q = await db.admin<{ lead_id: string; next_step: string; done_reason: string | null }>("select lead_id, next_step, done_reason from public.qualifier_queue where lead_id = any($1::uuid[])", [[a, b]]);
    expect(q.find((x) => x.lead_id === a)).toMatchObject({ next_step: "p1", done_reason: null }); // re-queued (K-4)
    expect(q.find((x) => x.lead_id === b)).toMatchObject({ next_step: "done", done_reason: "dead" }); // dead stays dead
    const [after] = await runs();
    expect([after.status, Number(after.cost_usd)]).toEqual(["imported", 0.12]);
    // once: a second call, or one for a lead of another run, is refused
    expect(code((await tryCommit(db, clock, "select public.source_add_contacts($1,$2,'[]'::jsonb,0,0)", [st, run.id])).error)).toBe("22023");
  });

  test("source_add_contacts refuses rows of other leads, bad e-mails and URLs, extra keys, other kinds; nothing is stored", async () => {
    const { ws } = await seedSources(db, { apifyCap: 5 });
    const a = await addLead(ws);
    const stranger = await addLead(ws);
    const tick = await beginQualifierTick(db);
    await hold(tick, a);
    await ask(tick, a);
    await db.admin("update public.qualifier_ticks set finished_at = now()");
    const [run] = await runs();
    const st = await sourceTick();
    await db.query(clock, "select public.source_mark_started($1,$2,'runABC123','dsXYZ789')", [st, run.id]);
    const bad = [
      [{ lead_id: stranger, value: "x@acme.example.com", url: "https://acme.example.com/" }],
      [{ lead_id: a, value: "not-an-email", url: "https://acme.example.com/" }],
      [{ lead_id: a, value: "x@acme.example.com", url: "javascript:alert(1)" }],
      [{ lead_id: a, value: "x@acme.example.com", url: "https://acme.example.com/", status: "confirmed" }],
      [{ lead_id: "nope", value: "x@acme.example.com", url: "https://acme.example.com/" }],
    ];
    for (const rows of bad) {
      expect(code((await tryCommit(db, clock, "select public.source_add_contacts($1,$2,$3::jsonb,1,0.1)", [st, run.id, JSON.stringify(rows)])).error), JSON.stringify(rows)).toBe("22023");
    }
    expect(await db.admin("select 1 from public.lead_fields where source = 'apify_contact'")).toHaveLength(0);
    expect((await runs())[0].status).toBe("running");
    // a Maps run is not a contact run
    const maps = (await db.admin<{ id: string }>("insert into public.source_runs (workspace_id, provider, kind, max_results, reserve_usd, status) values ($1,'apify','maps',10,0.5,'running') returning id", [ws]))[0].id;
    expect(code((await tryCommit(db, clock, "select public.source_add_contacts($1,$2,'[]'::jsonb,0,0)", [st, maps])).error)).toBe("22023");
    expect(code((await tryCommit(db, clock, "select public.source_import($1,$2,'[]'::jsonb,0,0,0)", [st, run.id])).error)).toBe("22023");
    // a contact run needs its Apify ids to start
    const q = await db.admin<{ id: string }>("select id from public.source_runs where kind = 'contact'");
    expect(q).toHaveLength(1);
    await db.admin("update public.source_runs set status = 'queued' where id = $1", [run.id]);
    expect(code((await tryCommit(db, clock, "select public.source_mark_started($1,$2,'','')", [st, run.id])).error)).toBe("22023");
  });

  test("senders read their workspace's run leads; closers and strangers see none", async () => {
    const a = await seedSources(db, { apifyCap: 5 });
    const other = await seedSources(db);
    const lead = await addLead(a.ws);
    const tick = await beginQualifierTick(db);
    await hold(tick, lead);
    await ask(tick, lead);
    const count = (who: string) => db.query<{ n: number }>(as(who), "select count(*)::int as n from public.source_run_leads").then((x) => x[0].n);
    expect(await count(a.owner)).toBe(1);
    expect(await count(a.sdr)).toBe(1);
    expect(await count(a.closer)).toBe(0);
    expect(await count(other.owner)).toBe(0);
    expect((await db.try(as(a.owner), "insert into public.source_run_leads (run_id, lead_id, start_url) values ($1,$1,'https://x.example.com/')", [ZERO])).error?.message).toMatch(/permission denied/);
  });
});
