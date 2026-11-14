import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, anon, as, setSchedulerToken } from "./helpers";
import { TOKEN } from "./scheduler-seed";
import { clock } from "./hunter-seed";
import { nameKey } from "@/lib/research/dedupe";
import { MAPS_QUERY, SOURCE_CIPHER, seedSources } from "./sources-seed";
import { row, seedImport } from "./lists-seed";

// Migration 0013 (Connected sources, F3d-1 part 1): encrypted connections, daily caps on a ledger, one import core. Fictional data only.

let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create();
});
afterAll(async () => {
  await db.pg.close();
});

const code = (e: unknown) => (e as { code?: string }).code;
const enqueue = (user: string, ws: string, kind = "maps", query: unknown = MAPS_QUERY, max = 50) =>
  db.try<{ id: string }>(as(user), "select public.enqueue_source_run($1,$2,$3::jsonb,$4) as id", [ws, kind, JSON.stringify(query), max]);
const APOLLO_QUERY = { locations: ["Massachusetts, US"], naics: ["236"], pages: 1 };

describe("0013 connections", () => {
  test("clients never read secret_ciphertext; list_source_connections shows last4 and today's spend only", async () => {
    const { ws, owner, sdr, closer } = await seedSources(db);
    for (const u of [owner, sdr, closer]) {
      const r = await db.try(as(u), "select secret_ciphertext from public.source_connections");
      expect(code(r.error)).toBe("42501");
      expect((await db.try(as(u), "select * from public.source_connections")).error?.message).toMatch(/permission denied/);
    }
    const list = await db.query<Record<string, unknown>>(as(owner), "select * from public.list_source_connections($1)", [ws]);
    expect(list.map((c) => c.provider)).toEqual(["apify", "apollo"]);
    expect(list.map((c) => c.last4)).toEqual(["AB12", "CD34"]);
    expect(JSON.stringify(list)).not.toContain(SOURCE_CIPHER);
    expect(Object.keys(list[0]).sort()).toEqual(["calls_today", "daily_calls", "daily_cap_usd", "last4", "provider", "spent_today_usd", "updated_at"]);
    expect(Number(list[0].daily_cap_usd)).toBe(2);
    expect(Number(list[1].daily_calls)).toBe(20);
    expect(Number(list[0].spent_today_usd)).toBe(0);
    // the sdr lists them too (to know what is connected); the closer cannot
    expect((await db.try(as(sdr), "select * from public.list_source_connections($1)", [ws])).rows).toHaveLength(2);
    expect(code((await db.try(as(closer), "select * from public.list_source_connections($1)", [ws])).error)).toBe("42501");
  });

  test("only the owner sets, caps or deletes a connection; sdr and closer get 42501; caps out of range → 23514", async () => {
    const { ws, owner, sdr, closer } = await seedSources(db);
    for (const u of [sdr, closer]) {
      for (const sql of [
        "select public.set_source_connection($1,'apify',$2,'WX12',1)",
        "select public.set_source_cap($1,'apify',$2)",
        "select public.delete_source_connection($1,'apify')",
        "select public.delete_source_connection($1,'serpapi')",
      ]) {
        const params = sql.includes("set_source_connection") ? [ws, SOURCE_CIPHER] : sql.includes("set_source_cap") ? [ws, 1] : [ws];
        expect(code((await db.try(as(u), sql, params)).error), sql).toBe("42501");
      }
    }
    await db.query(as(owner), "select public.set_source_cap($1,'apify',1.5)", [ws]);
    expect(code((await db.try(as(owner), "select public.set_source_cap($1,'apify',0.4)", [ws])).error)).toBe("23514");
    expect(code((await db.try(as(owner), "select public.set_source_cap($1,'apify',51)", [ws])).error)).toBe("23514");
    expect(code((await db.try(as(owner), "select public.set_source_cap($1,'apollo',0)", [ws])).error)).toBe("23514");
    expect(code((await db.try(as(owner), "select public.set_source_cap($1,'apollo',201)", [ws])).error)).toBe("23514");
    expect(code((await db.try(as(owner), "select public.set_source_cap($1,'apollo',2.5)", [ws])).error)).toBe("22023");
    expect(code((await db.try(as(owner), "select public.set_source_connection($1,'apify','short','AB12',1)", [ws])).error)).toBe("23514");
    expect(code((await db.try(as(owner), "select public.set_source_connection($1,'apify',$2,'AB-2',1)", [ws, SOURCE_CIPHER])).error)).toBe("23514");
    expect(code((await db.try(as(owner), "select public.set_source_connection($1,'serpapi',$2,'AB12',1)", [ws, SOURCE_CIPHER])).error)).toBe("22023");
    expect(code((await db.try(as(owner), "select public.delete_source_connection($1,'serpapi')", [ws])).error)).toBe("22023");
    // no client reads the stored ciphertext: the old session function is gone, the tick path needs the clock's token
    expect(code((await db.try(as(owner), "select public.source_secret($1,'apify')", [ws])).error)).toBe("42501");
    expect(code((await db.try(anon, "select public.source_secret_for_tick($1,'apify')", [ws])).error)).toBe("42883"); // dropped: next_work carries the ciphertext
    // a new key keeps the cap
    await db.query(as(owner), "select public.set_source_connection($1,'apify',$2,'ZZ99',null)", [ws, SOURCE_CIPHER]);
    const c = (await db.query<{ last4: string; daily_cap_usd: string }>(as(owner), "select * from public.list_source_connections($1) where provider = 'apify'", [ws]))[0];
    expect([c.last4, Number(c.daily_cap_usd)]).toEqual(["ZZ99", 1.5]);
    // another workspace's owner gets nothing
    const other = await seedSources(db);
    expect(code((await db.try(as(other.owner), "select public.delete_source_connection($1,'apify')", [ws])).error)).toBe("42501");
  });

  test("deleting a connection refuses its queued runs", async () => {
    const { ws, owner } = await seedSources(db);
    await db.query(as(owner), "select public.enqueue_source_run($1,'maps',$2::jsonb,50)", [ws, JSON.stringify(MAPS_QUERY)]);
    await db.query(as(owner), "select public.enqueue_source_run($1,'apollo',$2::jsonb,25)", [ws, JSON.stringify(APOLLO_QUERY)]);
    await db.query(as(owner), "select public.delete_source_connection($1,'apify')", [ws]);
    const runs = await db.admin<{ provider: string; status: string; error: string | null }>("select provider, status, error from public.source_runs where workspace_id = $1 order by provider", [ws]);
    expect(runs).toEqual([
      { provider: "apify", status: "refused", error: "disconnected" },
      { provider: "apollo", status: "queued", error: null },
    ]);
    expect(await db.admin("select 1 from public.source_connections where workspace_id = $1", [ws])).toHaveLength(1);
  });
});

describe("0013 enqueue and the daily cap", () => {
  test("enqueue refuses without a connection (source_not_connected) and past the cap (source_cap)", async () => {
    const { ws, owner, sdr } = await seedSources(db, { apifyCap: 2, apolloCalls: 2 });
    for (let i = 0; i < 4; i++) {
      const r = await db.try(as(sdr), "select public.enqueue_source_run($1,'maps',$2::jsonb,50)", [ws, JSON.stringify(MAPS_QUERY)]);
      expect(r.error).toBeUndefined();
      await db.query(as(sdr), "select public.enqueue_source_run($1,'maps',$2::jsonb,50)", [ws, JSON.stringify(MAPS_QUERY)]);
    }
    // 4 committed x 0.50 = 2.00: the 5th is refused
    const fifth = await enqueue(sdr, ws);
    expect(fifth.error?.message).toBe("source_cap");
    expect(await db.admin("select 1 from public.source_runs where workspace_id = $1", [ws])).toHaveLength(4);
    for (let i = 0; i < 2; i++) await db.query(as(owner), "select public.enqueue_source_run($1,'apollo',$2::jsonb,25)", [ws, JSON.stringify(APOLLO_QUERY)]);
    expect((await enqueue(owner, ws, "apollo", APOLLO_QUERY, 25)).error?.message).toBe("source_cap");
    // no connection at all
    await db.query(as(owner), "select public.delete_source_connection($1,'apollo')", [ws]);
    const nc = await enqueue(owner, ws, "apollo", APOLLO_QUERY, 25);
    expect(nc.error?.message).toBe("source_not_connected");
    expect(code(nc.error)).toBe("22023");
  });

  test("enqueue validates kind, query keys and max; closers are refused", async () => {
    const { ws, owner, closer } = await seedSources(db);
    expect(code((await enqueue(closer, ws)).error)).toBe("42501");
    expect(code((await enqueue(owner, ws, "contact", MAPS_QUERY)).error)).toBe("22023");
    expect(code((await enqueue(owner, ws, "maps", { ...MAPS_QUERY, extra: 1 })).error)).toBe("22023");
    expect(code((await enqueue(owner, ws, "maps", { terms: [], location: "x" })).error)).toBe("22023");
    expect(code((await enqueue(owner, ws, "maps", { terms: ["a", "b", "c", "d", "e", "f"], location: "x" })).error)).toBe("22023");
    expect(code((await enqueue(owner, ws, "maps", { terms: ["x".repeat(81)], location: "x" })).error)).toBe("22023");
    expect(code((await enqueue(owner, ws, "maps", { terms: ["a"], location: "x".repeat(121) })).error)).toBe("22023");
    expect(code((await enqueue(owner, ws, "maps", MAPS_QUERY, 201)).error)).toBe("22023");
    expect(code((await enqueue(owner, ws, "maps", MAPS_QUERY, 0)).error)).toBe("22023");
    expect(code((await enqueue(owner, ws, "apollo", { naics: ["abc"] }, 25)).error)).toBe("22023");
    expect(code((await enqueue(owner, ws, "apollo", { pages: 5 }, 25)).error)).toBe("22023");
    const ok = await enqueue(owner, ws, "maps", MAPS_QUERY, 200);
    expect(ok.error).toBeUndefined();
    const run = await db.try<Record<string, unknown>>(as(owner), "select public.enqueue_source_run($1,'maps',$2::jsonb,200) as id", [ws, JSON.stringify(MAPS_QUERY)]);
    expect(run.error).toBeUndefined();
  });

  test("reserve = max(0.50, ceil(max x 0.004 x 100)/100) and workspace comes from the caller's membership", async () => {
    const { ws, owner } = await seedSources(db, { apifyCap: 50 });
    for (const [max, reserve] of [[1, 0.5], [50, 0.5], [130, 0.52], [200, 0.8]] as const) {
      await db.query(as(owner), "select public.enqueue_source_run($1,'maps',$2::jsonb,$3)", [ws, JSON.stringify(MAPS_QUERY), max]);
      const r = await db.admin<{ reserve_usd: string; status: string; requested_by: string }>("select reserve_usd, status, requested_by from public.source_runs where workspace_id = $1 and max_results = $2", [ws, max]);
      expect([Number(r[0].reserve_usd), r[0].status, r[0].requested_by]).toEqual([reserve, "queued", owner]);
    }
    const other = await seedSources(db);
    expect(code((await enqueue(other.owner, ws)).error)).toBe("42501");
  });

  test("concurrent enqueues cannot pass the daily cap", async () => {
    const { ws, owner, sdr } = await seedSources(db, { apifyCap: 2 });
    await db.admin("insert into public.source_runs (workspace_id, provider, kind, max_results, status, cost_usd) values ($1,'apify','maps',50,'succeeded',1.20)", [ws]);
    // PGlite has one connection: transaction() runs these one after another, each seeing the other's committed row; on
    // Postgres the 'source:' advisory lock gives the same serialisation across connections.
    const one = (u: string) =>
      db.pg.transaction(async (tx) => {
        await tx.exec("set local role authenticated");
        await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [u]);
        return (await tx.query("select public.enqueue_source_run($1,'maps',$2::jsonb,50)", [ws, JSON.stringify(MAPS_QUERY)])).rows;
      });
    const results = await Promise.allSettled([one(owner), one(sdr)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/source_cap/);
    expect(Number((await db.admin<{ s: string }>("select public.source_spent_today($1) as s", [ws]))[0].s)).toBeCloseTo(1.7);
  });

  test("the day resets at New York midnight, not UTC", async () => {
    const { ws, owner } = await seedSources(db, { apifyCap: 2 });
    // 23:30 New York yesterday: never counts today, in any season
    await db.admin(
      `insert into public.source_runs (workspace_id, provider, kind, max_results, status, cost_usd, created_at)
       values ($1,'apify','maps',50,'succeeded',1.90, (date_trunc('day', now() at time zone 'America/New_York') - interval '30 minutes') at time zone 'America/New_York')`,
      [ws],
    );
    expect(Number((await db.admin<{ s: string }>("select public.source_spent_today($1) as s", [ws]))[0].s)).toBe(0);
    // 00:30 New York today: counts
    await db.admin(
      `insert into public.source_runs (workspace_id, provider, kind, max_results, status, cost_usd, created_at)
       values ($1,'apify','maps',50,'succeeded',0.70, (date_trunc('day', now() at time zone 'America/New_York') + interval '30 minutes') at time zone 'America/New_York')`,
      [ws],
    );
    expect(Number((await db.admin<{ s: string }>("select public.source_spent_today($1) as s", [ws]))[0].s)).toBe(0.7);
    const [{ start }] = await db.admin<{ start: string }>("select (public.source_day_start() at time zone 'America/New_York')::text as start");
    expect(start.endsWith("00:00:00")).toBe(true);
    expect((await enqueue(owner, ws)).error).toBeUndefined();
  });

  test("a finished run counts its cost, a queued one its reserve", async () => {
    const { ws } = await seedSources(db);
    const ins = (status: string, reserve: number, cost: number | null) =>
      db.admin("insert into public.source_runs (workspace_id, provider, kind, max_results, status, reserve_usd, cost_usd) values ($1,'apify','maps',50,$2,$3,$4)", [ws, status, reserve, cost]);
    await ins("queued", 0.5, null); // 0.50
    await ins("running", 0.5, 0.7); // 0.70 (cost above the reserve)
    await ins("succeeded", 0.5, 0.3); // 0.30
    await ins("imported", 0.5, 0.63); // 0.63 (more than reserved)
    await ins("failed", 0.5, null); // 0
    await ins("refused", 0.5, null); // 0
    expect(Number((await db.admin<{ s: string }>("select public.source_spent_today($1) as s", [ws]))[0].s)).toBeCloseTo(2.13);
    await db.admin("insert into public.source_runs (workspace_id, provider, kind, max_results, status) values ($1,'apollo','apollo',25,'succeeded'), ($1,'apollo','apollo',25,'refused')", [ws]);
    expect((await db.admin<{ n: number }>("select public.source_calls_today($1) as n", [ws]))[0].n).toBe(1);
  });
});

describe("0013 import core", () => {
  async function sourceImport(ws: string, kind: "apify_maps" | "apollo", owner: string) {
    return (await db.admin<{ id: string }>("insert into public.lead_imports (workspace_id, created_by, file_name, list_name, kind) values ($1,$2,'Google Maps (Apify)','Maps · teste · 14/11',$3) returning id", [ws, owner, kind]))[0].id;
  }
  const core = (id: string, rows: unknown[], source: string) => db.admin<{ r: Record<string, number> }>("select public.import_rows_core($1,$2::jsonb,$3) as r", [id, JSON.stringify(rows), source]);

  test("import_lead_rows is unchanged for files (F3c-1 tests green) and import_rows_core writes the given source", async () => {
    const { ws, owner } = await seedSources(db);
    // file path: still source 'import'
    const file = await seedImport(db, owner, ws, [row(1, "Bay Developers", { website: "https://bay.example" })]);
    expect((await db.admin<{ source: string }>("select distinct source from public.lead_fields where source_ref = $1", [file.importId])).map((f) => f.source)).toEqual(["import"]);
    // file imports do not accept place_id; a source import does
    const fid = (await db.query<{ id: string }>(as(owner), "select public.create_lead_import($1,'x.csv',null,'x','{}'::jsonb,false) as id", [ws]))[0].id;
    const bad = await db.try(as(owner), "select public.import_lead_rows($1,$2::jsonb)", [fid, JSON.stringify([{ ...row(1, "Zeta Co"), place_id: "P1" }])]);
    expect(code(bad.error)).toBe("22023");
    // a user cannot push rows into a source import through the file RPC
    const sid = await sourceImport(ws, "apify_maps", owner);
    expect(code((await db.try(as(owner), "select public.import_lead_rows($1,$2::jsonb)", [sid, JSON.stringify([row(1, "Zeta Co")])])).error)).toBe("22023");
    // the core is internal: no client can call it
    expect((await db.try(as(owner), "select public.import_rows_core($1,'[]'::jsonb,'apify_maps')", [sid])).error?.message).toMatch(/permission denied/);

    const res = await core(sid, [{ ...row(1, "Alpha Builders LLC", { website: "https://alpha.example", phone: "508-555-0101" }), place_id: "ChIJtest0001", company_type: "General contractor" }], "apify_maps");
    expect(res[0].r).toEqual({ new: 1, merged: 0, errors: 0 });
    const fields = await db.admin<{ field: string; value: string; source: string; source_ref: string }>("select field, value, source, source_ref from public.lead_fields where source_ref = $1 order by field", [sid]);
    expect(fields.map((f) => [f.field, f.source])).toEqual([
      ["company_type", "apify_maps"], ["name", "apify_maps"], ["phone", "apify_maps"], ["place_id", "apify_maps"], ["website", "apify_maps"],
    ]);
    expect(fields.every((f) => f.source_ref === sid)).toBe(true);
    expect(fields.find((f) => f.field === "place_id")!.value).toBe("ChIJtest0001");
    // the source must match the import's kind, and a done import takes no rows
    await expect(core(sid, [row(2, "Beta")], "apollo")).rejects.toMatchObject({ code: "22023" });
    await expect(core(sid, [row(2, "Beta")], "import")).rejects.toMatchObject({ code: "22023" });
    // dedupe through the one rule: the same company from the file merges
    const again = await core(sid, [row(2, "Alpha Builders", { phone: "(508) 555-0101" })], "apify_maps");
    expect(again[0].r).toEqual({ new: 0, merged: 1, errors: 0 });
    // re-sending a stored row is idempotent
    expect((await core(sid, [row(2, "Alpha Builders", { phone: "(508) 555-0101" })], "apify_maps"))[0].r).toEqual({ new: 0, merged: 0, errors: 0 });
    expect(nameKey("Alpha Builders LLC")).toBeTruthy();
  });

  test("undo of an apify_maps import removes only its leads", async () => {
    const { ws, owner } = await seedSources(db);
    const file = await seedImport(db, owner, ws, [row(1, "Shared Dev Co", { website: "https://shared.example" })]);
    const sid = await sourceImport(ws, "apify_maps", owner);
    await core(sid, [row(1, "Maps Only Co", { phone: "508-555-0110" }), row(2, "Shared Dev Co", { website: "https://shared.example" })], "apify_maps");
    await db.admin("update public.lead_imports set status = 'done' where id = $1", [sid]);
    expect(await db.admin("select 1 from public.leads where workspace_id = $1", [ws])).toHaveLength(2);
    const r = (await db.query<{ r: unknown }>(as(owner), "select public.undo_lead_import($1) as r", [sid]))[0].r;
    expect(r).toEqual({ deleted: 1, kept: 1 });
    expect(await db.admin("select 1 from public.leads where workspace_id = $1", [ws])).toHaveLength(1);
    expect(await db.admin("select 1 from public.lead_fields where source_ref = $1", [sid])).toHaveLength(0);
    expect((await db.admin("select 1 from public.lead_fields where source_ref = $1", [file.importId])).length).toBeGreaterThan(0);
  });
});

describe("0013 visibility", () => {
  test("the closer sees no source_runs and no agent_source_settings; senders see theirs only", async () => {
    const { ws, owner, sdr, closer } = await seedSources(db);
    await db.query(as(owner), "select public.enqueue_source_run($1,'maps',$2::jsonb,50)", [ws, JSON.stringify(MAPS_QUERY)]);
    const agent = (await db.query<{ id: string }>(as(owner), "insert into public.agents (workspace_id, type, name, schedule, config) values ($1,'hunter','Caçador','weekly','{}'::jsonb) returning id", [ws]))[0].id;
    await db.query(as(sdr), "select public.set_agent_source_settings($1,$2::jsonb)", [agent, JSON.stringify({ maps_on: true, maps_terms: ["general contractor"], maps_location: "Worcester, MA", apollo_naics: ["236"] })]);
    expect(await db.query(as(owner), "select * from public.source_runs")).toHaveLength(1);
    expect(await db.query(as(sdr), "select * from public.source_runs")).toHaveLength(1);
    expect(await db.query(as(closer), "select * from public.source_runs")).toHaveLength(0);
    expect(await db.query(as(sdr), "select * from public.agent_source_settings")).toHaveLength(1);
    expect(await db.query(as(closer), "select * from public.agent_source_settings")).toHaveLength(0);
    const other = await seedSources(db);
    expect(await db.query(as(other.owner), "select * from public.source_runs")).toHaveLength(0);
    expect(await db.query(as(other.owner), "select * from public.agent_source_settings")).toHaveLength(0);
    // clients cannot write the ledger or the settings directly
    expect((await db.try(as(owner), "update public.source_runs set cost_usd = 0")).error?.message).toMatch(/permission denied/);
    expect((await db.try(as(owner), "delete from public.agent_source_settings")).error?.message).toMatch(/permission denied/);
  });

  test("set_agent_source_settings validates keys, types and limits; the closer is refused", async () => {
    const { ws, owner, closer } = await seedSources(db);
    const agent = (await db.query<{ id: string }>(as(owner), "insert into public.agents (workspace_id, type, name, schedule, config) values ($1,'hunter','Caçador','weekly','{}'::jsonb) returning id", [ws]))[0].id;
    const set = (u: string, p: unknown) => db.try(as(u), "select public.set_agent_source_settings($1,$2::jsonb)", [agent, JSON.stringify(p)]);
    expect(code((await set(closer, { maps_on: false })).error)).toBe("42501");
    expect(code((await set(owner, { workspace_id: ws })).error)).toBe("22023");
    expect(code((await set(owner, { maps_on: "yes" })).error)).toBe("22023");
    expect(code((await set(owner, { maps_terms: [1] })).error)).toBe("22023");
    expect(code((await set(owner, { maps_on: true })).error)).toBe("23514"); // on without terms and place
    expect(code((await set(owner, { maps_max: 201 })).error)).toBe("23514");
    expect(code((await set(owner, { apollo_pages: 5 })).error)).toBe("23514");
    expect(code((await set(owner, { apollo_naics: ["x1"] })).error)).toBe("23514");
    expect(code((await set(owner, { maps_terms: ["a", "b", "c", "d", "e", "f"] })).error)).toBe("23514");
    expect(code((await set(owner, { maps_terms: ["x".repeat(81)] })).error)).toBe("23514");
    expect((await set(owner, { maps_on: true, maps_terms: ["hvac contractor"], maps_location: "Boston, MA" })).error).toBeUndefined();
    // a partial update keeps the rest
    await db.query(as(owner), "select public.set_agent_source_settings($1,$2::jsonb)", [agent, JSON.stringify({ maps_on: true, maps_terms: ["hvac contractor"], maps_location: "Boston, MA" })]);
    await db.query(as(owner), "select public.set_agent_source_settings($1,$2::jsonb)", [agent, JSON.stringify({ maps_max: 80 })]);
    const s = (await db.query<{ maps_on: boolean; maps_terms: string[]; maps_max: number; workspace_id: string }>(as(owner), "select * from public.agent_source_settings where agent_id = $1", [agent]))[0];
    expect([s.maps_on, s.maps_terms, s.maps_max, s.workspace_id]).toEqual([true, ["hvac contractor"], 80, ws]);
  });
});
