import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { DEFAULT_CAPS } from "@/lib/research/types";
import { TestDb, anon, anonWithToken, as, setSchedulerToken, tryCommit, UUID_A } from "./helpers";
import { OTHER_TOKEN, TOKEN } from "./scheduler-seed";
import { beginTick, clock, seedHunter } from "./hunter-seed";

// Migration 0010 part 2: the hunter path (no session, token-gated, scoped to one agent run). PGlite, real migrations.

const ZERO = "00000000-0000-4000-8000-000000000000";
const user = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
const ENTRY_POINTS: [string, unknown[]][] = [
  ["select public.hunter_begin_tick()", []],
  ["select public.hunter_finish_tick($1,'{}'::jsonb,null)", [ZERO]],
  ["select public.hunter_due_work($1)", [ZERO]],
  ["select public.hunter_claim_step($1,$2,60)", [ZERO, ZERO]],
  ["select public.hunter_release_step($1,$2)", [ZERO, ZERO]],
  ["select public.hunter_get_run($1,$2)", [ZERO, ZERO]],
  ["select public.hunter_profile($1,$2)", [ZERO, ZERO]],
  ["select public.hunter_sources($1,$2)", [ZERO, ZERO]],
  ["select public.hunter_candidates($1,$2)", [ZERO, ZERO]],
  ["select public.hunter_checks($1,$2)", [ZERO, ZERO]],
  ["select public.hunter_jobs($1,$2)", [ZERO, ZERO]],
  ["select public.hunter_known_companies($1,$2)", [ZERO, ZERO]],
  ["select public.hunter_update_run($1,$2,'{}'::jsonb)", [ZERO, ZERO]],
  ["select public.hunter_add_sources($1,$2,'[]'::jsonb)", [ZERO, ZERO]],
  ["select public.hunter_add_candidates($1,$2,'[]'::jsonb)", [ZERO, ZERO]],
  ["select public.hunter_update_candidate($1,$2,$3,'{}'::jsonb)", [ZERO, ZERO, ZERO]],
  ["select public.hunter_add_check($1,$2,$3,'has_work',1,'ok','x','[]'::jsonb)", [ZERO, ZERO, ZERO]],
  ["select public.hunter_add_jobs($1,$2,'[]'::jsonb)", [ZERO, ZERO]],
  ["select public.hunter_pause_agent($1,$2,'error')", [ZERO, ZERO]],
  ["select public.hunter_reserve_ai_call($1,$2,'research_verify','m','v',0.1,1,1)", [ZERO, ZERO]],
  ["select public.hunter_settle_ai_call($1,$2,$3,'ok',0,0,0,0,0,0,0,null,0)", [ZERO, ZERO, ZERO]],
];

let db: TestDb;
let nextUser = 100;
const code = (e: Error | undefined) => (e as (Error & { code?: string }) | undefined)?.code;
const rpc = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(clock, sql, params);
// commits on success (so a reserved row stays); an error rolls back and comes back as { error }
const tryRpc = (sql: string, params: unknown[] = []) => tryCommit<{ id: string }>(db, clock, sql, params);
const ids = async (tick: string) => (await rpc<{ r: { run_ids: string[] } }>("select public.hunter_due_work($1) as r", [tick]))[0].r.run_ids;

/** A new owner with a running hunter in its own workspace, its tick open and its first run created. */
async function ready(opts: { schedule?: "once" | "weekly" | "daily"; rigor?: "quick" | "careful" | "strict" } = {}) {
  const userId = user(nextUser++);
  const seed = await seedHunter(db, { ...opts, userId });
  const tick = await beginTick(db);
  await ids(tick);
  const run = (await db.admin<{ id: string }>("select id from public.research_runs where agent_id = $1", [seed.agent]))[0].id;
  return { ...seed, userId, tick, run };
}
const claim = async (tick: string, run: string) => (await rpc<{ ok: boolean }>("select public.hunter_claim_step($1,$2,120) as ok", [tick, run]))[0].ok;
const finish = (tick: string) => rpc("select public.hunter_finish_tick($1,'{}'::jsonb,null)", [tick]);
const reserve = (tick: string, run: string, usd = 0.2) =>
  tryRpc("select public.hunter_reserve_ai_call($1,$2,'research_verify','claude-sonnet-5-5','v1',$3,10,25) as id", [tick, run, usd]);

beforeAll(async () => {
  db = await TestDb.create();
  await setSchedulerToken(db, TOKEN);
});
// Each test starts with no running agents, no open tick and no active agent run, so nothing leaks between tests.
afterEach(async () => {
  await db.admin("update public.agents set status = 'paused' where status = 'running' and archived_at is null");
  await db.admin("update public.research_runs set status = 'cancelled' where agent_id is not null and status in ('ready','running','paused')");
  await db.admin("update public.hunter_ticks set finished_at = now() where finished_at is null");
});
afterAll(async () => {
  await db.pg.close();
});

describe("0010 hunter path", () => {
  test("every hunter_* entry point refuses no token, a wrong token and the clock off (42501); logged-in users cannot execute them", async () => {
    await setSchedulerToken(db, TOKEN);
    for (const actor of [anon, anonWithToken(OTHER_TOKEN), anonWithToken("not-hex"), anonWithToken(TOKEN.toUpperCase())]) {
      for (const [sql, params] of ENTRY_POINTS) expect(code((await db.try(actor, sql, params)).error), sql).toBe("42501");
    }
    for (const [sql, params] of ENTRY_POINTS) {
      const r = await db.try(as(UUID_A), sql, params);
      expect(r.error?.message, sql).toMatch(/permission denied/);
    }
    await setSchedulerToken(db, null); // clock off: even the right token is refused
    for (const [sql, params] of ENTRY_POINTS) expect(code((await db.try(clock, sql, params)).error), sql).toBe("42501");
    await setSchedulerToken(db, TOKEN);
    // with the right token an unknown tick is not 42501 any more: it fails later, on the tick
    const r = await db.try(clock, "select public.hunter_due_work($1)", [ZERO]);
    expect(code(r.error)).toBe("55000");
    expect(await db.admin("select 1 from public.hunter_ticks")).toHaveLength(0);
  });

  test("one tick at a time: a second begin is busy until the first finishes or its lease expires", async () => {
    const t1 = await beginTick(db);
    const busy = (await rpc<{ r: { tick_id: string | null; busy: boolean } }>("select public.hunter_begin_tick() as r"))[0].r;
    expect(busy).toEqual({ tick_id: null, busy: true });
    await finish(t1);
    const t2 = await beginTick(db);
    expect(t2).not.toBe(t1);
    await db.admin("update public.hunter_ticks set lease_until = now() - interval '1 second' where id = $1", [t2]);
    const t3 = await beginTick(db);
    expect(t3).not.toBe(t2);
    const [old] = await db.admin<{ error: string; finished_at: string | null }>("select error, finished_at from public.hunter_ticks where id = $1", [t2]);
    expect(old.error).toBe("lease_expired");
    expect(old.finished_at).not.toBeNull();
    // a finished tick takes no more work, and the heartbeat keeps only small numbers and a short code
    await rpc("select public.hunter_finish_tick($1,$2::jsonb,'ai_cap')", [t3, JSON.stringify({ runs: 2, steps: 5, leak: "secret text", "bad key!": 1 })]);
    const [done] = await db.admin<{ counts: Record<string, number>; error: string }>("select counts, error from public.hunter_ticks where id = $1", [t3]);
    expect(done.counts).toEqual({ runs: 2, steps: 5 });
    expect(done.error).toBe("ai_cap");
    expect(code((await tryRpc("select public.hunter_due_work($1)", [t3])).error)).toBe("55000");
    expect(code((await tryRpc("select public.hunter_finish_tick($1,'{}'::jsonb,null)", [t3])).error)).toBe("55000");
  });

  test("due_work creates one approved run per due agent with the setup plan and hunter_caps, and moves next_run_at", async () => {
    const owner = user(nextUser++);
    const w = await seedHunter(db, { userId: owner, schedule: "weekly", rigor: "careful" });
    const d = await seedHunter(db, { ws: w.ws, userId: owner, schedule: "daily", rigor: "strict" });
    const o = await seedHunter(db, { ws: w.ws, userId: owner, schedule: "once", rigor: "quick" });
    // a config edited by the operator after creation must not move the caps
    await db.admin("update public.agents set config = config || '{\"caps\":{\"maxCostUsd\":999}}'::jsonb where id = $1", [w.agent]);
    // not due: paused, draft, archived-while-running, next_run_at in the future
    const paused = await seedHunter(db, { userId: user(nextUser++), ligar: false });
    const draft = (await db.query<{ id: string }>(as(owner), "insert into public.agents (workspace_id, type, name) values ($1,'hunter','Rascunho') returning id", [w.ws]))[0].id;
    const archived = await seedHunter(db, { userId: user(nextUser++) });
    await db.admin("alter table public.agents disable trigger guard_agent");
    await db.admin("update public.agents set archived_at = now() where id = $1", [archived.agent]);
    await db.admin("alter table public.agents enable trigger guard_agent");
    const later = await seedHunter(db, { userId: user(nextUser++) });
    await db.admin("update public.agents set next_run_at = now() + interval '1 day' where id = $1", [later.agent]);

    const tick = await beginTick(db);
    const run_ids = await ids(tick);
    const runs = await db.admin<{ id: string; agent_id: string; status: string; rigor: string; plan: unknown; request_text: string; max_candidates: number; max_cost_usd: string; max_minutes: number; created_by: string; approved_by: string; title: string }>(
      "select id, agent_id, status, rigor, plan, request_text, max_candidates, max_cost_usd, max_minutes, created_by, approved_by, title from public.research_runs where agent_id is not null",
    );
    expect(runs.map((r) => r.agent_id).sort()).toEqual([w.agent, d.agent, o.agent].sort());
    // the three are listed (at most 3 per tick); the others got nothing
    expect(run_ids).toHaveLength(3);
    for (const [seed, rigor] of [[w, "careful"], [d, "strict"], [o, "quick"]] as const) {
      const r = runs.find((x) => x.agent_id === seed.agent)!;
      expect(r.status).toBe("ready");
      expect(r.rigor).toBe(rigor);
      expect(r.plan).toEqual({ steps: ["collect"] });
      expect(r.request_text).toBe("Construtoras de prédios multifamiliares");
      expect(r.max_candidates).toBe(DEFAULT_CAPS[rigor].maxCandidates);
      expect(Number(r.max_cost_usd)).toBe(DEFAULT_CAPS[rigor].maxCostUsd);
      expect(r.max_minutes).toBe(DEFAULT_CAPS[rigor].maxMinutes);
      expect(r.created_by).toBe(owner);
      expect(r.approved_by).toBe(owner);
      expect(r.title).toMatch(/^Caçador de prédios · \d\d\/\d\d$/);
    }
    const next = async (id: string) => (await db.admin<{ n: string | null }>("select next_run_at as n from public.agents where id = $1", [id]))[0].n;
    const days = (n: string | null) => (new Date(n!).getTime() - Date.now()) / 86_400_000;
    expect(days(await next(w.agent))).toBeCloseTo(7, 1);
    expect(days(await next(d.agent))).toBeCloseTo(1, 1);
    expect(await next(o.agent)).toBeNull();
    for (const n of [paused, archived, later]) {
      expect(await db.admin("select 1 from public.research_runs where agent_id = $1", [n.agent])).toHaveLength(0);
    }
    expect(await db.admin("select 1 from public.research_runs where agent_id = $1", [draft])).toHaveLength(0);
    // a second due_work creates no second run
    await ids(tick);
    expect(await db.admin("select 1 from public.research_runs where agent_id is not null")).toHaveLength(3);
  });

  test("due_work resumes the paused run of a running agent, ends a finished once-agent, and pauses an agent with no setup plan or creator", async () => {
    const a = await ready();
    await db.admin("update public.research_runs set status = 'running' where id = $1", [a.run]);
    await db.admin("update public.research_runs set status = 'paused', progress = '{\"stage\":\"collect\",\"pauseReason\":\"daily_cap\"}'::jsonb where id = $1", [a.run]);
    expect(await ids(a.tick)).toContain(a.run);
    const [r] = await db.admin<{ status: string; progress: Record<string, unknown> }>("select status, progress from public.research_runs where id = $1", [a.run]);
    expect(r.status).toBe("running");
    expect(r.progress).toEqual({ stage: "collect" });

    await finish(a.tick);
    const o = await ready({ schedule: "once" });
    await finish(o.tick);
    await db.admin("update public.research_runs set status = 'running' where id = $1", [o.run]);
    await db.admin("update public.research_runs set status = 'done' where id = $1", [o.run]);
    const t = await beginTick(db);
    await ids(t);
    expect((await db.admin<{ status: string }>("select status from public.agents where id = $1", [o.agent]))[0].status).toBe("done");
    expect(await db.admin("select 1 from public.research_runs where agent_id = $1", [o.agent])).toHaveLength(1);

    const noPlan = await seedHunter(db, { userId: user(nextUser++) });
    await db.admin("delete from public.research_runs where id = $1", [noPlan.setupRun]);
    const noCreator = await seedHunter(db, { userId: user(nextUser++) });
    await db.admin("update public.agents set created_by = null where id = $1", [noCreator.agent]);
    await ids(t);
    const rows = await db.admin<{ id: string; status: string; paused_reason: string | null }>("select id, status, paused_reason from public.agents where id = any($1::uuid[])", [[noPlan.agent, noCreator.agent]]);
    expect(rows.find((x) => x.id === noPlan.agent)).toMatchObject({ status: "paused", paused_reason: "error" });
    expect(rows.find((x) => x.id === noCreator.agent)).toMatchObject({ status: "paused", paused_reason: "no_access" });
    expect(await db.admin("select 1 from public.research_runs where agent_id = any($1::uuid[])", [[noPlan.agent, noCreator.agent]])).toHaveLength(0);
  });

  test("C7 scope: no step for one-off runs, paused or archived agents' runs, or runs locked by others; no write without the step; no candidate of another run", async () => {
    const a = await ready();
    const b = await seedHunter(db, { userId: user(nextUser++) });
    await ids(a.tick);
    const runB = (await db.admin<{ id: string }>("select id from public.research_runs where agent_id = $1", [b.agent]))[0].id;
    // a one-off run of the same workspace
    const oneOff = (await db.admin<{ id: string }>("insert into public.research_runs (workspace_id, title, request_text) values ($1,'avulsa','x') returning id", [a.ws]))[0].id;
    for (const sql of ["select public.hunter_claim_step($1,$2,60)", "select public.hunter_get_run($1,$2)", "select public.hunter_known_companies($1,$2)", "select public.hunter_release_step($1,$2)"]) {
      expect(code((await tryRpc(sql, [a.tick, oneOff])).error), sql).toBe("42501");
    }
    // a paused agent: no new step, but its run can still be read
    await db.admin("update public.agents set status = 'paused' where id = $1", [b.agent]);
    expect(await claim(a.tick, runB)).toBe(false);
    expect((await rpc<{ r: { status: string } }>("select public.hunter_get_run($1,$2) as r", [a.tick, runB]))[0].r.status).toBe("ready");
    expect(await ids(a.tick)).not.toContain(runB);
    // a run locked by someone else (unexpired lease) is neither listed nor claimable; an expired lease is
    await db.admin("update public.agents set status = 'running' where id = $1", [b.agent]);
    await db.admin("update public.research_runs set locked_by = $2, locked_until = now() + interval '1 minute' where id = $1", [runB, ZERO]);
    expect(await ids(a.tick)).not.toContain(runB);
    expect(await claim(a.tick, runB)).toBe(false);
    await db.admin("update public.research_runs set locked_until = now() - interval '1 second' where id = $1", [runB]);
    expect(await ids(a.tick)).toContain(runB);
    // no write without the step
    expect(code((await tryRpc("select public.hunter_update_run($1,$2,'{\"progress\":{\"stage\":\"collect\"}}'::jsonb)", [a.tick, a.run])).error)).toBe("55000");
    expect(code((await tryRpc("select public.hunter_add_sources($1,$2,'[]'::jsonb)", [a.tick, a.run])).error)).toBe("55000");
    expect(await claim(a.tick, a.run)).toBe(true);
    await rpc("select public.hunter_update_run($1,$2,'{\"status\":\"running\",\"progress\":{\"stage\":\"discover_sources\"}}'::jsonb)", [a.tick, a.run]);
    // the claim is refused to a page: a person cannot take the lease of an agent run
    expect((await db.query<{ ok: boolean }>(as(a.userId), "select public.claim_research_step($1,$2,60) as ok", [a.run, ZERO]))[0].ok).toBe(false);
    // a candidate of another run cannot be touched through this run
    expect(await claim(a.tick, runB)).toBe(true);
    const cand = (await rpc<{ r: { id: string }[] }>("select public.hunter_add_candidates($1,$2,$3::jsonb) as r", [a.tick, runB, JSON.stringify([{ name: "Acme Builders", name_key: "acme builders", company_type: "builder" }])]))[0].r[0].id;
    expect(code((await tryRpc("select public.hunter_update_candidate($1,$2,$3,'{\"hook\":\"x\"}'::jsonb)", [a.tick, a.run, cand])).error)).toBe("42501");
    expect(code((await tryRpc("select public.hunter_add_check($1,$2,$3,'has_work',1,'no','x','[]'::jsonb)", [a.tick, a.run, cand])).error)).toBe("42501");
    expect((await rpc<{ r: unknown[] }>("select public.hunter_candidates($1,$2) as r", [a.tick, a.run]))[0].r).toHaveLength(0);
    // the lease is gone after release; the end of the tick also lets go of every lease
    await rpc("select public.hunter_release_step($1,$2)", [a.tick, a.run]);
    expect(code((await tryRpc("select public.hunter_update_run($1,$2,'{\"progress\":{\"stage\":\"collect\"}}'::jsonb)", [a.tick, a.run])).error)).toBe("55000");
    await finish(a.tick);
    expect(await db.admin("select 1 from public.research_runs where locked_by is not null")).toHaveLength(0);
  });

  test("a run that ended takes no write even while its step lease has not expired", async () => {
    const a = await ready();
    expect(await claim(a.tick, a.run)).toBe(true);
    await db.admin("update public.research_runs set status = 'cancelled' where id = $1", [a.run]);
    const [lock] = await db.admin<{ locked_until: string }>("select locked_until from public.research_runs where id = $1", [a.run]);
    expect(new Date(lock.locked_until).getTime()).toBeGreaterThan(Date.now());
    for (const sql of [
      "select public.hunter_update_run($1,$2,'{\"progress\":{\"stage\":\"collect\"}}'::jsonb)",
      "select public.hunter_add_sources($1,$2,'[]'::jsonb)",
      "select public.hunter_add_candidates($1,$2,'[]'::jsonb)",
      "select public.hunter_add_jobs($1,$2,'[]'::jsonb)",
      "select public.hunter_reserve_ai_call($1,$2,'research_verify','m','v',0.1,10,25)",
    ]) {
      expect(code((await tryRpc(sql, [a.tick, a.run])).error), sql).toBe("55000");
    }
    expect(code((await tryRpc("select public.hunter_pause_agent($1,$2,'error')", [a.tick, a.run])).error)).toBe("55000");
    expect(await claim(a.tick, a.run)).toBe(false);
    // and the agent that is archived loses even its reads
    await db.admin("alter table public.agents disable trigger guard_agent");
    await db.admin("update public.agents set archived_at = now() where id = $1", [a.agent]);
    await db.admin("alter table public.agents enable trigger guard_agent");
    expect(code((await tryRpc("select public.hunter_get_run($1,$2)", [a.tick, a.run])).error)).toBe("42501");
  });

  test("C5 AI spend counts against the workspace, creator and global caps and is charged to the creator", async () => {
    const a = await ready();
    expect(await claim(a.tick, a.run)).toBe(true);
    const ok = await reserve(a.tick, a.run);
    expect(ok.error).toBeUndefined();
    const [row] = await db.admin<{ user_id: string; workspace_id: string; run_id: string; status: string }>("select user_id, workspace_id, run_id, status from public.ai_calls where id = $1", [ok.rows![0].id]);
    expect(row).toEqual({ user_id: a.userId, workspace_id: a.ws, run_id: a.run, status: "pending" });
    // settle: only this run's row; the cost reaches the run
    const settle = (id: string, run = a.run) => tryRpc("select public.hunter_settle_ai_call($1,$2,$3,'ok',10,10,0,0,1,0,0.15,null,5)", [a.tick, run, id]);
    expect((await settle(ok.rows![0].id)).error).toBeUndefined();
    expect(Number((await db.admin<{ s: string }>("select spent_cost_usd as s from public.research_runs where id = $1", [a.run]))[0].s)).toBeCloseTo(0.15);
    // settled once: a second settle of the same row is refused
    expect(code((await settle(ok.rows![0].id)).error)).toBe("42501");
  });

  test("C5 caps: workspace daily cap, no access, a creator who left, and a ledger row of another run", async () => {
    const a = await ready();
    const b = await seedHunter(db, { userId: user(nextUser++) });
    await ids(a.tick);
    const runB = (await db.admin<{ id: string }>("select id from public.research_runs where agent_id = $1", [b.agent]))[0].id;
    expect(await claim(a.tick, a.run)).toBe(true);
    expect(await claim(a.tick, runB)).toBe(true);
    // a row of run B cannot be settled through run A
    const rowB = (await reserve(a.tick, runB)).rows![0].id;
    expect(code((await tryRpc("select public.hunter_settle_ai_call($1,$2,$3,'ok',0,0,0,0,0,0,0.1,null,0)", [a.tick, a.run, rowB])).error)).toBe("42501");
    // workspace cap
    await db.admin("insert into public.workspace_settings (workspace_id, ai_daily_cap_usd) values ($1, 0.01) on conflict (workspace_id) do update set ai_daily_cap_usd = 0.01", [a.ws]);
    expect((await reserve(a.tick, a.run)).error?.message).toContain("ai_cap:daily_cap");
    await db.admin("update public.workspace_settings set ai_daily_cap_usd = 50 where workspace_id = $1", [a.ws]);
    // the user cap (the creator's own spend today) and the global ceiling
    expect((await tryRpc("select public.hunter_reserve_ai_call($1,$2,'research_verify','m','v',0.2,0.1,25)", [a.tick, a.run])).error?.message).toContain("ai_cap:user_cap");
    expect((await tryRpc("select public.hunter_reserve_ai_call($1,$2,'research_verify','m','v',0.2,10,0.1)", [a.tick, a.run])).error?.message).toContain("ai_cap:global_cap");
    // no access
    await db.admin("delete from public.ai_access where user_id = $1", [a.userId]);
    expect((await reserve(a.tick, a.run)).error?.message).toContain("ai_cap:no_access");
    await db.grantAi(a.userId);
    await db.admin("update public.agents set created_by = null where id = $1", [a.agent]);
    expect((await reserve(a.tick, a.run)).error?.message).toContain("ai_cap:no_access");
    await db.admin("update public.agents set created_by = $2 where id = $1", [a.agent, a.userId]);
    // a creator who is no longer owner or sdr of the workspace: nothing is reserved
    const sdr = user(nextUser++);
    await db.addUser(sdr);
    await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr')", [a.ws, sdr]);
    const c = await seedHunter(db, { ws: a.ws, userId: sdr });
    await ids(a.tick);
    const runC = (await db.admin<{ id: string }>("select id from public.research_runs where agent_id = $1", [c.agent]))[0].id;
    expect(await claim(a.tick, runC)).toBe(true);
    expect((await reserve(a.tick, runC)).error).toBeUndefined();
    await db.admin("update public.workspace_members set role = 'closer' where workspace_id = $1 and user_id = $2", [a.ws, sdr]);
    expect((await reserve(a.tick, runC)).error?.message).toContain("ai_cap:no_access");
  });

  test("patches accept only the engine's fields", async () => {
    const a = await ready();
    expect(await claim(a.tick, a.run)).toBe(true);
    for (const patch of [{ plan: {} }, { max_cost_usd: 999 }, { workspace_id: ZERO }, { agent_id: null }, { locked_by: ZERO }]) {
      expect(code((await tryRpc("select public.hunter_update_run($1,$2,$3::jsonb)", [a.tick, a.run, JSON.stringify(patch)])).error), JSON.stringify(patch)).toBe("22023");
    }
    expect(code((await tryRpc("select public.hunter_update_run($1,$2,'[1]'::jsonb)", [a.tick, a.run])).error)).toBe("22023");
    await rpc("select public.hunter_update_run($1,$2,'{\"status\":\"running\",\"progress\":{\"stage\":\"collect\",\"collectRounds\":1}}'::jsonb)", [a.tick, a.run]);
    const [run] = await db.admin<{ status: string; progress: { collectRounds: number }; started_at: string | null; max_cost_usd: string }>("select status, progress, started_at, max_cost_usd from public.research_runs where id = $1", [a.run]);
    expect(run.status).toBe("running");
    expect(run.progress.collectRounds).toBe(1);
    expect(run.started_at).not.toBeNull(); // the clock belongs to the database
    expect(Number(run.max_cost_usd)).toBe(DEFAULT_CAPS.careful.maxCostUsd);
    // the run guard still applies: the stage cannot go back
    expect((await tryRpc("select public.hunter_update_run($1,$2,'{\"progress\":{\"stage\":\"discover_sources\"}}'::jsonb)", [a.tick, a.run])).error?.message).toMatch(/stage cannot go back/);

    const cand = (await rpc<{ r: { id: string; run_id: string }[] }>("select public.hunter_add_candidates($1,$2,$3::jsonb) as r", [a.tick, a.run, JSON.stringify([
      { name: "Acme Builders", name_key: "acme builders", website: "https://acme-builders.example", company_type: "builder", run_id: ZERO, workspace_id: ZERO },
    ])]))[0].r;
    expect(cand).toHaveLength(1);
    expect(cand[0].run_id).toBe(a.run); // the run and workspace come from the run, never from the payload
    expect((await db.admin<{ workspace_id: string }>("select workspace_id from public.research_candidates where id = $1", [cand[0].id]))[0].workspace_id).toBe(a.ws);
    // the same name_key is skipped, not an error
    const dup = (await rpc<{ r: unknown[] }>("select public.hunter_add_candidates($1,$2,$3::jsonb) as r", [a.tick, a.run, JSON.stringify([{ name: "ACME Builders", name_key: "acme builders" }])]))[0].r;
    expect(dup).toHaveLength(0);
    for (const patch of [{ workspace_id: ZERO }, { run_id: ZERO }, { user_decision: "keep" }, { name: "x" }]) {
      expect(code((await tryRpc("select public.hunter_update_candidate($1,$2,$3,$4::jsonb)", [a.tick, a.run, cand[0].id, JSON.stringify(patch)])).error), JSON.stringify(patch)).toBe("22023");
    }
    await rpc("select public.hunter_update_candidate($1,$2,$3,$4::jsonb)", [a.tick, a.run, cand[0].id, JSON.stringify({ hook: "Obra nova em Worcester" })]);
    expect((await db.admin<{ hook: string; user_decision: string }>("select hook, user_decision from public.research_candidates where id = $1", [cand[0].id]))[0]).toEqual({ hook: "Obra nova em Worcester", user_decision: "pending" });
    // a check with its proof is an upsert (a retried step replaces it); verification links the lead
    const check = () =>
      rpc<{ id: string }>("select public.hunter_add_check($1,$2,$3,'has_work',1,'ok','tem obra',$4::jsonb) as id", [a.tick, a.run, cand[0].id, JSON.stringify([{ url: "https://permits.example/1", title: "Permit", excerpt: "Permit for 40 units" }])]);
    const id1 = (await check())[0].id;
    expect((await check())[0].id).toBe(id1);
    const checks = (await rpc<{ r: { evidence: unknown[] }[] }>("select public.hunter_checks($1,$2) as r", [a.tick, a.run]))[0].r;
    expect(checks).toHaveLength(1);
    expect(checks[0].evidence).toHaveLength(1);
    await rpc("select public.hunter_update_candidate($1,$2,$3,$4::jsonb)", [a.tick, a.run, cand[0].id, JSON.stringify({ verified_at: new Date().toISOString() })]);
    const lead = await db.admin<{ origin_kind: string; origin_agent_id: string }>("select l.origin_kind, l.origin_agent_id from public.leads l join public.research_candidates c on c.lead_id = l.id where c.id = $1", [cand[0].id]);
    expect(lead).toEqual([{ origin_kind: "agent", origin_agent_id: a.agent }]);
    // sources and jobs
    await rpc("select public.hunter_add_sources($1,$2,$3::jsonb)", [a.tick, a.run, JSON.stringify([{ kind: "permits", title: "Permits Worcester", url: "https://permits.example/", status: "used", note: "" }])]);
    expect((await rpc<{ r: unknown[] }>("select public.hunter_sources($1,$2) as r", [a.tick, a.run]))[0].r).toHaveLength(1);
    const job = JSON.stringify([{ address: "1 Main St", source_url: "https://permits.example/1", excerpt: "x", job_date: "2026-10-01" }]);
    expect((await rpc<{ n: number }>("select public.hunter_add_jobs($1,$2,$3::jsonb) as n", [a.tick, a.run, job]))[0].n).toBe(1);
    expect((await rpc<{ n: number }>("select public.hunter_add_jobs($1,$2,$3::jsonb) as n", [a.tick, a.run, job]))[0].n).toBe(0);
    expect((await rpc<{ r: { job_date: string }[] }>("select public.hunter_jobs($1,$2) as r", [a.tick, a.run]))[0].r[0].job_date).toBe("2026-10-01");
    const profile = await rpc<{ r: unknown }>("select public.hunter_profile($1,$2) as r", [a.tick, a.run]);
    expect(profile[0].r).toBeNull(); // no company profile saved in this workspace
  });

  test("hunter_pause_agent pauses the agent with the reason and its running run", async () => {
    const a = await ready();
    expect(await claim(a.tick, a.run)).toBe(true);
    await rpc("select public.hunter_update_run($1,$2,'{\"status\":\"running\",\"progress\":{\"stage\":\"collect\"}}'::jsonb)", [a.tick, a.run]);
    expect(code((await tryRpc("select public.hunter_pause_agent($1,$2,'because')", [a.tick, a.run])).error)).toBe("22023");
    await rpc("select public.hunter_pause_agent($1,$2,'daily_cap')", [a.tick, a.run]);
    const [agent] = await db.admin<{ status: string; paused_reason: string }>("select status, paused_reason from public.agents where id = $1", [a.agent]);
    expect(agent).toEqual({ status: "paused", paused_reason: "daily_cap" });
    const [run] = await db.admin<{ status: string; progress: { pauseReason: string; stage: string } }>("select status, progress from public.research_runs where id = $1", [a.run]);
    expect(run.status).toBe("paused");
    expect(run.progress).toEqual({ stage: "collect", pauseReason: "daily_cap" });
    // Ligar again (the owner) clears the reason; the next due_work resumes the run
    await db.query(as(a.userId), "update public.agents set status = 'running' where id = $1", [a.agent]);
    expect((await db.admin<{ paused_reason: string | null }>("select paused_reason from public.agents where id = $1", [a.agent]))[0].paused_reason).toBeNull();
    await ids(a.tick);
    expect((await db.admin<{ status: string }>("select status from public.research_runs where id = $1", [a.run]))[0].status).toBe("running");
  });

  test("hunter_known_companies returns this workspace's leads only", async () => {
    const a = await ready();
    const b = await seedHunter(db, { userId: user(nextUser++) });
    const lead = async (ws: string, name: string, phone: string) => {
      const run = (await db.admin<{ id: string }>("insert into public.research_runs (workspace_id, title, request_text) values ($1,'avulsa','x') returning id", [ws]))[0].id;
      await db.admin("insert into public.research_candidates (workspace_id, run_id, name, name_key, website, phone, verified_at) values ($1,$2,$3,$4,$5,$6, now())", [ws, run, name, name.toLowerCase(), `https://${name.toLowerCase().replace(/\W/g, "")}.example`, phone]);
    };
    await lead(a.ws, "Alpha Homes", "(508) 555-0101");
    await lead(a.ws, "Beta Builders", "(508) 555-0102");
    await lead(b.ws, "Other Workspace Co", "(617) 555-0199");
    const known = (await rpc<{ r: { name: string; website: string; phone: string }[] }>("select public.hunter_known_companies($1,$2) as r", [a.tick, a.run]))[0].r;
    expect(known.map((k) => k.name).sort()).toEqual(["Alpha Homes", "Beta Builders"]);
    expect(Object.keys(known[0]).sort()).toEqual(["name", "phone", "website"]);
    // the lead the agent's own run created is not something it already knew
    expect(await claim(a.tick, a.run)).toBe(true);
    const own = (await rpc<{ r: { id: string }[] }>("select public.hunter_add_candidates($1,$2,$3::jsonb) as r", [a.tick, a.run, JSON.stringify([{ name: "Gamma Group", name_key: "gamma group" }])]))[0].r[0].id;
    await rpc("select public.hunter_update_candidate($1,$2,$3,$4::jsonb)", [a.tick, a.run, own, JSON.stringify({ verified_at: new Date().toISOString() })]);
    const after = (await rpc<{ r: { name: string }[] }>("select public.hunter_known_companies($1,$2) as r", [a.tick, a.run]))[0].r;
    expect(after.map((k) => k.name).sort()).toEqual(["Alpha Homes", "Beta Builders"]);
  });

  test("deleting an agent cancels its run instead of leaving an approved run behind (the leads stay)", async () => {
    const a = await ready();
    expect(await claim(a.tick, a.run)).toBe(true);
    const cand = (await rpc<{ r: { id: string }[] }>("select public.hunter_add_candidates($1,$2,$3::jsonb) as r", [a.tick, a.run, JSON.stringify([{ name: "Delta Dev", name_key: "delta dev" }])]))[0].r[0].id;
    await rpc("select public.hunter_update_candidate($1,$2,$3,$4::jsonb)", [a.tick, a.run, cand, JSON.stringify({ verified_at: new Date().toISOString() })]);
    await db.admin("delete from public.agents where id = $1", [a.agent]);
    const [run] = await db.admin<{ status: string; agent_id: string | null }>("select status, agent_id from public.research_runs where id = $1", [a.run]);
    expect(run).toEqual({ status: "cancelled", agent_id: null });
    expect(await db.admin("select 1 from public.leads where workspace_id = $1", [a.ws])).toHaveLength(1);
    expect(code((await tryRpc("select public.hunter_claim_step($1,$2,60)", [a.tick, a.run])).error)).toBe("42501");
  });

  test("the session path is unchanged by the core refactor; a closer cannot spend the workspace AI cap", async () => {
    const owner = user(nextUser++);
    const sdr = user(nextUser++);
    const closer = user(nextUser++);
    const noAi = user(nextUser++);
    const { ws } = await seedHunter(db, { userId: owner, ligar: false });
    await db.addUser(sdr);
    await db.addUser(closer);
    await db.addUser(noAi, false);
    await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr'), ($1,$3,'closer'), ($1,$4,'sdr')", [ws, sdr, closer, noAi]);
    const res = (u: string) => db.try<{ id: string }>(as(u), "select public.reserve_ai_call($1,null,'research_verify','m','v',0.3,10,25) as id", [ws]);
    const own = await db.query<{ id: string }>(as(owner), "select public.reserve_ai_call($1,null,'research_verify','m','v',0.3,10,25) as id", [ws]);
    const [row] = await db.admin<{ user_id: string }>("select user_id from public.ai_calls where id = $1", [own[0].id]);
    expect(row.user_id).toBe(owner);
    expect((await res(sdr)).error).toBeUndefined();
    expect((await res(noAi)).error?.message).toContain("ai_cap:no_access");
    const c = await res(closer);
    expect(code(c.error)).toBe("42501");
    expect(c.error?.message).toMatch(/not allowed/);
    expect((await db.try(as(UUID_A), "select public.reserve_ai_call($1,null,'research_verify','m','v',0.3,10,25)", [ws])).error?.message).toMatch(/not a member|ai_cap:no_access/);
    // settle: only the caller's own pending row
    const settle = (u: string, id: string) => db.try(as(u), "select public.settle_ai_call($1,'ok',1,1,0,0,0,0,0.2,null,1)", [id]);
    expect(code((await settle(sdr, own[0].id)).error)).toBe("42501");
    expect((await settle(owner, own[0].id)).error).toBeUndefined();
    // the closer reads neither the spend nor the ledger
    expect(code((await db.try(as(closer), "select public.ai_spend_today($1)", [ws])).error)).toBe("42501");
    expect(await db.query(as(closer), "select id from public.ai_calls where workspace_id = $1", [ws])).toHaveLength(0);
    expect(Number((await db.query<{ s: string }>(as(owner), "select public.ai_spend_today($1) as s", [ws]))[0].s)).toBeGreaterThan(0);
    // and a page cannot take the step lease of an agent run
    const t = await beginTick(db);
    await db.admin("update public.agents set status = 'running' where workspace_id = $1", [ws]);
    const [run] = await ids(t);
    expect((await db.query<{ ok: boolean }>(as(owner), "select public.claim_research_step($1,$2,60) as ok", [run, ZERO]))[0].ok).toBe(false);
    expect((await db.query<{ ok: boolean }>(as(owner), "select public.claim_research_step($1,$2,60) as ok", [run, run]))[0].ok).toBe(false);
  });
});
