import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { DEFAULT_CAPS, RIGORS } from "@/lib/research/types";
import { TestDb, as, UUID_A, UUID_B } from "./helpers";

// Migration 0010 (Caçador em segundo plano), part 1: agent life cycle and agent runs. PGlite, real migrations.

let db: TestDb;
let wsA: string;
let wsB: string;

async function createWorkspace(userId: string, name: string): Promise<string> {
  const rows = await db.query<{ create_workspace: string }>(as(userId), "select public.create_workspace($1)", [name]);
  return rows[0].create_workspace;
}

/** draft + setup run with a plan, then the user pauses it (A3). */
async function pausedHunter(user: string, ws: string): Promise<string> {
  const a = await db.query<{ id: string }>(
    as(user),
    "insert into public.agents (workspace_id, type, name, config) values ($1,'hunter','Caçador X', '{\"rigor\":\"careful\"}') returning id",
    [ws],
  );
  const id = a[0].id;
  const r = await db.query<{ id: string }>(
    as(user),
    "insert into public.research_runs (workspace_id, title, request_text, region_text, rigor, setup_agent_id) values ($1,'t','pedido','Worcester, MA','careful',$2) returning id",
    [ws, id],
  );
  await db.admin("update public.research_runs set status = 'plan', plan = '{\"steps\":[]}'::jsonb where id = $1", [r[0].id]);
  await db.query(as(user), "update public.agents set status = 'paused' where id = $1", [id]);
  return id;
}

async function ligar(user: string, id: string) {
  return db.try(as(user), "update public.agents set status = 'running' where id = $1", [id]);
}
async function ligarOk(user: string, id: string) {
  return db.query(as(user), "update public.agents set status = 'running' where id = $1 returning id", [id]);
}

async function agentRun(agent: string, ws: string, status = "paused"): Promise<string> {
  const r = await db.admin<{ id: string }>(
    "insert into public.research_runs (workspace_id, title, request_text, region_text, rigor, agent_id, status, plan) values ($1,'t','p','r','careful',$2,'ready','{\"steps\":[]}'::jsonb) returning id",
    [ws, agent],
  );
  if (status !== "ready") {
    if (status === "paused") await db.admin("update public.research_runs set status = 'running' where id = $1", [r[0].id]);
    await db.admin("update public.research_runs set status = $2 where id = $1", [r[0].id, status]);
  }
  return r[0].id;
}

beforeAll(async () => {
  db = await TestDb.create();
  for (const id of [UUID_A, UUID_B]) await db.addUser(id);
  wsA = await createWorkspace(UUID_A, "Empresa A");
  wsB = await createWorkspace(UUID_B, "Empresa B");
});

// Each test starts with no running hunters, so the max-3 rule (A7) never leaks between tests.
afterEach(async () => {
  await db.admin("update public.agents set status = 'paused' where status = 'running' and archived_at is null");
});

afterAll(async () => {
  await db.pg.close();
});

describe("0010 agent life cycle", () => {
  test("Ligar sets next_run_at to now the first time and keeps a later one; Pausar keeps it", async () => {
    const id = await pausedHunter(UUID_A, wsA);
    const t0 = Date.now() - 2000;
    const r = await db.query<{ next_run_at: string }>(as(UUID_A), "update public.agents set status = 'running' where id = $1 returning next_run_at", [id]);
    const first = new Date(r[0].next_run_at).getTime();
    expect(first).toBeGreaterThanOrEqual(t0);
    expect(first).toBeLessThanOrEqual(Date.now() + 2000);
    await db.admin("update public.agents set next_run_at = now() + interval '3 days' where id = $1", [id]);
    const p = await db.query<{ next_run_at: string }>(as(UUID_A), "update public.agents set status = 'paused' where id = $1 returning next_run_at", [id]);
    const l = await db.query<{ next_run_at: string }>(as(UUID_A), "update public.agents set status = 'running' where id = $1 returning next_run_at", [id]);
    expect(new Date(p[0].next_run_at).getTime()).toBe(new Date(l[0].next_run_at).getTime());
    expect(new Date(l[0].next_run_at).getTime()).toBeGreaterThan(Date.now() + 2 * 86400_000);
  });

  test("C6 a 4th running hunter is refused (A7); other workspaces and paused agents do not count", async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await pausedHunter(UUID_A, wsA));
    for (const id of ids.slice(0, 3)) expect(await ligarOk(UUID_A, id)).toHaveLength(1);
    expect((await ligar(UUID_A, ids[3])).error?.message).toMatch(/A7/);
    const other = await pausedHunter(UUID_B, wsB);
    expect(await ligarOk(UUID_B, other)).toHaveLength(1);
    // pausing one frees a slot; a paused 4th stays paused without complaint
    await db.query(as(UUID_A), "update public.agents set status = 'paused' where id = $1", [ids[0]]);
    expect(await ligarOk(UUID_A, ids[3])).toHaveLength(1);
    await db.admin("update public.agents set status = 'paused' where workspace_id in ($1,$2)", [wsA, wsB]);
  });

  test("A6 config and schedule are frozen once the agent left draft", async () => {
    const id = await pausedHunter(UUID_A, wsA);
    expect((await db.try(as(UUID_A), "update public.agents set config = '{\"rigor\":\"strict\"}' where id = $1", [id])).error?.message).toMatch(/A6/);
    expect((await db.try(as(UUID_A), "update public.agents set schedule = 'daily' where id = $1", [id])).error?.message).toMatch(/A6/);
    const d = await db.query<{ id: string }>(as(UUID_A), "insert into public.agents (workspace_id, type, name) values ($1,'hunter','d') returning id", [wsA]);
    expect(
      await db.query(as(UUID_A), "update public.agents set config = '{\"rigor\":\"strict\"}', schedule = 'daily' where id = $1 returning id", [d[0].id]),
    ).toHaveLength(1);
  });

  test("A8 a running agent cannot be archived; archiving cancels its setup and active runs", async () => {
    const id = await pausedHunter(UUID_A, wsA);
    await ligarOk(UUID_A, id);
    expect((await db.try(as(UUID_A), "update public.agents set archived_at = now() where id = $1", [id])).error?.message).toMatch(/A8/);
    await db.query(as(UUID_A), "update public.agents set status = 'paused' where id = $1", [id]);
    const run = await agentRun(id, wsA, "paused");
    await db.query(as(UUID_A), "update public.agents set archived_at = now() where id = $1", [id]);
    const rows = await db.admin<{ status: string }>(
      "select status from public.research_runs where setup_agent_id = $1 or id = $2",
      [id, run],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "cancelled")).toBe(true);
  });

  test("paused_reason and next_run_at are the database's; Ligar clears the reason", async () => {
    const id = await pausedHunter(UUID_A, wsA);
    for (const col of ["paused_reason = 'daily_cap'", "next_run_at = now()"]) {
      const r = await db.try(as(UUID_A), `update public.agents set ${col} where id = $1`, [id]);
      expect((r.error as { code?: string } | undefined)?.code, col).toBe("42501");
    }
    await db.admin("update public.agents set paused_reason = 'daily_cap' where id = $1", [id]);
    const r = await db.query<{ paused_reason: string | null }>(as(UUID_A), "update public.agents set status = 'running' where id = $1 returning paused_reason", [id]);
    expect(r[0].paused_reason).toBeNull();
    const chk = await db.admin("update public.agents set paused_reason = 'nope' where id = $1", [id]).catch((e: Error) => e);
    expect((chk as Error).message).toMatch(/agents_paused_reason/);
  });

  test("one active run per agent", async () => {
    const id = await pausedHunter(UUID_A, wsA);
    const first = await agentRun(id, wsA, "ready");
    const dup = await db.admin("insert into public.research_runs (workspace_id, title, request_text, agent_id, status, plan) values ($1,'t','p',$2,'ready','{}'::jsonb)", [wsA, id]).catch((e: { code?: string }) => e);
    expect((dup as { code?: string }).code).toBe("23505");
    await db.admin("update public.research_runs set status = 'cancelled' where id = $1", [first]);
    const again = await agentRun(id, wsA, "ready");
    expect(again).toBeTruthy();
    await db.admin("update public.research_runs set status = 'cancelled' where id = $1", [again]);
    // a finished run does not count either
    await db.admin("insert into public.research_runs (workspace_id, title, request_text, agent_id, status, plan) values ($1,'t','p',$2,'ready','{}'::jsonb)", [wsA, id]);
  });

  test("an agent run is born approved by the database: creator stamps, plan required, clients cannot", async () => {
    const id = await pausedHunter(UUID_A, wsA);
    const r = await db.admin<{ status: string; created_by: string; approved_by: string; approved_at: string | null }>(
      "insert into public.research_runs (workspace_id, title, request_text, agent_id, status, plan, created_by) values ($1,'t','p',$2,'ready','{}'::jsonb,$3) returning status, created_by, approved_by, approved_at",
      [wsA, id, UUID_B],
    );
    expect(r[0]).toMatchObject({ status: "ready", created_by: UUID_A, approved_by: UUID_A });
    expect(r[0].approved_at).not.toBeNull();
    const id2 = await pausedHunter(UUID_A, wsA);
    const np = await db.admin("insert into public.research_runs (workspace_id, title, request_text, agent_id, status) values ($1,'t','p',$2,'ready')", [wsA, id2]).catch((e: Error) => e);
    expect((np as Error).message).toMatch(/P4/);
  });

  test("hunter_caps equals DEFAULT_CAPS; unknown rigor falls back to careful", async () => {
    for (const r of RIGORS) {
      const rows = await db.admin<{ c: unknown }>("select public.hunter_caps($1) as c", [r]);
      expect(rows[0].c, r).toEqual(DEFAULT_CAPS[r]);
    }
    for (const v of ["turbo", null]) {
      const rows = await db.admin<{ c: unknown }>("select public.hunter_caps($1) as c", [v]);
      expect(rows[0].c).toEqual(DEFAULT_CAPS.careful);
    }
  });

  test("deleting an agent deletes its setup research (blocker 5)", async () => {
    const id = await pausedHunter(UUID_A, wsA);
    expect(await db.admin("select id from public.research_runs where setup_agent_id = $1", [id])).toHaveLength(1);
    await db.admin("delete from public.agents where id = $1", [id]);
    expect(await db.admin("select id from public.research_runs where setup_agent_id = $1", [id])).toHaveLength(0);
  });
});
