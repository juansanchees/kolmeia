import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, anon, as, tryCommit, UUID_A, UUID_B, UUID_C } from "./helpers";

// Migration 0002 (Pesquisa): RLS, column grants and the rules enforced in the database
// [R8] [R11] [R14] [P1] [P3] [P4] [P9] [R16]. Real migrations, non-superuser roles (PGlite).

let db: TestDb;
let wsA: string;
let wsB: string;
const ids: Record<string, string> = {};

const TABLES = [
  "workspace_settings",
  "ai_calls",
  "research_runs",
  "research_sources",
  "research_candidates",
  "research_checks",
  "research_evidence",
  "research_lists",
  "research_list_items",
  // 0004
  "research_jobs",
  "ai_access",
  "ai_limits",
] as const;

/** Spends through the only door left after 0004: reserve, then settle once. */
async function spend(user: string, ws: string, run: string | null, cost: number, reserve = 0.5): Promise<string> {
  const r = await db.query<{ id: string }>(
    as(user),
    "select public.reserve_ai_call($1,$2,'research_plan','claude-opus-5-5','v1',$3,10,25) as id",
    [ws, run, reserve],
  );
  await db.query(as(user), "select public.settle_ai_call($1,'ok',100,10,0,0,0,0,$2,null,5)", [r[0].id, cost]);
  return r[0].id;
}

async function createWorkspace(userId: string, name: string): Promise<string> {
  const rows = await db.query<{ create_workspace: string }>(as(userId), "select public.create_workspace($1)", [name]);
  return rows[0].create_workspace;
}

async function newRun(user: string, ws: string, rigor = "careful"): Promise<string> {
  const r = await db.query<{ id: string }>(
    as(user),
    "insert into public.research_runs (workspace_id, title, request_text, region_text, rigor) values ($1,'t','pedido','Worcester, MA',$2) returning id",
    [ws, rigor],
  );
  return r[0].id;
}

async function newCandidate(user: string, ws: string, run: string, name: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    as(user),
    "insert into public.research_candidates (workspace_id, run_id, name, name_key, website) values ($1,$2,$3,$4,'https://acme.example') returning id",
    [ws, run, name, name.toLowerCase()],
  );
  return r[0].id;
}

const ev = (...urls: string[]) => JSON.stringify(urls.map((url) => ({ url, title: "t", excerpt: "x" })));

async function seed(user: string, ws: string, key: string) {
  ids[`run${key}`] = await newRun(user, ws, "strict");
  ids[`cand${key}`] = await newCandidate(user, ws, ids[`run${key}`], `Acme ${key}`);
  const s = await db.query<{ id: string }>(
    as(user),
    "insert into public.research_sources (workspace_id, run_id, kind, title, url, status) values ($1,$2,'permits','Alvarás','https://permits.example','used') returning id",
    [ws, ids[`run${key}`]],
  );
  ids[`src${key}`] = s[0].id;
  const c = await db.query<{ add_research_check: string }>(
    as(user),
    "select public.add_research_check($1,'exists_active',1,'ok','ativa',$2::jsonb)",
    [ids[`cand${key}`], ev("https://a.example/x", "https://b.example/y")],
  );
  ids[`check${key}`] = c[0].add_research_check;
  await db.query(as(user), "update public.research_candidates set user_decision = 'keep' where id = $1", [ids[`cand${key}`]]);
  const l = await db.query<{ create_research_list: string }>(as(user), "select public.create_research_list($1,'Lista')", [ids[`run${key}`]]);
  ids[`list${key}`] = l[0].create_research_list;
  await spend(user, ws, ids[`run${key}`], 0.25);
  if (user !== UUID_C) await db.query(as(user), "insert into public.workspace_settings (workspace_id, ai_daily_cap_usd) values ($1, 10)", [ws]);
}

beforeAll(async () => {
  db = await TestDb.create();
  for (const id of [UUID_A, UUID_B, UUID_C]) await db.addUser(id);
  wsA = await createWorkspace(UUID_A, "Empresa A");
  wsB = await createWorkspace(UUID_B, "Empresa B");
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr')", [wsA, UUID_C]);
  await seed(UUID_A, wsA, "A");
  await seed(UUID_B, wsB, "B");
});

afterAll(async () => {
  await db.pg.close();
});

describe("0002 tables: RLS on, forced; anon has nothing [R8]", () => {
  test("RLS enabled and forced on every new table", async () => {
    const rows = await db.admin<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relname = any($1)`,
      [TABLES],
    );
    expect(rows).toHaveLength(TABLES.length);
    for (const r of rows) {
      expect(r.relrowsecurity, r.relname).toBe(true);
      expect(r.relforcerowsecurity, r.relname).toBe(true);
    }
  });

  test.each(TABLES)("anon cannot select %s", async (table) => {
    const r = await db.try(anon, `select * from public.${table}`);
    expect(r.error?.message).toMatch(/permission denied/);
  });

  test("anon cannot call the research RPCs", async () => {
    for (const sql of [
      "select public.claim_research_step($1, gen_random_uuid(), 60)",
      "select public.create_research_list($1, 'x')",
      "select public.ai_spend_today($1)",
    ]) {
      const r = await db.try(anon, sql, [ids.runA]);
      expect(r.error?.message, sql).toMatch(/permission denied/);
    }
  });

  test("anon cannot insert a run", async () => {
    const r = await db.try(anon, "insert into public.research_runs (workspace_id, title, request_text) values ($1,'x','y')", [wsA]);
    expect(r.error?.message).toMatch(/permission denied/);
  });
});

describe("user A cannot read or write workspace B [R8]", () => {
  const selectB: Array<[string, string, () => string]> = [
    ["research_runs", "id", () => ids.runB],
    ["research_sources", "id", () => ids.srcB],
    ["research_candidates", "id", () => ids.candB],
    ["research_checks", "id", () => ids.checkB],
    ["research_evidence", "check_id", () => ids.checkB],
    ["research_lists", "id", () => ids.listB],
    ["research_list_items", "list_id", () => ids.listB],
    ["ai_calls", "run_id", () => ids.runB],
    ["workspace_settings", "workspace_id", () => wsB],
  ];

  test.each(selectB)("select %s of B returns nothing", async (table, col, id) => {
    const r = await db.query(as(UUID_A), `select * from public.${table} where ${col} = $1`, [id()]);
    expect(r).toHaveLength(0);
    // and B does see it (the row exists)
    const mine = await db.query(as(UUID_B), `select * from public.${table} where ${col} = $1`, [id()]);
    expect(mine.length).toBeGreaterThan(0);
  });

  test("insert into B's workspace is refused on every table", async () => {
    const attempts: Array<[string, unknown[]]> = [
      ["insert into public.research_runs (workspace_id, title, request_text) values ($1,'x','y')", [wsB]],
      ["insert into public.research_sources (workspace_id, run_id, kind, title, status) values ($1,$2,'news','x','used')", [wsB, ids.runB]],
      ["insert into public.research_candidates (workspace_id, run_id, name, name_key) values ($1,$2,'x','x')", [wsB, ids.runB]],
      ["insert into public.research_checks (workspace_id, candidate_id, kind, pass, result) values ($1,$2,'has_work',1,'no')", [wsB, ids.candB]],
      ["insert into public.research_evidence (workspace_id, check_id, url) values ($1,$2,'https://x.example')", [wsB, ids.checkB]],
      ["insert into public.research_lists (workspace_id, name) values ($1,'x')", [wsB]],
      ["insert into public.research_list_items (list_id, candidate_id, workspace_id) values ($1,$2,$3)", [ids.listB, ids.candB, wsB]],
      ["insert into public.ai_calls (workspace_id, task, model, prompt_version, status) values ($1,'classify','m','v','ok')", [wsB]],
      ["insert into public.workspace_settings (workspace_id) values ($1)", [wsB]],
    ];
    for (const [sql, params] of attempts) {
      const r = await tryCommit(db, as(UUID_A), sql, params);
      expect(r.error, sql).toBeDefined();
    }
  });

  test("own workspace but pointing at B's run / candidate / check is refused", async () => {
    const attempts: Array<[string, unknown[]]> = [
      ["insert into public.research_sources (workspace_id, run_id, kind, title, status) values ($1,$2,'news','x','used')", [wsA, ids.runB]],
      ["insert into public.research_candidates (workspace_id, run_id, name, name_key) values ($1,$2,'x','x')", [wsA, ids.runB]],
      ["insert into public.research_checks (workspace_id, candidate_id, kind, pass, result) values ($1,$2,'has_work',1,'no')", [wsA, ids.candB]],
      ["insert into public.research_evidence (workspace_id, check_id, url) values ($1,$2,'https://x.example')", [wsA, ids.checkB]],
      ["insert into public.research_lists (workspace_id, run_id, name) values ($1,$2,'x')", [wsA, ids.runB]],
      ["insert into public.research_list_items (list_id, candidate_id, workspace_id) values ($1,$2,$3)", [ids.listA, ids.candB, wsA]],
      ["insert into public.ai_calls (workspace_id, run_id, task, model, prompt_version, status) values ($1,$2,'classify','m','v','ok')", [wsA, ids.runB]],
    ];
    for (const [sql, params] of attempts) {
      const r = await tryCommit(db, as(UUID_A), sql, params);
      expect(r.error, sql).toBeDefined();
    }
  });

  test("update of B's rows affects 0 rows", async () => {
    const attempts: Array<[string, string]> = [
      ["update public.research_runs set title = 'hacked' where id = $1 returning id", ids.runB],
      ["update public.research_sources set note = 'hacked' where id = $1 returning id", ids.srcB],
      ["update public.research_candidates set user_decision = 'drop' where id = $1 returning id", ids.candB],
      ["update public.research_lists set name = 'hacked' where id = $1 returning id", ids.listB],
      ["update public.workspace_settings set ai_daily_cap_usd = 99 where workspace_id = $1 returning workspace_id", wsB],
    ];
    for (const [sql, id] of attempts) {
      const r = await db.try(as(UUID_A), sql, [id]);
      expect(r.error, sql).toBeUndefined();
      expect(r.rows, sql).toHaveLength(0);
    }
  });

  test("delete of B's rows affects 0 rows", async () => {
    for (const [sql, id] of [
      ["delete from public.research_runs where id = $1 returning id", ids.runB],
      ["delete from public.research_lists where id = $1 returning id", ids.listB],
      ["delete from public.research_list_items where list_id = $1 returning list_id", ids.listB],
    ] as const) {
      const r = await db.try(as(UUID_A), sql, [id]);
      expect(r.rows, sql).toHaveLength(0);
    }
  });

  test("B's RPCs do nothing for A: lease, list, spend", async () => {
    const lease = await db.query<{ claim_research_step: boolean }>(as(UUID_A), "select public.claim_research_step($1, gen_random_uuid(), 60)", [ids.runB]);
    expect(lease[0].claim_research_step).toBe(false);
    expect((await db.try(as(UUID_A), "select public.create_research_list($1,'x')", [ids.runB])).error?.message).toMatch(/run not found/);
    expect((await db.try(as(UUID_A), "select public.ai_spend_today($1)", [wsB])).error?.message).toMatch(/not a member/);
    expect((await db.try(as(UUID_A), "select public.add_research_check($1,'has_work',1,'no','x','[]')", [ids.candB])).error?.message).toMatch(/candidate not found/);
  });
});

describe("server-owned columns are not client-writable [R14]", () => {
  test.each([
    ["research_runs", "spent_cost_usd = 0"],
    ["research_runs", "locked_until = now()"],
    ["research_runs", "locked_by = gen_random_uuid()"],
    ["research_runs", "approved_at = now()"],
    ["research_runs", "approved_by = id"],
    ["research_runs", "workspace_id = workspace_id"],
    ["research_runs", "created_by = created_by"],
    ["research_runs", "request_text = 'x'"],
    ["research_candidates", "run_id = run_id"],
    ["research_candidates", "workspace_id = workspace_id"],
    ["research_candidates", "name = 'x'"],
    ["research_checks", "result = 'ok'"],
    ["research_evidence", "url = url"],
    ["ai_calls", "cost_usd = 0"],
    ["research_list_items", "candidate_id = candidate_id"],
  ])("%s: update set %s is denied", async (table, set) => {
    const r = await db.try(as(UUID_A), `update public.${table} set ${set}`);
    expect(r.error?.message).toMatch(/permission denied/);
  });

  test("ai_calls, checks and evidence cannot be deleted by clients", async () => {
    for (const t of ["ai_calls", "research_checks", "research_evidence", "research_sources", "research_candidates"]) {
      const r = await db.try(as(UUID_A), `delete from public.${t}`);
      expect(r.error?.message, t).toMatch(/permission denied/);
    }
  });

  test("[finding 2] ai_calls has no client insert at all; the reserved row's user_id and created_at come from the session", async () => {
    const forged = await db.try(as(UUID_A), "insert into public.ai_calls (workspace_id, user_id, task, model, prompt_version, status) values ($1,$2,'classify','m','v','ok')", [wsA, UUID_B]);
    expect(forged.error?.message).toMatch(/permission denied/);
    const plain = await db.try(as(UUID_A), "insert into public.ai_calls (workspace_id, task, model, prompt_version, status, cost_usd) values ($1,'classify','m','v','ok',0)", [wsA]);
    expect(plain.error?.message).toMatch(/permission denied/);
    const id = await spend(UUID_A, wsA, null, 0.01);
    const row = await db.query<{ user_id: string; status: string }>(as(UUID_A), "select user_id, status from public.ai_calls where id = $1", [id]);
    expect(row[0]).toEqual({ user_id: UUID_A, status: "ok" });
  });

  test("ai_calls settled cost is added to the run's spent cost by the trigger (pending adds nothing yet)", async () => {
    const run = await newRun(UUID_A, wsA);
    await spend(UUID_A, wsA, run, 0.4);
    await spend(UUID_A, wsA, run, 0.1);
    const pending = await db.query<{ id: string }>(as(UUID_A), "select public.reserve_ai_call($1,$2,'research_plan','m','v',0.3,10,25) as id", [wsA, run]);
    const r = await db.query<{ spent_cost_usd: string }>(as(UUID_A), "select spent_cost_usd from public.research_runs where id = $1", [run]);
    expect(Number(r[0].spent_cost_usd)).toBeCloseTo(0.5);
    await db.query(as(UUID_A), "select public.settle_ai_call($1,'error',0,0,0,0,0,0,0.05,'x',1)", [pending[0].id]);
    const r2 = await db.query<{ spent_cost_usd: string }>(as(UUID_A), "select spent_cost_usd from public.research_runs where id = $1", [run]);
    expect(Number(r2[0].spent_cost_usd)).toBeCloseTo(0.55);
  });

  test("a new run always starts as 'questions' with no spend, lease or approval", async () => {
    const r = await db.try(as(UUID_A), "insert into public.research_runs (workspace_id, title, request_text, status) values ($1,'x','y','running')", [wsA]);
    expect(r.error?.message).toMatch(/permission denied/);
    const run = await newRun(UUID_A, wsA);
    const row = await db.query<{ status: string; created_by: string }>(as(UUID_A), "select status, created_by from public.research_runs where id = $1", [run]);
    expect(row[0]).toEqual({ status: "questions", created_by: UUID_A });
  });
});

describe("workspace_settings: only owners set the daily AI cap [R16]", () => {
  test("member (sdr) cannot raise the cap", async () => {
    const r = await db.try(as(UUID_C), "update public.workspace_settings set ai_daily_cap_usd = 50 where workspace_id = $1 returning workspace_id", [wsA]);
    expect(r.rows ?? []).toHaveLength(0);
  });
  test("[finding 1e] owner can change it within 0..50 (hard database ceiling)", async () => {
    const ok = await db.try(as(UUID_A), "update public.workspace_settings set ai_daily_cap_usd = 50 where workspace_id = $1 returning ai_daily_cap_usd", [wsA]);
    expect(ok.rows).toHaveLength(1);
    for (const v of [50.01, 100, 1000]) {
      const tooHigh = await db.try(as(UUID_A), "update public.workspace_settings set ai_daily_cap_usd = $2 where workspace_id = $1", [wsA, v]);
      expect(tooHigh.error?.message).toMatch(/check constraint/);
    }
  });
  test("member sees today's spend", async () => {
    const r = await db.query<{ ai_spend_today: string }>(as(UUID_C), "select public.ai_spend_today($1)", [wsA]);
    expect(Number(r[0].ai_spend_today)).toBeGreaterThan(0);
  });
});

describe("P1 / P9: an ok check needs evidence (database backstop)", () => {
  test("[P1] direct insert of an ok check with no evidence fails at commit", async () => {
    const r = await tryCommit(db, as(UUID_A), "insert into public.research_checks (workspace_id, candidate_id, kind, pass, result) values ($1,$2,'has_work',1,'ok')", [wsA, ids.candA]);
    expect(r.error?.message).toMatch(/P1/);
  });
  test("[P1] RPC with empty evidence fails; unknown without evidence is fine", async () => {
    const run = await newRun(UUID_A, wsA, "careful");
    const cand = await newCandidate(UUID_A, wsA, run, "Beta");
    const bad = await tryCommit(db, as(UUID_A), "select public.add_research_check($1,'has_work',1,'ok','x','[]')", [cand]);
    expect(bad.error?.message).toMatch(/P1/);
    const unknown = await tryCommit(db, as(UUID_A), "select public.add_research_check($1,'has_work',1,'unknown','sem fonte','[]')", [cand]);
    expect(unknown.error).toBeUndefined();
    const one = await tryCommit(db, as(UUID_A), "select public.add_research_check($1,'exists_active',1,'ok','x',$2::jsonb)", [cand, ev("https://one.example")]);
    expect(one.error).toBeUndefined();
  });
  test("[P9] strict rigor: one host (even twice, www or not) is not enough; two hosts pass", async () => {
    const run = await newRun(UUID_A, wsA, "strict");
    const cand = await newCandidate(UUID_A, wsA, run, "Gama");
    const one = await tryCommit(db, as(UUID_A), "select public.add_research_check($1,'has_work',1,'ok','x',$2::jsonb)", [cand, ev("https://city.example/a", "https://www.city.example/b")]);
    expect(one.error?.message).toMatch(/P9/);
    const two = await tryCommit(db, as(UUID_A), "select public.add_research_check($1,'has_work',1,'ok','x',$2::jsonb)", [cand, ev("https://city.example/a", "https://news.example/b")]);
    expect(two.error).toBeUndefined();
  });
});

describe("R11: no LinkedIn and no non-http URL can be stored", () => {
  test.each([
    "https://www.linkedin.com/in/someone",
    "http://linkedin.com/company/x",
    "https://br.linkedin.com/in/x",
    "https://lnkd.in/abc",
    "javascript:alert(1)",
    "ftp://files.example/x",
    "https://exa mple.com",
  ])("evidence url %s is rejected", async (url) => {
    const run = await newRun(UUID_A, wsA, "careful");
    const cand = await newCandidate(UUID_A, wsA, run, `D ${url}`);
    const r = await tryCommit(db, as(UUID_A), "select public.add_research_check($1,'exists_active',1,'unknown','x',$2::jsonb)", [cand, ev(url)]);
    expect(r.error?.message).toMatch(/research_evidence_url/);
  });
  test("candidate website, name source, portal and source url reject LinkedIn", async () => {
    for (const col of ["website", "name_source_url", "supplier_portal_url"]) {
      const r = await db.try(as(UUID_A), `update public.research_candidates set ${col} = 'https://www.linkedin.com/company/x' where id = $1`, [ids.candA]);
      expect(r.error?.message, col).toMatch(/check constraint/);
    }
    const s = await db.try(as(UUID_A), "update public.research_sources set note = 'x' where id = $1 returning id", [ids.srcA]);
    expect(s.rows).toHaveLength(1);
    const ins = await db.try(as(UUID_A), "insert into public.research_sources (workspace_id, run_id, kind, title, url, status) values ($1,$2,'other','x','https://linkedin.com/x','used')", [wsA, ids.runA]);
    expect(ins.error?.message).toMatch(/research_sources_url/);
  });
});

describe("P3: only kept candidates can enter a list", () => {
  test("a pending candidate cannot be inserted into a list", async () => {
    const run = await newRun(UUID_A, wsA);
    const cand = await newCandidate(UUID_A, wsA, run, "Pendente");
    const r = await db.try(as(UUID_A), "insert into public.research_list_items (list_id, candidate_id, workspace_id) values ($1,$2,$3)", [ids.listA, cand, wsA]);
    expect(r.error?.message).toMatch(/P3/);
    await db.query(as(UUID_A), "update public.research_candidates set user_decision = 'drop' where id = $1", [cand]);
    const dropped = await db.try(as(UUID_A), "insert into public.research_list_items (list_id, candidate_id, workspace_id) values ($1,$2,$3)", [ids.listA, cand, wsA]);
    expect(dropped.error?.message).toMatch(/P3/);
  });
  test("create_research_list takes only the kept ones and refuses a run with none", async () => {
    const run = await newRun(UUID_A, wsA);
    const keep = await newCandidate(UUID_A, wsA, run, "Fica");
    await newCandidate(UUID_A, wsA, run, "Sai");
    const none = await db.try(as(UUID_A), "select public.create_research_list($1,'x')", [run]);
    expect(none.error?.message).toMatch(/P3/);
    await db.query(as(UUID_A), "update public.research_candidates set user_decision = 'keep' where id = $1", [keep]);
    const list = await db.query<{ create_research_list: string }>(as(UUID_A), "select public.create_research_list($1,'Minha lista')", [run]);
    const items = await db.query<{ candidate_id: string }>(as(UUID_A), "select candidate_id from public.research_list_items where list_id = $1", [list[0].create_research_list]);
    expect(items.map((i) => i.candidate_id)).toEqual([keep]);
  });
});

describe("P4: the search starts only after the plan is approved", () => {
  test("questions -> running is refused; plan -> ready needs a plan; approval is stamped", async () => {
    const run = await newRun(UUID_A, wsA);
    const jump = await db.try(as(UUID_A), "update public.research_runs set status = 'running' where id = $1", [run]);
    expect(jump.error?.message).toMatch(/invalid research status change/);
    await db.query(as(UUID_A), "update public.research_runs set status = 'plan' where id = $1", [run]);
    const noPlan = await db.try(as(UUID_A), "update public.research_runs set status = 'ready' where id = $1", [run]);
    expect(noPlan.error?.message).toMatch(/P4/);
    await db.query(as(UUID_A), `update public.research_runs set plan = '{"places":["Worcester"]}' where id = $1`, [run]);
    await db.query(as(UUID_C), "update public.research_runs set status = 'ready' where id = $1", [run]);
    const row = await db.query<{ approved_by: string; approved_at: string | null }>(as(UUID_A), "select approved_by, approved_at from public.research_runs where id = $1", [run]);
    expect(row[0].approved_by).toBe(UUID_C);
    expect(row[0].approved_at).not.toBeNull();
    const frozen = await db.try(as(UUID_A), "update public.research_runs set max_cost_usd = 9 where id = $1", [run]);
    expect(frozen.error?.message).toMatch(/frozen/);
    const start = await db.try(as(UUID_A), "update public.research_runs set status = 'running' where id = $1 returning status", [run]);
    expect(start.rows?.[0]).toEqual({ status: "running" });
  });
  test("caps have hard ceilings (60 candidates, US$ 10)", async () => {
    const run = await newRun(UUID_A, wsA);
    expect((await db.try(as(UUID_A), "update public.research_runs set max_candidates = 61 where id = $1", [run])).error?.message).toMatch(/check constraint/);
    expect((await db.try(as(UUID_A), "update public.research_runs set max_cost_usd = 10.01 where id = $1", [run])).error?.message).toMatch(/check constraint/);
  });
  test("a finished run cannot be restarted", async () => {
    const run = await newRun(UUID_A, wsA);
    await db.query(as(UUID_A), "update public.research_runs set status = 'cancelled' where id = $1", [run]);
    const r = await db.try(as(UUID_A), "update public.research_runs set status = 'running' where id = $1", [run]);
    expect(r.error?.message).toMatch(/invalid research status change/);
  });
});

describe("step lease", () => {
  test("one holder at a time; released lease can be taken; stale lease can be taken", async () => {
    const run = await newRun(UUID_A, wsA);
    const h1 = "11111111-1111-4111-8111-111111111111";
    const h2 = "22222222-2222-4222-8222-222222222222";
    const claim = async (h: string, user = UUID_A) =>
      (await db.query<{ claim_research_step: boolean }>(as(user), "select public.claim_research_step($1,$2,60)", [run, h]))[0].claim_research_step;
    expect(await claim(h1)).toBe(true);
    expect(await claim(h2, UUID_C)).toBe(false);
    expect(await claim(h1)).toBe(true); // same holder may renew
    await db.query(as(UUID_A), "select public.release_research_step($1,$2)", [run, h2]); // wrong holder: no effect
    expect(await claim(h2)).toBe(false);
    await db.query(as(UUID_A), "select public.release_research_step($1,$2)", [run, h1]);
    expect(await claim(h2)).toBe(true);
    await db.admin("update public.research_runs set locked_until = now() - interval '1 second' where id = $1", [run]);
    expect(await claim(h1)).toBe(true);
  });
});

describe("deleting a run removes its rows (cascade)", () => {
  test("owner deletes a run; sources, candidates, checks and evidence go with it", async () => {
    const run = await newRun(UUID_A, wsA, "careful");
    const cand = await newCandidate(UUID_A, wsA, run, "Delta");
    await db.query(as(UUID_A), "select public.add_research_check($1,'exists_active',1,'ok','x',$2::jsonb)", [cand, ev("https://z.example")]);
    const del = await db.query(as(UUID_A), "delete from public.research_runs where id = $1 returning id", [run]);
    expect(del).toHaveLength(1);
    const left = await db.admin("select 1 from public.research_candidates where run_id = $1", [run]);
    expect(left).toHaveLength(0);
  });
});
