import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, anon, as } from "./helpers";

// Migration 0035: the Home's "Ligar primeiro" rule, one row per user and workspace (PGlite, real migrations, fictional data).

let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create();
});
afterAll(async () => {
  await db.pg.close();
});

async function seedTeam() {
  const [owner, sdr] = [randomUUID(), randomUUID()];
  for (const u of [owner, sdr]) await db.addUser(u);
  const ws = (await db.query<{ id: string }>(as(owner), "select public.create_workspace('Empresa Home') as id"))[0].id;
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr')", [ws, sdr]);
  return { ws, owner, sdr };
}

describe("0035 home_rules", () => {
  test("each user reads and writes only their own rule; upsert replaces it", async () => {
    const t = await seedTeam();
    const ins = "insert into public.home_rules (workspace_id, rule) values ($1,$2::jsonb)";
    await db.query(as(t.sdr), ins, [t.ws, JSON.stringify({ segments: ["large"], order: "newest" })]);
    expect(await db.query(as(t.sdr), "select rule->>'order' as o from public.home_rules")).toEqual([{ o: "newest" }]);
    expect(await db.query(as(t.owner), "select * from public.home_rules")).toEqual([]);
    // the app saves with an upsert on (workspace_id, user_id), user_id left to its default
    await db.query(as(t.sdr), `${ins} on conflict (workspace_id, user_id) do update set rule = excluded.rule, updated_at = excluded.updated_at`, [t.ws, JSON.stringify({ order: "hottest" })]);
    expect(await db.query(as(t.sdr), "select rule->>'order' as o from public.home_rules")).toEqual([{ o: "hottest" }]);
    // the owner cannot touch the sdr's row, nor write one in her name
    expect(await db.query(as(t.owner), "update public.home_rules set rule = '{}'::jsonb where user_id = $1 returning 1", [t.sdr])).toEqual([]);
    expect((await db.try(as(t.owner), "insert into public.home_rules (workspace_id, user_id, rule) values ($1,$2,'{}'::jsonb)", [t.ws, t.sdr])).error).toBeDefined();
    // one row per user and workspace
    expect((await db.try(as(t.sdr), ins, [t.ws, "{}"])).error).toBeDefined();
  });
  test("a rule must be an object; outsiders and anon get nothing", async () => {
    const t = await seedTeam();
    expect((await db.try(as(t.sdr), "insert into public.home_rules (workspace_id, rule) values ($1,'[1]'::jsonb)", [t.ws])).error).toBeDefined();
    const outsider = randomUUID();
    await db.addUser(outsider);
    expect((await db.try(as(outsider), "insert into public.home_rules (workspace_id, rule) values ($1,'{}'::jsonb)", [t.ws])).error).toBeDefined();
    expect((await db.try(anon, "select * from public.home_rules")).error).toBeDefined();
  });
});
