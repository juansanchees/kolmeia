import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { TestDb, anon, anonWithToken, as, setSchedulerToken, tryCommit } from "./helpers";
import { OTHER_TOKEN, TOKEN } from "./scheduler-seed";
import { beginTick, clock, seedHunter } from "./hunter-seed";
import { MAPS_QUERY, SOURCE_CIPHER, seedSources } from "./sources-seed";
import { row } from "./lists-seed";
import { pgRpc } from "../engine/pg-rpc";

// Migration 0013 part 2: the token-gated source_* tick path (no session, anon + scheduler token). PGlite, real migrations.

const ZERO = "00000000-0000-4000-8000-000000000000";
const ENTRY_POINTS: [string, unknown[]][] = [
  ["select public.source_begin_tick()", []],
  ["select public.source_finish_tick($1,'{}'::jsonb,null)", [ZERO]],
  ["select public.source_enqueue_agent_runs($1)", [ZERO]],
  ["select public.source_next_work($1)", [ZERO]],
  ["select public.source_mark_started($1,$2,'x','y')", [ZERO, ZERO]],
  ["select public.source_mark_failed($1,$2,'x',0)", [ZERO, ZERO]],
  ["select public.source_import($1,$2,'[]'::jsonb,0,0,0)", [ZERO, ZERO]],
];

let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create();
});
beforeEach(async () => {
  await db.admin("update public.source_ticks set finished_at = now() where finished_at is null");
  await db.admin("update public.hunter_ticks set finished_at = now() where finished_at is null");
});
afterAll(async () => {
  await db.pg.close();
});

const code = (e: unknown) => (e as { code?: string }).code;
const rpc = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(clock, sql, params);
const tick = async (): Promise<string> => {
  await setSchedulerToken(db, TOKEN);
  const r = (await rpc<{ r: { tick_id: string | null; busy: boolean } }>("select public.source_begin_tick() as r"))[0].r;
  if (r.busy || !r.tick_id) throw new Error("another source tick is open");
  return r.tick_id;
};
const endTick = (t: string) => rpc("select public.source_finish_tick($1,'{}'::jsonb,null)", [t]);
const enqueue = async (owner: string, ws: string, kind = "maps", query: unknown = MAPS_QUERY, max = 50) =>
  (await db.query<{ id: string }>(as(owner), "select public.enqueue_source_run($1,$2,$3::jsonb,$4) as id", [ws, kind, JSON.stringify(query), max]))[0].id;
const runRow = async (id: string) =>
  (await db.admin<{ status: string; error: string | null; cost_usd: string | null; import_id: string | null; found: number | null; dropped: number | null; external_run_id: string | null }>(
    "select status, error, cost_usd, import_id, found, dropped, external_run_id from public.source_runs where id = $1", [id]))[0];
type Work = { start: { id: string; ciphertext: string | null; label: string; provider: string }[]; poll: { id: string; ciphertext: string | null }[] };
const nextWork = async (t: string) => (await rpc<{ r: Work }>("select public.source_next_work($1) as r", [t]))[0].r;

describe("0013 source tick path", () => {
  test("every source_* entry point refuses no token and a wrong token (42501); users cannot execute them", async () => {
    const { owner } = await seedSources(db);
    for (const [sql, params] of ENTRY_POINTS) {
      expect(code((await db.try(anon, sql, params)).error), sql).toBe("42501");
      expect(code((await db.try(anonWithToken(OTHER_TOKEN), sql, params)).error), sql).toBe("42501");
      const r = await db.try(as(owner), sql, params);
      expect(r.error?.message, sql).toMatch(/permission denied/);
    }
    // the token alone is not enough for a call that needs an open tick
    await setSchedulerToken(db, TOKEN);
    const r = await db.try(clock, "select public.source_next_work($1)", [ZERO]);
    expect(code(r.error)).toBe("55000");
    // pgRpc accepts the source_* family
    const t = await tick();
    expect(await pgRpc(db, TOKEN)("source_next_work", { p_tick: t })).toEqual({ start: [], poll: [] });
    await endTick(t);
  });

  test("one source tick at a time; an expired lease frees it", async () => {
    const a = await tick();
    await setSchedulerToken(db, TOKEN);
    const busy = (await rpc<{ r: { tick_id: string | null; busy: boolean } }>("select public.source_begin_tick() as r"))[0].r;
    expect(busy).toEqual({ tick_id: null, busy: true });
    await db.admin("update public.source_ticks set lease_until = now() - interval '1 second' where id = $1", [a]);
    const b = await tick();
    expect(b).not.toBe(a);
    expect((await db.admin<{ error: string }>("select error from public.source_ticks where id = $1", [a]))[0].error).toBe("lease_expired");
    // a closed tick takes no more calls
    await endTick(b);
    expect(code((await db.try(clock, "select public.source_next_work($1)", [b])).error)).toBe("55000");
    expect(code((await db.try(clock, "select public.source_finish_tick($1,'{}'::jsonb,null)", [b])).error)).toBe("55000");
  });

  test("agent runs enqueue one maps and one apollo search each, once", async () => {
    const owner = randomUUID();
    const { ws, agent } = await seedHunter(db, { userId: owner });
    for (const p of ["apify", "apollo"]) await db.query(as(owner), "select public.set_source_connection($1,$2,$3,'AB12',null)", [ws, p, SOURCE_CIPHER]);
    await db.query(as(owner), "select public.set_agent_source_settings($1,$2::jsonb)", [
      agent,
      JSON.stringify({ maps_on: true, maps_terms: ["general contractor", "builder"], maps_location: "Worcester, MA", maps_max: 40, apollo_on: true, apollo_locations: ["Massachusetts, US"], apollo_naics: ["236"], apollo_pages: 2 }),
    ]);
    // the hunter's tick creates its run; only a RUNNING run gets searches
    const ht = await beginTick(db);
    await rpc("select public.hunter_due_work($1)", [ht]);
    const run = (await db.admin<{ id: string }>("select id from public.research_runs where agent_id = $1", [agent]))[0].id;
    const t1 = await tick();
    expect((await rpc<{ n: number }>("select public.source_enqueue_agent_runs($1) as n", [t1]))[0].n).toBe(0);
    await db.admin("update public.research_runs set status = 'running' where id = $1", [run]);
    expect((await rpc<{ n: number }>("select public.source_enqueue_agent_runs($1) as n", [t1]))[0].n).toBe(2);
    const rows = await db.admin<{ kind: string; status: string; label: string; max_results: number; reserve_usd: string; agent_id: string; requested_by: string; q: Record<string, unknown> }>(
      "select kind, status, query->>'label' as label, max_results, reserve_usd, agent_id, requested_by, query as q from public.source_runs where research_run_id = $1 order by kind", [run]);
    expect(rows.map((r) => [r.kind, r.status, r.label, r.max_results, Number(r.reserve_usd), r.agent_id, r.requested_by])).toEqual([
      ["apollo", "queued", "Caçador de prédios", 50, 0, agent, owner],
      ["maps", "queued", "Caçador de prédios", 40, 0.5, agent, owner],
    ]);
    expect(rows[1].q).toMatchObject({ terms: ["general contractor", "builder"], location: "Worcester, MA" });
    expect(rows[0].q).toMatchObject({ locations: ["Massachusetts, US"], naics: ["236"], pages: 2 });
    expect((await rpc<{ n: number }>("select public.source_enqueue_agent_runs($1) as n", [t1]))[0].n).toBe(0);
    expect(Number((await db.admin<{ c: string }>("select count(*) as c from public.source_runs where research_run_id = $1", [run]))[0].c)).toBe(2);
    await endTick(t1);
    // an old run (created > 24 h ago) gets nothing
    await db.admin("delete from public.source_runs where research_run_id = $1", [run]);
    await db.admin("update public.research_runs set created_at = now() - interval '25 hours' where id = $1", [run]);
    const t2 = await tick();
    expect((await rpc<{ n: number }>("select public.source_enqueue_agent_runs($1) as n", [t2]))[0].n).toBe(0);
    await endTick(t2);
  });

  test("a Caçador search over the cap becomes a refused source_cap row; no connection means no row", async () => {
    const owner = randomUUID();
    const { ws, agent } = await seedHunter(db, { userId: owner });
    await db.query(as(owner), "select public.set_source_connection($1,'apify',$2,'AB12',0.5)", [ws, SOURCE_CIPHER]);
    await db.query(as(owner), "select public.set_agent_source_settings($1,$2::jsonb)", [
      agent, JSON.stringify({ maps_on: true, maps_terms: ["builder"], maps_location: "Boston, MA", maps_max: 50, apollo_on: true, apollo_locations: ["Massachusetts, US"] }),
    ]);
    const ht = await beginTick(db);
    await rpc("select public.hunter_due_work($1)", [ht]);
    const run = (await db.admin<{ id: string }>("select id from public.research_runs where agent_id = $1", [agent]))[0].id;
    await db.admin("update public.research_runs set status = 'running' where id = $1", [run]);
    await db.admin("insert into public.source_runs (workspace_id, provider, kind, max_results, reserve_usd, status, cost_usd) values ($1,'apify','maps',10,0.5,'succeeded',0.3)", [ws]);
    const t = await tick();
    // apollo is not connected -> skipped; maps over the 0.50 cap (0.30 spent + 0.50) -> refused
    expect((await rpc<{ n: number }>("select public.source_enqueue_agent_runs($1) as n", [t]))[0].n).toBe(1);
    const r = (await db.admin<{ kind: string; status: string; error: string; finished_at: string | null }>(
      "select kind, status, error, finished_at from public.source_runs where research_run_id = $1", [run]));
    expect(r).toHaveLength(1);
    expect([r[0].kind, r[0].status, r[0].error]).toEqual(["maps", "refused", "source_cap"]);
    expect(r[0].finished_at).not.toBeNull();
    await endTick(t);
  });

  test("next_work re-checks the cap and refuses runs of a disconnected workspace", async () => {
    const { ws, owner } = await seedSources(db, { apifyCap: 2 });
    const a = await enqueue(owner, ws);
    const b = await enqueue(owner, ws);
    const t = await tick();
    let w = await nextWork(t);
    expect(w.start.map((r) => r.id).sort()).toEqual([a, b].sort());
    expect(w.start[0].ciphertext).toBe(SOURCE_CIPHER);
    expect(w.start[0].label).toBe("GCs Worcester");
    expect(w.poll).toEqual([]);
    // the cap drops to the minimum while 2 x 0.50 are queued: the oldest still fits, the younger one is refused
    await db.admin("update public.source_runs set created_at = now() - interval '1 minute' where id = $1", [a]);
    await db.admin("update public.source_connections set daily_cap_usd = 0.50 where workspace_id = $1 and provider = 'apify'", [ws]);
    w = await nextWork(t);
    expect(w.start.map((r) => r.id)).toEqual([a]);
    expect(await runRow(b)).toMatchObject({ status: "refused", error: "source_cap" });
    expect((await runRow(a)).status).toBe("queued");
    await db.admin("update public.source_runs set status = 'refused' where id = $1", [a]);
    // a disconnected workspace: queued -> refused 'disconnected', running -> failed 'disconnected'
    await db.admin("update public.source_connections set daily_cap_usd = 5 where workspace_id = $1 and provider = 'apify'", [ws]);
    const c = await enqueue(owner, ws);
    const d = await enqueue(owner, ws);
    await rpc("select public.source_mark_started($1,$2,'ext1','ds1')", [t, d]);
    await db.admin("delete from public.source_connections where workspace_id = $1 and provider = 'apify'", [ws]);
    w = await nextWork(t);
    expect(w).toEqual({ start: [], poll: [] });
    expect(await runRow(c)).toMatchObject({ status: "refused", error: "disconnected" });
    expect(await runRow(d)).toMatchObject({ status: "failed", error: "disconnected" });
    await endTick(t);
  });

  test("next_work caps start at 3 (oldest first) and poll at 10 (oldest started first); ciphertext is per workspace and provider", async () => {
    const { ws, owner } = await seedSources(db, { apifyCap: 50, apolloCalls: 200 });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await enqueue(owner, ws));
    await db.admin("update public.source_runs set created_at = now() - (interval '1 minute' * (10 - $2::int)) where id = $1", [ids[0], 0]);
    const apolloRun = await enqueue(owner, ws, "apollo", { locations: ["Massachusetts, US"], pages: 1 }, 25);
    const t = await tick();
    let w = await nextWork(t);
    expect(w.start).toHaveLength(3);
    expect(w.start[0].id).toBe(ids[0]);
    for (let i = 0; i < 12; i++) {
      const id = await enqueue(owner, ws, "apollo", { pages: 1 }, 25);
      await rpc("select public.source_mark_started($1,$2,$3,'ds')", [t, id, `ext${i}`]);
      await db.admin("update public.source_runs set started_at = now() - (interval '1 minute' * $2::int) where id = $1", [id, 100 - i]);
    }
    w = await nextWork(t);
    expect(w.poll).toHaveLength(10);
    expect(w.poll.every((r) => r.ciphertext === SOURCE_CIPHER)).toBe(true);
    expect(apolloRun).toBeTruthy();
    await endTick(t);
  });

  test("mark_started moves queued to running only", async () => {
    const { ws, owner } = await seedSources(db);
    const id = await enqueue(owner, ws);
    const t = await tick();
    await rpc("select public.source_mark_started($1,$2,'ext1','ds1')", [t, id]);
    expect(await runRow(id)).toMatchObject({ status: "running", external_run_id: "ext1" });
    expect(code((await db.try(clock, "select public.source_mark_started($1,$2,'ext2','ds2')", [t, id])).error)).toBe("22023");
    await endTick(t);
  });

  test("mark_failed settles the cost and frees the reserve", async () => {
    const { ws, owner } = await seedSources(db, { apifyCap: 1 });
    const id = await enqueue(owner, ws);
    const spent = async () => Number((await db.admin<{ s: string }>("select public.source_spent_today($1) as s", [ws]))[0].s);
    expect(await spent()).toBe(0.5);
    const t = await tick();
    await rpc("select public.source_mark_started($1,$2,'ext1','ds1')", [t, id]);
    await rpc("select public.source_mark_failed($1,$2,'FAILED',0.12)", [t, id]);
    expect(await runRow(id)).toMatchObject({ status: "failed", error: "FAILED", cost_usd: "0.12" });
    expect(await spent()).toBe(0.12);
    // the freed reserve lets the next search in (0.12 + 0.50 + 0.50 > 1.00 would have refused with the reserve held)
    await enqueue(owner, ws);
    expect(await spent()).toBe(0.62);
    // a failed run is closed: it cannot fail or import again
    expect(code((await db.try(clock, "select public.source_mark_failed($1,$2,'x',0)", [t, id])).error)).toBe("22023");
    expect(code((await db.try(clock, "select public.source_import($1,$2,'[]'::jsonb,0,0,0)", [t, id])).error)).toBe("22023");
    // a never-started run costs nothing; a started run with an unknown cost keeps its reserve
    const q = await enqueue(owner, ws, "maps", MAPS_QUERY, 50).catch(() => null);
    expect(q).toBeNull(); // 0.62 + 0.50 > 1.00
    await endTick(t);
  });

  test("source_import creates a Maps import, dedupes against existing leads and cannot run twice", async () => {
    const { ws, owner } = await seedSources(db);
    const id = await enqueue(owner, ws);
    const t = await tick();
    await rpc("select public.source_mark_started($1,$2,'ext1','ds1')", [t, id]);
    const rows = [
      row(1, "Acme Builders", { website: "https://acme.example", phone: "508-555-0101", place_id: "ChIJ-1", company_type: "General contractor" } as never),
      row(2, "Beta Homes", { website: "https://beta.example" }),
    ];
    const imp = (p: unknown[], cost: number | null = 0.07) =>
      tryCommit<{ r: unknown }>(db, clock, "select public.source_import($1,$2,$3::jsonb,5,3,$4) as r", [t, id, JSON.stringify(p), cost]);
    // an existing lead with the same domain: the first row merges into it
    const first = await db.query<{ id: string }>(as(owner), "select public.create_lead_import($1,'a.csv',null,'Manual',$2::jsonb,false) as id", [ws, JSON.stringify({})]);
    await db.query(as(owner), "select public.import_lead_rows($1,$2::jsonb)", [first[0].id, JSON.stringify([row(1, "Acme Builders Inc", { website: "https://acme.example" })])]);
    await db.query(as(owner), "select public.finish_lead_import($1)", [first[0].id]);
    const ok = await imp(rows);
    expect(ok.error).toBeUndefined();
    expect(ok.rows![0]).toEqual({ r: { new: 1, merged: 1 } });
    const run = await runRow(id);
    expect(run).toMatchObject({ status: "imported", found: 5, dropped: 3, cost_usd: "0.07" });
    const im = (await db.admin<{ kind: string; file_name: string; list_name: string; status: string; created_by: string; new_count: number; merged_count: number }>(
      "select kind, file_name, list_name, status, created_by, new_count, merged_count from public.lead_imports where id = $1", [run.import_id]))[0];
    expect(im).toMatchObject({ kind: "apify_maps", file_name: "Google Maps (Apify)", status: "done", created_by: owner, new_count: 1, merged_count: 1 });
    expect(im.list_name).toMatch(/^Maps · GCs Worcester · \d\d\/\d\d$/);
    const srcs = await db.admin<{ source: string; c: string }>(
      "select source, count(*) c from public.lead_fields where source_ref = $1 group by source", [run.import_id]);
    expect(srcs).toEqual([{ source: "apify_maps", c: expect.anything() }]);
    expect(Number((await db.admin<{ c: string }>("select count(*) c from public.leads where workspace_id = $1", [ws]))[0].c)).toBe(2);
    // second call: not importable, nothing new
    expect(code((await imp(rows)).error)).toBe("22023");
    expect(Number((await db.admin<{ c: string }>("select count(*) c from public.lead_imports where workspace_id = $1 and kind = 'apify_maps'", [ws]))[0].c)).toBe(1);
    // undo of F3c-1 works on it
    const undo = await db.query<{ r: { deleted: number } }>(as(owner), "select public.undo_lead_import($1) as r", [run.import_id]);
    expect(undo[0].r.deleted).toBe(1);
    await endTick(t);
  });

  test("source_import: apollo kind, null cost = reserve, 600 rows in chunks, bad rows roll the whole thing back", async () => {
    const { ws, owner } = await seedSources(db);
    const t = await tick();
    // apollo run
    const ap = await enqueue(owner, ws, "apollo", { ...{ locations: ["Massachusetts, US"], pages: 1 }, label: "MA GCs" }, 25);
    await rpc("select public.source_mark_started($1,$2,'a1','')", [t, ap]);
    await rpc("select public.source_import($1,$2,$3::jsonb,1,0,null)", [t, ap, JSON.stringify([row(1, "Gamma Co", { website: "https://gamma.example" })])]);
    const ar = await runRow(ap);
    expect(ar).toMatchObject({ status: "imported", cost_usd: "0.00" });
    expect((await db.admin<{ kind: string; file_name: string }>("select kind, file_name from public.lead_imports where id = $1", [ar.import_id]))[0]).toEqual({ kind: "apollo", file_name: "Apollo" });
    // maps with null cost -> reserve; 600 rows -> two chunks
    const m = await enqueue(owner, ws);
    await rpc("select public.source_mark_started($1,$2,'m1','d1')", [t, m]);
    const many = Array.from({ length: 600 }, (_, i) => row(i + 1, `Firm ${i}`, { website: `https://firm${i}.example` }));
    const res = await rpc<{ r: { new: number; merged: number } }>("select public.source_import($1,$2,$3::jsonb,600,0,null) as r", [t, m, JSON.stringify(many)]);
    expect(res[0].r).toEqual({ new: 600, merged: 0 });
    expect(await runRow(m)).toMatchObject({ status: "imported", cost_usd: "0.50" });
    // a hostile row aborts the call and leaves the run running, no import behind
    const m2 = await enqueue(owner, ws);
    await rpc("select public.source_mark_started($1,$2,'m2','d2')", [t, m2]);
    const bad = await tryCommit(db, clock, "select public.source_import($1,$2,$3::jsonb,1,0,0)", [t, m2, JSON.stringify([row(1, "X", { website: "javascript:alert(1)" })])]);
    expect(code(bad.error)).toBe("22023");
    expect(await runRow(m2)).toMatchObject({ status: "running", import_id: null });
    expect(Number((await db.admin<{ c: string }>("select count(*) c from public.lead_imports where workspace_id = $1", [ws]))[0].c)).toBe(2);
    await endTick(t);
  });

  test("an import that is no longer importing fails cleanly (22023): the core refuses done and undone imports", async () => {
    const { ws, owner } = await seedSources(db);
    const id = await enqueue(owner, ws);
    const t = await tick();
    await rpc("select public.source_mark_started($1,$2,'e','d')", [t, id]);
    await rpc("select public.source_import($1,$2,$3::jsonb,1,0,0)", [t, id, JSON.stringify([row(1, "Delta Co", { website: "https://delta.example" })])]);
    const imp = (await runRow(id)).import_id!;
    for (const status of ["done", "undone"]) {
      await db.admin("update public.lead_imports set status = $2 where id = $1", [imp, status]);
      const r = await db.try(anon, "select 1");
      expect(r.error).toBeUndefined();
      const direct = await db.try({ role: "authenticated", userId: owner }, "select public.import_rows_core($1,'[]'::jsonb,'apify_maps')", [imp]);
      expect(code(direct.error)).toBe("42501"); // no client can reach the core at all
      let err: unknown;
      try {
        await db.admin("select public.import_rows_core($1,'[]'::jsonb,'apify_maps')", [imp]);
      } catch (e) {
        err = e;
      }
      expect(code(err)).toBe("22023");
      expect((err as Error).message).toMatch(/import is (done|undone)/);
    }
    // a run pointing at an import that is not importing is not re-imported either
    await db.admin("update public.source_runs set status = 'succeeded' where id = $1", [id]);
    expect(code((await db.try(clock, "select public.source_import($1,$2,'[]'::jsonb,0,0,0)", [t, id])).error)).toBe("22023");
    await endTick(t);
  });
});
