import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, as, UUID_A, UUID_B, UUID_C } from "./helpers";
import { seedHunter } from "./hunter-seed";

// Migration 0039: run_hunter_now. PGlite, real migrations, fictional data.

const UUID_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

let db: TestDb;
let ws: string;
let wsB: string;

const call = (user: string, agent: string) => db.try(as(user), "select public.run_hunter_now($1) as r", [agent]);
const ok = async (user: string, agent: string) => (await db.query<{ r: string }>(as(user), "select public.run_hunter_now($1) as r", [agent]))[0].r;
const row = async (agent: string) =>
  (await db.admin<{ status: string; next_run_at: Date | null; paused_reason: string | null; late: boolean }>(
    "select status, next_run_at, paused_reason, next_run_at <= now() as late from public.agents where id = $1",
    [agent],
  ))[0];
const inAWeek = (agent: string) => db.admin("update public.agents set next_run_at = now() + interval '7 days' where id = $1", [agent]);

beforeAll(async () => {
  db = await TestDb.create();
  const a = await seedHunter(db, { ligar: false });
  await db.addUser(UUID_C);
  ws = a.ws;
  wsB = (await seedHunter(db, { userId: UUID_B, ligar: false })).ws;
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'closer')", [ws, UUID_C]);
});
afterAll(async () => db.pg.close());

describe("0039 run_hunter_now", () => {
  test("queued from paused: turns it on and due now", async () => {
    const { agent } = await seedHunter(db, { ws, ligar: false });
    await inAWeek(agent);
    await db.admin("update public.agents set paused_reason = 'daily_cap' where id = $1", [agent]);
    expect(await ok(UUID_A, agent)).toBe("queued");
    const r = await row(agent);
    expect(r).toMatchObject({ status: "running", late: true, paused_reason: null });
    await db.admin("update public.agents set status = 'paused' where id = $1", [agent]);
  });

  test("queued from running", async () => {
    const { agent } = await seedHunter(db, { ws });
    await inAWeek(agent);
    expect(await ok(UUID_A, agent)).toBe("queued");
    expect(await row(agent)).toMatchObject({ status: "running", late: true });
    await db.admin("update public.agents set status = 'paused' where id = $1", [agent]);
  });

  test.each(["ready", "running", "paused"])("already_running with a %s run, next_run_at unchanged", async (st) => {
    const { agent } = await seedHunter(db, { ws });
    await inAWeek(agent);
    const before = (await row(agent)).next_run_at;
    await db.admin(
      "insert into public.research_runs (workspace_id, title, request_text, region_text, rigor, agent_id, status, plan) values ($1,'t','p','r','careful',$2,'ready','{\"steps\":[]}'::jsonb)",
      [ws, agent],
    );
    if (st !== "ready") await db.admin("update public.research_runs set status = 'running' where agent_id = $1", [agent]);
    if (st === "paused") await db.admin("update public.research_runs set status = 'paused' where agent_id = $1", [agent]);
    expect(await ok(UUID_A, agent)).toBe("already_running");
    expect((await row(agent)).next_run_at).toEqual(before);
    await db.admin("update public.agents set status = 'paused' where id = $1", [agent]);
  });

  test.each(["running", "paused"])("paused agent with a %s run: already_running, agent turned on, next_run_at unchanged", async (st) => {
    const { agent } = await seedHunter(db, { ws, ligar: false });
    await inAWeek(agent);
    const before = (await row(agent)).next_run_at;
    await db.admin(
      "insert into public.research_runs (workspace_id, title, request_text, region_text, rigor, agent_id, status, plan) values ($1,'t','p','r','careful',$2,'ready','{\"steps\":[]}'::jsonb)",
      [ws, agent],
    );
    await db.admin("update public.research_runs set status = 'running' where agent_id = $1", [agent]);
    if (st === "paused") await db.admin("update public.research_runs set status = 'paused' where agent_id = $1", [agent]);
    expect(await ok(UUID_A, agent)).toBe("already_running");
    const r = await row(agent);
    expect(r.status).toBe("running");
    expect(r.next_run_at).toEqual(before);
    await db.admin("update public.agents set status = 'paused' where id = $1", [agent]);
  });

  test("too_many: 3 others running, this one stays paused", async () => {
    const other = await seedHunter(db, { userId: UUID_D, ligar: false }).then((x) => x.ws);
    for (let i = 0; i < 3; i++) await seedHunter(db, { userId: UUID_D, ws: other });
    const { agent } = await seedHunter(db, { userId: UUID_D, ws: other, ligar: false });
    expect(await ok(UUID_D, agent)).toBe("too_many");
    expect((await row(agent)).status).toBe("paused");
  });

  test("closer and other workspace are refused", async () => {
    const { agent } = await seedHunter(db, { ws, ligar: false });
    expect((await call(UUID_C, agent)).error?.message).toMatch(/not allowed/);
    expect((await call(UUID_B, agent)).error?.message).toMatch(/not allowed/);
  });

  test("draft, archived and email agent are refused", async () => {
    const draft = (await db.query<{ id: string }>(as(UUID_A), "insert into public.agents (workspace_id, type, name) values ($1,'hunter','D') returning id", [ws]))[0].id;
    expect((await call(UUID_A, draft)).error?.message).toMatch(/paused or running/);
    const { agent } = await seedHunter(db, { ws, ligar: false });
    await db.admin("update public.agents set archived_at = now() where id = $1", [agent]);
    expect((await call(UUID_A, agent)).error?.message).toMatch(/paused or running/);
    const email = (await db.query<{ id: string }>(as(UUID_A), "insert into public.agents (workspace_id, type, name) values ($1,'email','E') returning id", [ws]))[0].id;
    expect((await call(UUID_A, email)).error?.message).toMatch(/only a hunter/);
  });
});
