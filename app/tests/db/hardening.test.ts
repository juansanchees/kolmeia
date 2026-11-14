import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { hostOf, sanitizeUrl } from "@/lib/safe-url";
import { URL_VECTORS } from "../fixtures/url-vectors";
import { TestDb, anon, as, tryCommit, UUID_A, UUID_B, UUID_C } from "./helpers";

// Migration 0004 (review of 10/11/2026), on the real migrations in PGlite as non-superuser roles.
// [R14] [R16] [P6] findings 1, 2, 6, 7, 10, 17, 20.

let db: TestDb;
let wsA: string;
let wsB: string;
const UUID_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // signed up, not on the AI allowlist

beforeAll(async () => {
  db = await TestDb.create();
  for (const id of [UUID_A, UUID_B, UUID_C]) await db.addUser(id);
  await db.addUser(UUID_D, false);
  wsA = (await db.query<{ id: string }>(as(UUID_A), "select public.create_workspace('A') as id"))[0].id;
  wsB = (await db.query<{ id: string }>(as(UUID_B), "select public.create_workspace('B') as id"))[0].id;
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr'), ($1,$3,'sdr')", [wsA, UUID_C, UUID_D]);
});

afterAll(async () => {
  await db.pg.close();
});

async function newRun(user: string, ws: string, rigor = "careful"): Promise<string> {
  const r = await db.query<{ id: string }>(
    as(user),
    "insert into public.research_runs (workspace_id, title, request_text, region_text, rigor) values ($1,'t','pedido','Worcester, MA',$2) returning id",
    [ws, rigor],
  );
  return r[0].id;
}

const reserve = (user: string, ws: string, run: string | null, usd: number, userCap = 10, globalCap = 25) =>
  tryCommit<{ id: string }>(db, as(user), "select public.reserve_ai_call($1,$2,'research_verify','claude-sonnet-5-5','v',$3,$4,$5) as id", [ws, run, usd, userCap, globalCap]);
const settle = (user: string, id: string, cost: number, status = "ok") =>
  tryCommit(db, as(user), "select public.settle_ai_call($1,$2,10,10,0,0,0,0,$3,null,1)", [id, status, cost]);

async function startRunning(user: string, ws: string, maxCost = 2, rigor = "careful"): Promise<string> {
  const run = await newRun(user, ws, rigor);
  await db.query(as(user), `update public.research_runs set status = 'plan', plan = '{"places":[]}' where id = $1`, [run]);
  await db.query(as(user), "update public.research_runs set max_cost_usd = $2 where id = $1", [run, maxCost]);
  await db.query(as(user), "update public.research_runs set status = 'ready' where id = $1", [run]);
  await db.query(as(user), "update public.research_runs set status = 'running' where id = $1", [run]);
  return run;
}

// ---------------------------------------------------------------- finding 10
describe("[finding 10] URL rules: SQL and TypeScript agree on the same vectors", () => {
  test.each(URL_VECTORS)("%s -> safe %s, host %s", async (url, safe, host) => {
    const r = await db.query<{ safe: boolean; host: string | null }>(as(UUID_A), "select public.is_safe_url($1) as safe, public.url_host($1) as host", [url]);
    expect(r[0].safe).toBe(safe);
    expect(r[0].host).toBe(host);
    expect(sanitizeUrl(url) !== null).toBe(safe);
    expect(hostOf(url)).toBe(host);
  });

  test("whatever sanitizeUrl returns passes the database check", async () => {
    for (const [url] of URL_VECTORS) {
      const clean = sanitizeUrl(url);
      if (!clean) continue;
      const r = await db.query<{ safe: boolean }>(as(UUID_A), "select public.is_safe_url($1) as safe", [clean]);
      expect(r[0].safe, clean).toBe(true);
    }
  });

  test("trailing-dot LinkedIn and IP hosts cannot be stored", async () => {
    const run = await newRun(UUID_A, wsA);
    for (const url of ["https://www.linkedin.com./in/x", "http://[::1]/x", "http://127.0.0.1/x", "http://metadata.internal/"]) {
      const r = await tryCommit(db, as(UUID_A), "insert into public.research_sources (workspace_id, run_id, kind, title, url, status) values ($1,$2,'other','x',$3,'used')", [wsA, run, url]);
      expect(r.error?.message, url).toMatch(/check constraint/);
    }
  });
});

// ---------------------------------------------------------------- finding 1
describe("[finding 1] AI access allowlist and spend ceilings", () => {
  test("a user without an ai_access row cannot reserve (typed 'ai_cap:no_access')", async () => {
    const r = await reserve(UUID_D, wsA, null, 0.1);
    expect(r.error?.message).toMatch(/ai_cap:no_access/);
  });

  test("ai_access: a user reads only their own row and cannot grant themselves", async () => {
    expect(await db.query(as(UUID_A), "select user_id from public.ai_access")).toEqual([{ user_id: UUID_A }]);
    expect(await db.query(as(UUID_D), "select user_id from public.ai_access")).toEqual([]);
    const self = await tryCommit(db, as(UUID_D), "insert into public.ai_access (user_id) values ($1)", [UUID_D]);
    expect(self.error?.message).toMatch(/permission denied/);
    const del = await tryCommit(db, as(UUID_A), "delete from public.ai_access where user_id = $1", [UUID_A]);
    expect(del.error?.message).toMatch(/permission denied/);
  });

  test("ai_limits is invisible and unchangeable for clients", async () => {
    for (const sql of ["select * from public.ai_limits", "update public.ai_limits set global_daily_max_usd = 9999"]) {
      expect((await db.try(as(UUID_A), sql)).error?.message, sql).toMatch(/permission denied/);
    }
    expect((await db.try(anon, "select public.ai_spend_today_global()")).error?.message).toMatch(/permission denied/);
  });

  test("the migration seeds every user that existed when it ran (PGlite stub included)", async () => {
    const t = await TestDb.create();
    await t.admin("insert into auth.users (id) values ($1)", [UUID_A]);
    const sql = (await import("node:fs")).readFileSync(
      (await import("node:path")).resolve(import.meta.dirname, "../../supabase/migrations/0004_research_hardening.sql"),
      "utf8",
    );
    await t.pg.exec(sql); // re-runnable, and seeds the user created after the first run
    expect(await t.admin("select user_id from public.ai_access")).toEqual([{ user_id: UUID_A }]);
    await t.pg.close();
  });

  test("create_workspace: at most 3 owned workspaces per user", async () => {
    const u = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await db.addUser(u);
    for (let i = 0; i < 3; i++) await db.query(as(u), "select public.create_workspace($1)", [`W${i}`]);
    const fourth = await tryCommit(db, as(u), "select public.create_workspace('W4')");
    expect(fourth.error?.message).toMatch(/at most 3/);
  });

  test("per-user daily cap counts the user's calls in every workspace; env value is clamped to ai_limits", async () => {
    const u = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await db.addUser(u);
    const w1 = (await db.query<{ id: string }>(as(u), "select public.create_workspace('U1') as id"))[0].id;
    const w2 = (await db.query<{ id: string }>(as(u), "select public.create_workspace('U2') as id"))[0].id;
    const a = await reserve(u, w1, null, 0.6, 1);
    expect(a.error).toBeUndefined();
    const b = await reserve(u, w2, null, 0.6, 1); // other workspace, same user: 1.2 > 1
    expect(b.error?.message).toMatch(/ai_cap:user_cap/);
    // asking for a higher cap than ai_limits (10) does not help
    await db.admin("update public.ai_limits set user_daily_max_usd = 1");
    const c = await reserve(u, w2, null, 0.6, 500);
    expect(c.error?.message).toMatch(/ai_cap:user_cap/);
    await db.admin("update public.ai_limits set user_daily_max_usd = 10");
    expect((await db.query<{ s: string }>(as(u), "select public.ai_spend_today_user() as s"))[0].s).toBe("0.600000");
  });

  test("global daily cap across all workspaces", async () => {
    await db.admin("update public.ai_limits set global_daily_max_usd = 0.5");
    const r = await reserve(UUID_B, wsB, null, 0.4);
    expect(r.error?.message).toMatch(/ai_cap:global_cap/); // earlier tests already spent today
    await db.admin("update public.ai_limits set global_daily_max_usd = 25");
    const g = await db.query<{ s: string }>(as(UUID_B), "select public.ai_spend_today_global() as s");
    expect(Number(g[0].s)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- finding 2
describe("[finding 2] reserve_ai_call / settle_ai_call", () => {
  test("pending rows count at their reserve (never free, however old); a settled row counts at its cost", async () => {
    const ws = (await db.query<{ id: string }>(as(UUID_C), "select public.create_workspace('C') as id"))[0].id;
    await db.query(as(UUID_C), "insert into public.workspace_settings (workspace_id, ai_daily_cap_usd) values ($1, 1)", [ws]);
    const first = await reserve(UUID_C, ws, null, 0.7);
    expect(first.error).toBeUndefined();
    await db.admin("update public.ai_calls set created_at = now() - interval '20 minutes' where id = $1", [first.rows![0].id]);
    const second = await reserve(UUID_C, ws, null, 0.4); // 0.7 pending + 0.4 > 1
    expect(second.error?.message).toMatch(/ai_cap:daily_cap/);
    expect(Number((await db.query<{ s: string }>(as(UUID_C), "select public.ai_spend_today($1) as s", [ws]))[0].s)).toBeCloseTo(0.7);
    await settle(UUID_C, first.rows![0].id, 0.1);
    const third = await reserve(UUID_C, ws, null, 0.4); // 0.1 + 0.4 <= 1
    expect(third.error).toBeUndefined();
  });

  test("concurrent reservations never exceed the workspace cap (10 at once, cap fits 3)", async () => {
    const u = "abababab-abab-4bab-8bab-abababababab";
    await db.addUser(u);
    const ws = (await db.query<{ id: string }>(as(u), "select public.create_workspace('Burst') as id"))[0].id;
    await db.query(as(u), "insert into public.workspace_settings (workspace_id, ai_daily_cap_usd) values ($1, 2)", [ws]);
    // PGlite has a single connection: its transaction() queue runs these one after another, so this proves the
    // check-and-insert is atomic per call and that pending rows are seen by the next call; on Postgres the
    // transaction-level advisory lock gives the same serialisation across connections.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        db.pg.transaction(async (tx) => {
          await tx.exec("set local role authenticated");
          await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [u]);
          return (await tx.query("select public.reserve_ai_call($1,null,'research_verify','m','v',0.6,10,25)", [ws])).rows;
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const r of results.filter((x) => x.status === "rejected")) expect(String((r as PromiseRejectedResult).reason)).toMatch(/ai_cap:daily_cap/);
    const spent = await db.query<{ s: string }>(as(u), "select public.ai_spend_today($1) as s", [ws]);
    expect(Number(spent[0].s)).toBeLessThanOrEqual(2);
  });

  test("run cap and run time are checked in the database while the run is running", async () => {
    const run = await startRunning(UUID_A, wsA, 1);
    const a = await reserve(UUID_A, wsA, run, 0.7);
    expect(a.error).toBeUndefined();
    const b = await reserve(UUID_A, wsA, run, 0.4); // 0.7 pending + 0.4 > 1
    expect(b.error?.message).toMatch(/ai_cap:run_cap/);
    await settle(UUID_A, a.rows![0].id, 0.2);
    expect((await reserve(UUID_A, wsA, run, 0.4)).error).toBeUndefined();
    // The guard trigger owns started_at, so the test moves the clock with the trigger switched off (superuser only).
    await db.admin("alter table public.research_runs disable trigger guard_research_run");
    await db.admin("update public.research_runs set started_at = now() - interval '3 hours' where id = $1", [run]);
    await db.admin("alter table public.research_runs enable trigger guard_research_run");
    expect((await reserve(UUID_A, wsA, run, 0.1)).error?.message).toMatch(/ai_cap:run_time/);
  });

  test("settle: only the caller's own pending row, only once, with a bounded cost and a known status", async () => {
    const r = await reserve(UUID_A, wsA, null, 0.2);
    const id = r.rows![0].id;
    expect((await settle(UUID_C, id, 0.1)).error?.message).toMatch(/not a pending call of this user/);
    expect((await settle(UUID_A, id, 26)).error?.message).toMatch(/invalid cost/);
    expect((await settle(UUID_A, id, -1)).error?.message).toMatch(/invalid cost/);
    expect((await settle(UUID_A, id, 0.1, "pending")).error?.message).toMatch(/invalid status/);
    expect((await settle(UUID_A, id, 0.1)).error).toBeUndefined();
    expect((await settle(UUID_A, id, 0.0)).error?.message).toMatch(/not a pending call/);
  });

  test("reserve refuses a reserve above the per-call ceiling, other workspaces and other workspaces' runs", async () => {
    expect((await reserve(UUID_A, wsA, null, 30)).error?.message).toMatch(/invalid reserve/);
    expect((await reserve(UUID_A, wsB, null, 0.1)).error?.message).toMatch(/not a member/);
    const runB = await newRun(UUID_B, wsB);
    expect((await reserve(UUID_A, wsA, runB, 0.1)).error?.message).toMatch(/run not in workspace/);
    expect((await db.try(anon, "select public.reserve_ai_call(gen_random_uuid(),null,'classify','m','v',0.1,1,1)")).error?.message).toMatch(/permission denied/);
  });
});

// ---------------------------------------------------------------- finding 7
describe("[finding 7] the run's clock, end-of-run fields and progress are guarded", () => {
  test("started_at is stamped on ready -> running and cannot be moved; finished_at belongs to the end", async () => {
    const run = await startRunning(UUID_A, wsA);
    const before = await db.query<{ started_at: Date }>(as(UUID_A), "select started_at from public.research_runs where id = $1", [run]);
    expect(before[0].started_at).toBeInstanceOf(Date);
    await db.query(as(UUID_A), "update public.research_runs set started_at = now() + interval '5 hours', finished_at = now() where id = $1", [run]);
    const after = await db.query<{ started_at: Date; finished_at: Date | null }>(as(UUID_A), "select started_at, finished_at from public.research_runs where id = $1", [run]);
    expect(after[0].started_at.getTime()).toBe(before[0].started_at.getTime());
    expect(after[0].finished_at).toBeNull();
    await db.query(as(UUID_A), "update public.research_runs set status = 'cancelled' where id = $1", [run]);
    const done = await db.query<{ finished_at: Date | null }>(as(UUID_A), "select finished_at from public.research_runs where id = $1", [run]);
    expect(done[0].finished_at).toBeInstanceOf(Date);
  });

  test("limits_notes / is_partial / partial_reason only together with the end of the run", async () => {
    const run = await startRunning(UUID_A, wsA);
    for (const set of [`limits_notes = '[{"kind":"partial","text":"x"}]'`, "is_partial = true", "partial_reason = 'x'"]) {
      const r = await db.try(as(UUID_A), `update public.research_runs set ${set} where id = $1`, [run]);
      expect(r.error?.message, set).toMatch(/only when the run ends/);
    }
    const ok = await db.try(as(UUID_A), `update public.research_runs set status = 'done', is_partial = true, partial_reason = 'tempo', limits_notes = '[]' where id = $1 returning is_partial`, [run]);
    expect(ok.rows).toEqual([{ is_partial: true }]);
  });

  test("progress: the stage never goes back and collectRounds never decreases", async () => {
    const run = await startRunning(UUID_A, wsA);
    await db.query(as(UUID_A), `update public.research_runs set progress = '{"stage":"verify","collectRounds":2}' where id = $1`, [run]);
    expect((await db.try(as(UUID_A), `update public.research_runs set progress = '{"stage":"collect","collectRounds":2}' where id = $1`, [run])).error?.message).toMatch(/cannot go back/);
    expect((await db.try(as(UUID_A), `update public.research_runs set progress = '{"stage":"verify","collectRounds":0}' where id = $1`, [run])).error?.message).toMatch(/cannot decrease/);
    expect((await db.try(as(UUID_A), `update public.research_runs set progress = '{"collectRounds":2}' where id = $1`, [run])).error?.message).toMatch(/cannot go back/);
    expect((await db.try(as(UUID_A), `update public.research_runs set progress = '{"stage":"finalize","collectRounds":2,"seen":[]}' where id = $1`, [run])).error).toBeUndefined();
  });
});

// ---------------------------------------------------------------- findings 6, 17, 20
describe("[finding 6] one check per (candidate, kind, pass); add_research_check is idempotent", () => {
  test("a repeated call replaces the result and the evidence instead of adding a second check", async () => {
    const run = await newRun(UUID_A, wsA);
    const cand = (await db.query<{ id: string }>(as(UUID_A), "insert into public.research_candidates (workspace_id, run_id, name, name_key) values ($1,$2,'Idem','idem') returning id", [wsA, run]))[0].id;
    const ev = (u: string) => JSON.stringify([{ url: u, title: "t", excerpt: "x" }]);
    await db.query(as(UUID_A), "select public.add_research_check($1,'exists_active',1,'ok','primeira',$2::jsonb)", [cand, ev("https://a.example/1")]);
    await db.query(as(UUID_A), "select public.add_research_check($1,'exists_active',1,'unknown','segunda',$2::jsonb)", [cand, ev("https://b.example/2")]);
    const checks = await db.query<{ id: string; result: string; summary: string }>(as(UUID_A), "select id, result, summary from public.research_checks where candidate_id = $1", [cand]);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ result: "unknown", summary: "segunda" });
    const evs = await db.query<{ url: string }>(as(UUID_A), "select url from public.research_evidence where check_id = $1", [checks[0].id]);
    expect(evs).toEqual([{ url: "https://b.example/2" }]);
    // direct duplicate insert is refused by the unique constraint
    const dup = await tryCommit(db, as(UUID_A), "insert into public.research_checks (workspace_id, candidate_id, kind, pass, result) values ($1,$2,'exists_active',1,'no')", [wsA, cand]);
    expect(dup.error?.message).toMatch(/unique|duplicate/);
  });
});

describe("[finding 17] [finding 20] new statuses, columns and the jobs queue", () => {
  test("source status 'unverified' is accepted; unknown statuses are not", async () => {
    const run = await newRun(UUID_A, wsA);
    const ok = await tryCommit(db, as(UUID_A), "insert into public.research_sources (workspace_id, run_id, kind, title, status) values ($1,$2,'permits','x','unverified')", [wsA, run]);
    expect(ok.error).toBeUndefined();
    const bad = await tryCommit(db, as(UUID_A), "insert into public.research_sources (workspace_id, run_id, kind, title, status) values ($1,$2,'permits','x','maybe')", [wsA, run]);
    expect(bad.error?.message).toMatch(/check constraint/);
  });

  test("research_jobs: RLS by workspace, idempotent RPC, address or project name required, safe URL", async () => {
    const run = await newRun(UUID_A, wsA);
    const jobs = JSON.stringify([
      { address: "40 Elm St", project_name: null, job_type: "3-family", declared_value_usd: 650000, job_date: "2026-10-02", source_url: "https://permits.example/1", excerpt: "x", seen_at: null },
    ]);
    expect((await db.query<{ n: number }>(as(UUID_A), "select public.add_research_jobs($1,$2::jsonb) as n", [run, jobs]))[0].n).toBe(1);
    expect((await db.query<{ n: number }>(as(UUID_A), "select public.add_research_jobs($1,$2::jsonb) as n", [run, jobs]))[0].n).toBe(0);
    expect(await db.query(as(UUID_B), "select * from public.research_jobs where run_id = $1", [run])).toEqual([]);
    expect((await tryCommit(db, as(UUID_B), "select public.add_research_jobs($1,$2::jsonb)", [run, jobs])).error?.message).toMatch(/run not found/);
    const none = JSON.stringify([{ address: null, project_name: null, source_url: "https://permits.example/2" }]);
    expect((await tryCommit(db, as(UUID_A), "select public.add_research_jobs($1,$2::jsonb)", [run, none])).error?.message).toMatch(/research_jobs_what/);
    const li = JSON.stringify([{ address: "1 A St", source_url: "https://linkedin.com./x" }]);
    expect((await tryCommit(db, as(UUID_A), "select public.add_research_jobs($1,$2::jsonb)", [run, li])).error?.message).toMatch(/research_jobs_source_url/);
  });

  test("candidate source columns reject unsafe URLs", async () => {
    const run = await newRun(UUID_A, wsA);
    const r = await tryCommit(db, as(UUID_A), "insert into public.research_candidates (workspace_id, run_id, name, name_key, found_at_url) values ($1,$2,'X','x','http://10.0.0.1/')", [wsA, run]);
    expect(r.error?.message).toMatch(/research_candidates_found_at_url/);
  });
});
