import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { nameKey } from "@/lib/research/dedupe";
import { TestDb, anon, anonWithToken, as, setSchedulerToken, tryCommit, UUID_A } from "./helpers";
import { OTHER_TOKEN, TOKEN } from "./scheduler-seed";
import { beginQualifierTick, qclock, seedQualifierLead } from "./qualifier-seed";

// Migration 0014 part 2: the Qualificador path (no session, token-gated, one lead per claim). PGlite, real migrations.

const ZERO = "00000000-0000-4000-8000-000000000000";
const ENTRY_POINTS: [string, unknown[]][] = [
  ["select public.qualifier_begin_tick()", []],
  ["select public.qualifier_finish_tick($1,'{}'::jsonb,null)", [ZERO]],
  ["select public.qualifier_claim_next($1)", [ZERO]],
  ["select public.qualifier_merge($1,$2)", [ZERO, ZERO]],
  ["select public.qualifier_add_fields($1,$2,'[]'::jsonb)", [ZERO, ZERO]],
  ["select public.qualifier_refute($1,$2,'{}'::uuid[])", [ZERO, ZERO]],
  ["select public.qualifier_step_done($1,$2,'p1','ok','p2',null)", [ZERO, ZERO]],
  ["select public.qualifier_release($1,$2)", [ZERO, ZERO]],
  ["select public.qualifier_pause($1,$2,'daily_cap')", [ZERO, ZERO]],
  ["select public.qualifier_reserve_ai_call($1,$2,'qualify_light','m','v',0.1,10,25)", [ZERO, ZERO]],
  ["select public.qualifier_settle_ai_call($1,$2,$3,'ok',0,0,0,0,0,0,0,null,0)", [ZERO, ZERO, ZERO]],
];

let db: TestDb;
const code = (e: Error | undefined) => (e as (Error & { code?: string }) | undefined)?.code;
const rpc = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(qclock, sql, params);
const tryRpc = (sql: string, params: unknown[] = []) => tryCommit<{ id: string }>(db, qclock, sql, params);
const finish = (tick: string) => rpc("select public.qualifier_finish_tick($1,'{}'::jsonb,null)", [tick]);
/** Lock a lead for a tick without the claim order (for the write-path tests). */
const hold = (tick: string, lead: string) =>
  db.admin("update public.qualifier_queue set locked_by = $1, locked_until = now() + interval '180 seconds' where lead_id = $2", [tick, lead]);
type Snap = { lead_id: string; workspace_id: string; next_step: string; level: number; manual: boolean; fields: { field: string }[]; best: unknown; settings: Record<string, number>; company_profile: unknown };
const claim = async (tick: string) => (await rpc<{ r: Snap | null }>("select public.qualifier_claim_next($1) as r", [tick]))[0].r;
const addLead = async (ws: string) =>
  (await db.admin<{ id: string }>("insert into public.leads (workspace_id, origin_kind) values ($1,'import') returning id", [ws]))[0].id;
const reserve = (tick: string, lead: string, usd = 0.1, task = "qualify_light") =>
  tryRpc("select public.qualifier_reserve_ai_call($1,$2,$3,'claude-haiku-5-5','v1',$4,10,25) as id", [tick, lead, task, usd]);

beforeAll(async () => {
  db = await TestDb.create();
  await setSchedulerToken(db, TOKEN);
});
// Each test starts with an empty queue, every Qualificador on and no open tick.
afterEach(async () => {
  await db.admin("update public.qualifier_ticks set finished_at = now() where finished_at is null");
  await db.admin("delete from public.leads");
  await db.admin("update public.qualifiers set status = 'on', paused_reason = null, paused_until = null, daily_cap_usd = 5, lead_cap_usd = 0.5");
  await db.admin("delete from public.workspace_settings");
});
afterAll(async () => {
  await db.pg.close();
});

describe("0014 qualifier path", () => {
  test("every qualifier_* entry point refuses no token, a wrong token and the clock off (42501); users cannot execute them", async () => {
    await setSchedulerToken(db, TOKEN);
    for (const actor of [anon, anonWithToken(OTHER_TOKEN), anonWithToken("not-hex"), anonWithToken(TOKEN.toUpperCase())]) {
      for (const [sql, params] of ENTRY_POINTS) expect(code((await db.try(actor, sql, params)).error), sql).toBe("42501");
    }
    for (const [sql, params] of ENTRY_POINTS) {
      expect((await db.try(as(UUID_A), sql, params)).error?.message, sql).toMatch(/permission denied/);
    }
    await setSchedulerToken(db, null);
    for (const [sql, params] of ENTRY_POINTS) expect(code((await db.try(qclock, sql, params)).error), sql).toBe("42501");
    await setSchedulerToken(db, TOKEN);
    expect(code((await db.try(qclock, "select public.qualifier_claim_next($1)", [ZERO])).error)).toBe("55000");
    expect(await db.admin("select 1 from public.qualifier_ticks")).toHaveLength(0);
  });

  test("one qualifier tick at a time; an expired lease frees it", async () => {
    const t1 = await beginQualifierTick(db);
    const busy = (await rpc<{ r: { tick_id: string | null; busy: boolean } }>("select public.qualifier_begin_tick() as r"))[0].r;
    expect(busy).toEqual({ tick_id: null, busy: true });
    await finish(t1);
    const t2 = await beginQualifierTick(db);
    await db.admin("update public.qualifier_ticks set lease_until = now() - interval '1 second' where id = $1", [t2]);
    const t3 = await beginQualifierTick(db);
    expect(t3).not.toBe(t2);
    const [old] = await db.admin<{ error: string; finished_at: string | null }>("select error, finished_at from public.qualifier_ticks where id = $1", [t2]);
    expect(old.error).toBe("lease_expired");
    expect(old.finished_at).not.toBeNull();
    // the heartbeat keeps only small numbers and a short code; a finished tick takes no more work
    await rpc("select public.qualifier_finish_tick($1,$2::jsonb,'ai_cap')", [t3, JSON.stringify({ leads: 3, leak: "secret", "bad key!": 1 })]);
    const [done] = await db.admin<{ counts: Record<string, number>; error: string }>("select counts, error from public.qualifier_ticks where id = $1", [t3]);
    expect(done.counts).toEqual({ leads: 3 });
    expect(code((await tryRpc("select public.qualifier_claim_next($1)", [t3])).error)).toBe("55000");
    expect(code((await tryRpc("select public.qualifier_finish_tick($1,'{}'::jsonb,null)", [t3])).error)).toBe("55000");
  });

  test("K-4 claim order: manual first, then Caçador or profile, then higher level, then oldest; paused workspaces are skipped", async () => {
    const { ws, lead: oldest } = await seedQualifierLead(db, { fields: [{ field: "name", value: "Old Plain" }] });
    const lvl = await addLead(ws);
    const hunter = await addLead(ws);
    const profile = await addLead(ws);
    const manualNew = await addLead(ws);
    const manualOld = await addLead(ws);
    await db.admin("update public.qualifier_queue set enqueued_at = now() - interval '5 days' where lead_id = $1", [oldest]);
    await db.admin("update public.leads set level = 2 where id = $1", [lvl]);
    await db.admin("update public.qualifier_queue set priority_hunter = true where lead_id = $1", [hunter]);
    await db.admin("update public.qualifier_queue set profile_match = true, enqueued_at = now() - interval '1 hour' where lead_id = $1", [profile]);
    await db.admin("update public.qualifier_queue set manual_at = now() - interval '1 minute' where lead_id = $1", [manualNew]);
    await db.admin("update public.qualifier_queue set manual_at = now() - interval '2 minutes' where lead_id = $1", [manualOld]);
    // a paused workspace and a finished lead are never claimed
    const other = await seedQualifierLead(db, { origin: "agent" });
    await db.admin("update public.qualifiers set status = 'paused', paused_reason = 'user' where workspace_id = $1", [other.ws]);
    const fin = await addLead(ws);
    await db.admin("update public.qualifier_queue set next_step = 'done', done_reason = 'complete', manual_at = now() - interval '9 minutes' where lead_id = $1", [fin]);

    const tick = await beginQualifierTick(db);
    const order: string[] = [];
    for (let i = 0; i < 6; i++) order.push((await claim(tick))!.lead_id);
    expect(order.slice(0, 2)).toEqual([manualOld, manualNew]);
    // Caçador-born and profile-matching share a bucket: same level, so the older enqueue goes first
    expect(order.slice(2, 4)).toEqual([profile, hunter]);
    expect(order[4]).toBe(lvl);
    expect(order[5]).toBe(oldest);
    expect(await claim(tick)).toBeNull(); // everything else is locked, paused or done
    const [row] = await db.admin<{ locked_by: string }>("select locked_by from public.qualifier_queue where lead_id = $1", [oldest]);
    expect(row.locked_by).toBe(tick);
  });

  test("a claim returns the LeadSnapshot, locks 180 s, and an expired lock can be claimed again", async () => {
    const { ws, lead } = await seedQualifierLead(db, { fields: [{ field: "name", value: "Acme Builders" }, { field: "website", value: "https://acme.example" }] });
    const tick = await beginQualifierTick(db);
    const s = (await claim(tick))!;
    expect(s).toMatchObject({ lead_id: lead, workspace_id: ws, next_step: "p1", level: 0, manual: false, best: null, company_profile: null });
    expect(s.fields.map((f) => f.field).sort()).toEqual(["name", "website"]);
    expect(s.settings).toMatchObject({ daily_cap_usd: 5, lead_cap_usd: 0.5, spent_today: 0 });
    expect(s.settings.auto_deep).toBe(true);
    const [q] = await db.admin<{ secs: string }>("select extract(epoch from locked_until - now()) as secs from public.qualifier_queue where lead_id = $1", [lead]);
    expect(Number(q.secs)).toBeGreaterThan(170);
    expect(Number(q.secs)).toBeLessThanOrEqual(180);
    expect(await claim(tick)).toBeNull();
    await db.admin("update public.qualifier_queue set locked_until = now() - interval '1 second' where lead_id = $1", [lead]);
    expect((await claim(tick))!.lead_id).toBe(lead);
    // finishing the tick frees what it holds
    await finish(tick);
    expect((await db.admin<{ locked_by: string | null }>("select locked_by from public.qualifier_queue where lead_id = $1", [lead]))[0].locked_by).toBeNull();
  });

  test("a claimed lead belongs to its tick: no write without the claim, nor to another lead", async () => {
    const a = await seedQualifierLead(db);
    const b = await addLead(a.ws);
    const tick = await beginQualifierTick(db);
    const row = JSON.stringify([{ field: "phone", value: "(508) 555-0101", source: "site", source_ref: "https://acme.example/contact" }]);
    // nothing claimed yet
    expect(code((await tryRpc("select public.qualifier_add_fields($1,$2,$3::jsonb)", [tick, a.lead, row])).error)).toBe("55000");
    await hold(tick, a.lead);
    expect((await tryRpc("select public.qualifier_add_fields($1,$2,$3::jsonb) as id", [tick, a.lead, row])).error).toBeUndefined();
    // the other lead of the same workspace is not held by this tick
    for (const sql of [
      "select public.qualifier_add_fields($1,$2,$3::jsonb)",
      "select public.qualifier_merge($1,$2)",
      "select public.qualifier_release($1,$2)",
      "select public.qualifier_step_done($1,$2,'p1','ok','p2',null)",
    ]) {
      const r = await tryRpc(sql, sql.includes("add_fields") ? [tick, b, row] : [tick, b]);
      expect(code(r.error), sql).toBe("55000");
    }
    // another tick cannot write to a lead this tick holds; an unknown lead is refused outright
    await finish(tick);
    const t2 = await beginQualifierTick(db);
    expect(code((await tryRpc("select public.qualifier_merge($1,$2)", [t2, a.lead])).error)).toBe("55000");
    expect(code((await tryRpc("select public.qualifier_merge($1,$2)", [t2, ZERO])).error)).toBe("42501");
  });

  test("P1 merge copies linked candidates and adds unlinked matches as unverified, never overwriting", async () => {
    const { ws, owner, lead } = await seedQualifierLead(db, { fields: [{ field: "name", value: "Acme Builders" }, { field: "phone", value: "(508) 555-0101" }] });
    await db.admin("update public.lead_fields set key = $2 where lead_id = $1 and field = 'name'", [lead, nameKey("Acme Builders")]);
    const run = (await db.admin<{ id: string }>("insert into public.research_runs (workspace_id, title, request_text, region_text, rigor, created_by) values ($1,'t','p','Worcester, MA','careful',$2) returning id", [ws, owner]))[0].id;
    // unlinked: same name key, other values
    await db.admin(
      "insert into public.research_candidates (workspace_id, run_id, name, name_key, city, state, website, phone, public_email) values ($1,$2,'Acme Builders',$3,'Worcester','MA','https://acme.example','(508) 555-0199','info@acme.example')",
      [ws, run, nameKey("Acme Builders")],
    );
    // a candidate of another workspace with the same key is never touched
    const o = await seedQualifierLead(db);
    const orun = (await db.admin<{ id: string }>("insert into public.research_runs (workspace_id, title, request_text, region_text, rigor, created_by) values ($1,'t','p','x','careful',$2) returning id", [o.ws, o.owner]))[0].id;
    await db.admin("insert into public.research_candidates (workspace_id, run_id, name, name_key, phone) values ($1,$2,'Acme Builders',$3,'(508) 555-7777')", [o.ws, orun, nameKey("Acme Builders")]);

    const tick = await beginQualifierTick(db);
    await hold(tick, lead);
    const n = (await rpc<{ n: number }>("select public.qualifier_merge($1,$2) as n", [tick, lead]))[0].n;
    expect(n).toBeGreaterThanOrEqual(5);
    const fields = await db.admin<{ field: string; value: string; source: string; status: string }>(
      "select field, value, source, status from public.lead_fields where lead_id = $1 order by field, value", [lead]);
    // the imported phone is still there, the candidate's is another row, unverified
    expect(fields.filter((f) => f.field === "phone")).toEqual([
      { field: "phone", value: "(508) 555-0101", source: "import", status: "unverified" },
      { field: "phone", value: "(508) 555-0199", source: "research", status: "unverified" },
    ]);
    expect(fields.find((f) => f.field === "email")).toMatchObject({ value: "info@acme.example", source: "research", status: "unverified" });
    expect(fields.some((f) => f.value === "(508) 555-7777")).toBe(false);
    // a second merge adds nothing
    expect((await rpc<{ n: number }>("select public.qualifier_merge($1,$2) as n", [tick, lead]))[0].n).toBe(0);

    // linked: a verified candidate copies its values; merge re-copies what was lost
    const linked = (
      await db.admin<{ id: string; lead_id: string }>(
        "insert into public.research_candidates (workspace_id, run_id, name, name_key, city, state, website, phone, phone_source_url, verified_at) values ($1,$2,'Beta Homes',$3,'Boston','MA','https://beta.example','(617) 555-0100','https://beta.example/c', now()) returning id, lead_id",
        [ws, run, nameKey("Beta Homes")],
      )
    )[0];
    await db.admin("delete from public.lead_fields where lead_id = $1 and source = 'research'", [linked.lead_id]);
    await hold(tick, linked.lead_id);
    expect((await rpc<{ n: number }>("select public.qualifier_merge($1,$2) as n", [tick, linked.lead_id]))[0].n).toBeGreaterThanOrEqual(4);
    expect(
      (await db.admin<{ status: string }>("select status from public.lead_fields where lead_id = $1 and field = 'phone'", [linked.lead_id]))[0].status,
    ).toBe("confirmed");
  });

  test("add_fields accepts only site, places and ai values and known keys (22023 otherwise)", async () => {
    const { lead } = await seedQualifierLead(db);
    const tick = await beginQualifierTick(db);
    await hold(tick, lead);
    const add = (rows: unknown) => tryRpc("select public.qualifier_add_fields($1,$2,$3::jsonb) as n", [tick, lead, JSON.stringify(rows)]);
    const ok = { field: "email", value: "office@acme.example", source: "site", source_ref: "https://acme.example/contact", status: "confirmed", excerpt: "Write to office@acme.example", seen_at: "2026-11-14T10:00:00Z" };
    const r = await add([ok, { field: "company_type", value: "General contractor", source: "ai", source_ref: "https://acme.example" }]);
    expect(r.error).toBeUndefined();
    expect((r.rows![0] as unknown as { n: number }).n).toBe(2);
    expect((await add([ok])).rows![0]).toMatchObject({ n: 0 }); // same value, same source: nothing new
    for (const bad of [
      [{ ...ok, source: "import" }],
      [{ ...ok, source: "research" }],
      [{ ...ok, status: "refuted" }],
      [{ ...ok, field: "nickname" }],
      [{ ...ok, lead_id: lead }],
      [{ ...ok, workspace_id: ZERO }],
      [{ ...ok, value: "" }],
      [{ ...ok, excerpt: "x".repeat(301) }],
      { not: "an array" },
    ]) {
      expect(code((await add(bad)).error), JSON.stringify(bad).slice(0, 60)).toBe("22023");
    }
    // the stored row keeps the workspace of the lead, the key is computed by the table's trigger
    const [f] = await db.admin<{ workspace_id: string; key: string; status: string }>("select workspace_id, key, status from public.lead_fields where lead_id = $1 and field = 'email'", [lead]);
    expect(f).toMatchObject({ key: "office@acme.example", status: "confirmed" });
  });

  test("qualifier_refute marks only that lead's fields refuted", async () => {
    const a = await seedQualifierLead(db, { fields: [{ field: "website", value: "https://dead.example" }] });
    const b = await seedQualifierLead(db, { fields: [{ field: "website", value: "https://other.example" }] });
    const fa = (await db.admin<{ id: string }>("select id from public.lead_fields where lead_id = $1", [a.lead]))[0].id;
    const fb = (await db.admin<{ id: string }>("select id from public.lead_fields where lead_id = $1", [b.lead]))[0].id;
    const tick = await beginQualifierTick(db);
    await hold(tick, a.lead);
    await rpc("select public.qualifier_refute($1,$2,$3::uuid[])", [tick, a.lead, `{${fa},${fb}}`]);
    const st = async (id: string) => (await db.admin<{ status: string }>("select status from public.lead_fields where id = $1", [id]))[0].status;
    expect(await st(fa)).toBe("refuted");
    expect(await st(fb)).toBe("unverified");
  });

  test("J-1 caps: the Qualificador's daily cap and the lead cap stop reservations; spend is charged to the workspace creator and counted on the lead", async () => {
    const a = await seedQualifierLead(db);
    const b = await addLead(a.ws);
    const tick = await beginQualifierTick(db);
    await hold(tick, a.lead);
    await hold(tick, b);

    const ok = await reserve(tick, a.lead, 0.1);
    expect(ok.error).toBeUndefined();
    const id = ok.rows![0].id;
    const [row] = await db.admin<{ user_id: string; lead_id: string; task: string; status: string; run_id: string | null }>("select user_id, lead_id, task, status, run_id from public.ai_calls where id = $1", [id]);
    expect(row).toMatchObject({ user_id: a.owner, lead_id: a.lead, task: "qualify_light", status: "pending", run_id: null });
    // a task that is not the Qualificador's is refused
    expect(code((await reserve(tick, a.lead, 0.1, "research_verify")).error)).toBe("22023");
    // settling another lead's call is refused; its own lead settles and the cost lands on the lead's queue row
    const settle = (lead: string) => tryRpc("select public.qualifier_settle_ai_call($1,$2,$3,'ok',100,50,0,0,0,0,0.04,null,900)", [tick, lead, id]);
    expect(code((await settle(b)).error)).toBe("42501");
    expect((await settle(a.lead)).error).toBeUndefined();
    expect(Number((await db.admin<{ s: string }>("select spent_usd as s from public.qualifier_queue where lead_id = $1", [a.lead]))[0].s)).toBeCloseTo(0.04, 6);
    expect(Number((await db.admin<{ s: string }>("select spent_usd as s from public.qualifier_queue where lead_id = $1", [b]))[0].s)).toBe(0);
    expect(code((await settle(a.lead)).error)).toBe("42501"); // already settled

    // the Qualificador's own day
    await db.admin("update public.qualifiers set daily_cap_usd = 0.01 where workspace_id = $1", [a.ws]);
    expect((await reserve(tick, b, 0.1)).error?.message).toMatch(/ai_cap:qualifier_daily/);
    await db.admin("update public.qualifiers set daily_cap_usd = 5 where workspace_id = $1", [a.ws]);
    // the lead cap (pending reserves of the lead count too)
    await db.admin("update public.qualifier_queue set spent_usd = 0.45 where lead_id = $1", [b]);
    expect((await reserve(tick, b, 0.1)).error?.message).toMatch(/ai_cap:lead_cap/);
    await db.admin("update public.qualifier_queue set spent_usd = 0 where lead_id = $1", [b]);
    expect((await reserve(tick, b, 0.3)).error).toBeUndefined();
    expect((await reserve(tick, b, 0.3)).error?.message).toMatch(/ai_cap:lead_cap/);
    // the workspace cap below the Qualificador's
    await db.admin("update public.ai_calls set status = 'error', cost_usd = 0, settled_at = now() where lead_id = $1 and status = 'pending'", [b]);
    await db.admin("insert into public.workspace_settings (workspace_id, ai_daily_cap_usd) values ($1, 0.02) on conflict (workspace_id) do update set ai_daily_cap_usd = 0.02", [a.ws]);
    expect((await reserve(tick, b, 0.1)).error?.message).toMatch(/ai_cap:daily_cap/);
    await db.admin("delete from public.workspace_settings where workspace_id = $1", [a.ws]);
    // a creator without AI access: nothing is reserved
    await db.admin("delete from public.ai_access where user_id = $1", [a.owner]);
    expect((await reserve(tick, b, 0.1)).error?.message).toMatch(/ai_cap:no_access/);
    await db.admin("insert into public.ai_access (user_id) values ($1)", [a.owner]);
    // a paused Qualificador reserves nothing
    await db.admin("update public.qualifiers set status = 'paused', paused_reason = 'user' where workspace_id = $1", [a.ws]);
    expect(code((await reserve(tick, b, 0.1)).error)).toBe("55000");
  });

  test("step_done records the step, counts errors in a row and closes the lead with a reason", async () => {
    const { lead } = await seedQualifierLead(db);
    const tick = await beginQualifierTick(db);
    await hold(tick, lead);
    const done = (step: string, outcome: string, next: string, reason: string | null = null) =>
      tryRpc("select public.qualifier_step_done($1,$2,$3,$4,$5,$6)", [tick, lead, step, outcome, next, reason]);
    const q = async () => (await db.admin<{ next_step: string; done_reason: string | null; fail_step: string | null; fail_streak: number; notes: Record<string, string>; last_step_at: string | null; locked_by: string | null; manual_at: string | null; deep_requested: boolean }>("select next_step, done_reason, fail_step, fail_streak, notes, last_step_at, locked_by, manual_at, deep_requested from public.qualifier_queue where lead_id = $1", [lead]))[0];
    expect((await done("p1", "ok", "p2")).error).toBeUndefined();
    expect(await q()).toMatchObject({ next_step: "p2", fail_streak: 0, notes: { p1: "ok" }, locked_by: tick });
    expect((await q()).last_step_at).not.toBeNull();
    await done("p2", "error", "p2");
    await done("p2", "error", "p2");
    expect(await q()).toMatchObject({ fail_step: "p2", fail_streak: 2, notes: { p1: "ok", p2: "error" } });
    await done("p3", "places_off", "p4");
    expect(await q()).toMatchObject({ fail_step: null, fail_streak: 0 });
    expect((await db.admin("select step, outcome from public.qualifier_step_log where lead_id = $1 order by at, step", [lead])).length).toBe(4);
    // closing needs a reason from the list, and unknown steps or next steps are refused
    expect(code((await done("p4", "ok", "done")).error)).toBe("22023");
    expect(code((await done("p4", "ok", "done", "whatever")).error)).toBe("22023");
    expect(code((await done("p9", "ok", "p5")).error)).toBe("22023");
    expect(code((await done("p4", "ok", "p7")).error)).toBe("22023");
    await db.admin("update public.qualifier_queue set manual_at = now(), deep_requested = true where lead_id = $1", [lead]);
    expect((await done("p5", "ok", "done", "complete")).error).toBeUndefined();
    expect(await q()).toMatchObject({ next_step: "done", done_reason: "complete", locked_by: null, manual_at: null, deep_requested: false });
    // a finished lead takes no more writes
    expect(code((await done("p1", "ok", "p2")).error)).toBe("55000");
  });

  test("m-6 values imported while the lead was claimed re-queue it instead of closing it", async () => {
    const { ws, lead } = await seedQualifierLead(db);
    const tick = await beginQualifierTick(db);
    expect((await claim(tick))!.lead_id).toBe(lead);
    await db.admin("insert into public.lead_fields (workspace_id, lead_id, field, value, source, source_ref) values ($1,$2,'phone','5085550188','import','late-list')", [ws, lead]);
    expect((await tryRpc("select public.qualifier_step_done($1,$2,'p5','ok','done','complete')", [tick, lead])).error).toBeUndefined();
    expect((await db.admin<{ next_step: string; done_reason: string | null; locked_by: string | null }>("select next_step, done_reason, locked_by from public.qualifier_queue where lead_id = $1", [lead]))[0]).toEqual({ next_step: "p1", done_reason: null, locked_by: null });
  });

  test("qualifier_pause sets the reason; a daily-cap pause ends at the next New York midnight", async () => {
    const a = await seedQualifierLead(db);
    const b = await seedQualifierLead(db);
    const tick = await beginQualifierTick(db);
    const s = (await claim(tick))!;
    const ws = s.workspace_id;
    // only a workspace the tick holds a lead of, and only listed reasons
    const other = ws === a.ws ? b.ws : a.ws;
    expect(code((await tryRpc("select public.qualifier_pause($1,$2,'daily_cap')", [tick, other])).error)).toBe("42501");
    expect(code((await tryRpc("select public.qualifier_pause($1,$2,'bored')", [tick, ws])).error)).toBe("22023");
    expect(code((await tryRpc("select public.qualifier_pause($1,$2,'user')", [tick, ws])).error)).toBe("22023");

    expect((await tryRpc("select public.qualifier_pause($1,$2,'daily_cap')", [tick, ws])).error).toBeUndefined();
    const [z] = await db.admin<{ status: string; paused_reason: string; ok: boolean; next_midnight: string }>(
      `select status, paused_reason,
              paused_until > now() and paused_until <= now() + interval '25 hours' and (paused_until at time zone 'America/New_York')::time = '00:00' as ok,
              paused_until as next_midnight
         from public.qualifiers where workspace_id = $1`, [ws]);
    expect(z).toMatchObject({ status: "paused", paused_reason: "daily_cap", ok: true });
    // its lock went back to the queue unchanged
    expect((await db.admin<{ next_step: string; locked_by: string | null }>("select next_step, locked_by from public.qualifier_queue where lead_id = $1", [s.lead_id]))[0]).toEqual({ next_step: "p1", locked_by: null });
    // the paused workspace is skipped; the other one still is claimed
    const n2 = (await claim(tick))!;
    expect(n2.workspace_id).toBe(other);
    // the pause holds until the midnight passes, then the next claim resumes it
    expect((await claim(tick))).toBeNull();
    await db.admin("update public.qualifiers set paused_until = now() - interval '1 second' where workspace_id = $1", [ws]);
    expect((await claim(tick))!.lead_id).toBe(s.lead_id);
    expect((await db.admin<{ status: string; paused_reason: string | null; paused_until: string | null }>("select status, paused_reason, paused_until from public.qualifiers where workspace_id = $1", [ws]))[0]).toEqual({ status: "on", paused_reason: null, paused_until: null });
    // a pause for any other reason is not lifted by the clock, and a user's pause is not overwritten
    await finish(tick);
    const t2 = await beginQualifierTick(db);
    const s2 = (await claim(t2))!;
    await tryRpc("select public.qualifier_pause($1,$2,'user_cap')", [t2, s2.workspace_id]);
    await db.admin("update public.qualifiers set paused_until = now() - interval '1 second' where workspace_id = $1", [s2.workspace_id]);
    expect((await claim(t2))?.workspace_id).not.toBe(s2.workspace_id);
    expect((await db.admin<{ status: string; paused_reason: string }>("select status, paused_reason from public.qualifiers where workspace_id = $1", [s2.workspace_id]))[0]).toEqual({ status: "paused", paused_reason: "user_cap" });
  });

  test("request_qualification puts leads first and asks for the deep check; the closer and other workspaces are refused", async () => {
    const a = await seedQualifierLead(db);
    const l2 = await addLead(a.ws);
    const l3 = await addLead(a.ws);
    const dead = await addLead(a.ws);
    const foreign = await seedQualifierLead(db);
    const closer = (await import("node:crypto")).randomUUID();
    await db.addUser(closer);
    await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'closer')", [a.ws, closer]);
    await db.admin("update public.qualifier_queue set next_step = 'done', done_reason = 'complete', fail_step = 'p2', fail_streak = 3 where lead_id = $1", [l3]);
    await db.admin("update public.qualifier_queue set next_step = 'done', done_reason = 'dead' where lead_id = $1", [dead]);

    const n = (await db.query<{ n: number }>(as(a.owner), "select public.request_qualification($1,$2::uuid[]) as n", [a.ws, `{${l3},${dead},${foreign.lead}}`]))[0].n;
    expect(n).toBe(1); // l3 only: dead and foreign leads are not touched
    const q = async (id: string) => (await db.admin<{ next_step: string; done_reason: string | null; manual_at: string | null; deep_requested: boolean; fail_streak: number }>("select next_step, done_reason, manual_at, deep_requested, fail_streak from public.qualifier_queue where lead_id = $1", [id]))[0];
    expect(await q(l3)).toMatchObject({ next_step: "p1", done_reason: null, deep_requested: true, fail_streak: 0 });
    expect((await q(l3)).manual_at).not.toBeNull();
    expect(await q(dead)).toMatchObject({ next_step: "done", done_reason: "dead", deep_requested: false, manual_at: null });
    expect(await q(foreign.lead)).toMatchObject({ manual_at: null, deep_requested: false });
    await db.query(as(a.owner), "select public.request_qualification($1,$2::uuid[])", [a.ws, `{${l2}}`]);
    // the requested leads are claimed before the rest, oldest request first
    const tick = await beginQualifierTick(db);
    expect([(await claim(tick))!.lead_id, (await claim(tick))!.lead_id]).toEqual([l3, l2]);
    expect((await claim(tick))!.manual).toBe(false);

    // refused: the closer, a workspace the caller is not in, anon, too many ids
    expect((await db.try(as(closer), "select public.request_qualification($1,$2::uuid[])", [a.ws, `{${l2}}`])).error?.message).toMatch(/not allowed/);
    expect(code((await db.try(as(foreign.owner), "select public.request_qualification($1,$2::uuid[])", [a.ws, `{${l2}}`])).error)).toBe("42501");
    expect((await db.try(anon, "select public.request_qualification($1,$2::uuid[])", [a.ws, `{${l2}}`])).error?.message).toMatch(/permission denied/);
    const many = `{${Array.from({ length: 501 }, () => ZERO).join(",")}}`;
    expect(code((await db.try(as(a.owner), "select public.request_qualification($1,$2::uuid[])", [a.ws, many])).error)).toBe("22023");
  });
});
