import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, anon, as, UUID_A, UUID_B, UUID_C } from "./helpers";

// Migration 0008 (Agentes): the agents table, the setup-run link and the role rules [A1-A5] [J2] [R8].
// Real migrations, non-superuser roles (PGlite).

const UUID_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // closer in workspace A

let db: TestDb;
let wsA: string;
let wsB: string;

async function createWorkspace(userId: string, name: string): Promise<string> {
  const rows = await db.query<{ create_workspace: string }>(as(userId), "select public.create_workspace($1)", [name]);
  return rows[0].create_workspace;
}

async function draft(user: string, ws: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    as(user),
    "insert into public.agents (workspace_id, type, name) values ($1,'hunter','Caçador X') returning id",
    [ws],
  );
  return r[0].id;
}

const RUN_SQL =
  "insert into public.research_runs (workspace_id, title, request_text, region_text, rigor, setup_agent_id) values ($1,'t','pedido','Worcester, MA','careful',$2) returning id";

async function setupRun(user: string, ws: string, agent: string): Promise<string> {
  const r = await db.query<{ id: string }>(as(user), RUN_SQL, [ws, agent]);
  return r[0].id;
}

/** Superuser: gives a run a plan (status 'plan'). */
async function withPlan(run: string): Promise<void> {
  await db.admin("update public.research_runs set status = 'plan', plan = '{\"steps\":[]}'::jsonb where id = $1", [run]);
}

beforeAll(async () => {
  db = await TestDb.create();
  for (const id of [UUID_A, UUID_B, UUID_C, UUID_D]) await db.addUser(id);
  wsA = await createWorkspace(UUID_A, "Empresa A");
  wsB = await createWorkspace(UUID_B, "Empresa B");
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr'), ($1,$3,'closer')", [wsA, UUID_C, UUID_D]);
});

afterAll(async () => {
  await db.pg.close();
});

describe("0008 agents", () => {
  test("agents: RLS on and forced; anon has nothing", async () => {
    const rows = await db.admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = 'agents'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].relrowsecurity).toBe(true);
    expect(rows[0].relforcerowsecurity).toBe(true);
    expect((await db.try(anon, "select * from public.agents")).error?.message).toMatch(/permission denied/);
  });

  test("J2 owner and sdr create and read agents; the closer sees none and cannot create", async () => {
    const a = await draft(UUID_A, wsA);
    const c = await draft(UUID_C, wsA);
    for (const u of [UUID_A, UUID_C]) {
      const ids = (await db.query<{ id: string }>(as(u), "select id from public.agents where workspace_id = $1", [wsA])).map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining([a, c]));
    }
    const n = await db.query<{ count: string }>(as(UUID_D), "select count(*) from public.agents");
    expect(Number(n[0].count)).toBe(0);
    const r = await db.try(as(UUID_D), "insert into public.agents (workspace_id, type, name) values ($1,'hunter','x')", [wsA]);
    expect(r.error?.message).toMatch(/row-level security/);
    expect(await db.query(as(UUID_D), "update public.agents set name = 'hack' where id = $1 returning id", [a])).toHaveLength(0);
  });

  test("R8 a member of another workspace cannot read, insert or update agents of this one", async () => {
    const a = await draft(UUID_A, wsA);
    expect(await db.query(as(UUID_B), "select id from public.agents where id = $1", [a])).toHaveLength(0);
    const ins = await db.try(as(UUID_B), "insert into public.agents (workspace_id, type, name) values ($1,'hunter','x')", [wsA]);
    expect(ins.error?.message).toMatch(/row-level security/);
    expect(await db.query(as(UUID_B), "update public.agents set name = 'hack' where id = $1 returning id", [a])).toHaveLength(0);
  });

  test("A1 a new agent is a draft stamped by the database", async () => {
    const r = await db.query<{ status: string; created_by: string; archived_at: string | null }>(
      as(UUID_A),
      "insert into public.agents (workspace_id, type, name, status) values ($1,'hunter','Caçador Y','paused') returning status, created_by, archived_at",
      [wsA],
    );
    expect(r[0].status).toBe("draft");
    expect(r[0].created_by).toBe(UUID_A);
    expect(r[0].archived_at).toBeNull();
    for (const col of ["next_run_at", "created_by"]) {
      const v = col === "next_run_at" ? "now()" : `'${UUID_B}'`;
      const e = await db.try(as(UUID_A), `insert into public.agents (workspace_id, type, name, ${col}) values ($1,'hunter','x',${v})`, [wsA]);
      expect((e.error as { code?: string } | undefined)?.code, col).toBe("42501");
    }
  });

  test("A2 a setup run needs a draft hunter of the same workspace, started by owner or sdr; one per agent", async () => {
    const good = await draft(UUID_A, wsA);
    const run = await setupRun(UUID_A, wsA, good);
    expect(run).toBeTruthy();
    // second setup run for the same agent
    expect(((await db.try(as(UUID_A), RUN_SQL, [wsA, good])).error as { code?: string }).code).toBe("23505");
    // agent of another workspace
    const other = await draft(UUID_B, wsB);
    expect((await db.try(as(UUID_A), RUN_SQL, [wsA, other])).error?.message).toMatch(/A2/);
    // paused agent
    const paused = await draft(UUID_A, wsA);
    await db.admin("update public.agents set status = 'paused' where id = $1", [paused]);
    expect((await db.try(as(UUID_A), RUN_SQL, [wsA, paused])).error?.message).toMatch(/A2/);
    // email agent
    const em = await db.admin<{ id: string }>("insert into public.agents (workspace_id, type, name) values ($1,'email','E') returning id", [wsA]);
    expect((await db.try(as(UUID_A), RUN_SQL, [wsA, em[0].id])).error?.message).toMatch(/A2/);
    // the closer, even with a good agent
    const fresh = await draft(UUID_A, wsA);
    expect((await db.try(as(UUID_D), RUN_SQL, [wsA, fresh])).error?.message).toMatch(/A2/);
  });

  test("A3 draft becomes paused only when its setup run has a plan; done and back-to-draft are refused (F3b: running is Ligar)", async () => {
    const ag = await draft(UUID_A, wsA);
    expect((await db.try(as(UUID_A), "update public.agents set status = 'paused' where id = $1", [ag])).error?.message).toMatch(/A3/);
    const run = await setupRun(UUID_A, wsA, ag);
    expect((await db.try(as(UUID_A), "update public.agents set status = 'paused' where id = $1", [ag])).error?.message).toMatch(/A3/); // no plan yet
    await withPlan(run);
    const ok = await db.query<{ status: string }>(as(UUID_A), "update public.agents set status = 'paused' where id = $1 returning status", [ag]);
    expect(ok[0].status).toBe("paused");
    for (const s of ["done", "draft"]) {
      expect((await db.try(as(UUID_A), "update public.agents set status = $2 where id = $1", [ag, s])).error?.message, s).toMatch(/A3/);
    }
  });

  test("A4 archiving stamps the database clock and freezes the agent", async () => {
    const ag = await draft(UUID_A, wsA);
    const t0 = Date.now() - 1000;
    const r = await db.query<{ archived_at: string }>(as(UUID_A), "update public.agents set archived_at = '2000-01-01' where id = $1 returning archived_at", [ag]);
    expect(new Date(r[0].archived_at).getTime()).toBeGreaterThanOrEqual(t0);
    expect((await db.try(as(UUID_A), "update public.agents set name = 'novo' where id = $1", [ag])).error?.message).toMatch(/A4/);
    expect((await db.try(as(UUID_A), "update public.agents set archived_at = null where id = $1", [ag])).error?.message).toMatch(/A4/);
  });

  test("A5 a setup run cannot be approved or run; it can be cancelled", async () => {
    const ag = await draft(UUID_A, wsA);
    const run = await setupRun(UUID_A, wsA, ag);
    await withPlan(run);
    const bad = await db.try(as(UUID_A), "update public.research_runs set status = 'ready' where id = $1", [run]);
    expect(bad.error?.message).toMatch(/A5/);
    const ok = await db.query<{ status: string }>(as(UUID_A), "update public.research_runs set status = 'cancelled' where id = $1 returning status", [run]);
    expect(ok[0].status).toBe("cancelled");
    // no regression: a normal run still goes plan -> ready
    const n = await db.query<{ id: string }>(
      as(UUID_A),
      "insert into public.research_runs (workspace_id, title, request_text) values ($1,'t','pedido') returning id",
      [wsA],
    );
    await withPlan(n[0].id);
    const r = await db.query<{ status: string }>(as(UUID_A), "update public.research_runs set status = 'ready' where id = $1 returning status", [n[0].id]);
    expect(r[0].status).toBe("ready");
  });

  test("A5 a setup run can fail (engine error streak) but still cannot be approved or run", async () => {
    const ag = await draft(UUID_A, wsA);
    const run = await setupRun(UUID_A, wsA, ag);
    await withPlan(run);
    for (const st of ["ready", "running"]) {
      expect((await db.try(as(UUID_A), "update public.research_runs set status = $2 where id = $1", [run, st])).error?.message, st).toMatch(/A5/);
    }
    const ok = await db.query<{ status: string }>(as(UUID_A), "update public.research_runs set status = 'failed' where id = $1 returning status", [run]);
    expect(ok[0].status).toBe("failed");
  });

  test("the guard functions are not callable by clients", async () => {
    const r = await db.try(as(UUID_A), "select public.guard_agent()");
    expect(r.error?.message).toMatch(/permission denied/);
  });

  test("J2 company profile: the closer reads but cannot insert or update; owner and sdr can", async () => {
    const ins = await db.try(as(UUID_D), "insert into public.company_profiles (workspace_id, what_we_do) values ($1,'x')", [wsA]);
    expect(ins.error?.message).toMatch(/row-level security/);
    await db.query(as(UUID_A), "insert into public.company_profiles (workspace_id, what_we_do) values ($1,'HVAC')", [wsA]);
    expect(await db.query(as(UUID_D), "select workspace_id from public.company_profiles where workspace_id = $1", [wsA])).toHaveLength(1);
    expect(await db.query(as(UUID_D), "update public.company_profiles set what_we_do = 'hack' where workspace_id = $1 returning workspace_id", [wsA])).toHaveLength(0);
    expect(await db.query(as(UUID_C), "update public.company_profiles set what_we_do = 'sdr' where workspace_id = $1 returning workspace_id", [wsA])).toHaveLength(1);
  });
});
