import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, as, UUID_A, UUID_B, UUID_C } from "./helpers";

// Regression tests for the 10/11/2026 security review (defects 1-4 + missing cases).
// A = attacker/owner of wsX, V = victim with their own workspace, M = plain member of wsX.

const UUID_V = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DENIED = /permission denied/;
const RLS = /row-level security/;
const PROFILE = `(workspace_id, what_we_do, service_area, wanted_work, good_customer, not_wanted)`;
const ACTIVE_WS_SQL = `select workspace_id from public.workspace_members where user_id = $1 order by created_at, workspace_id limit 1`;

let db: TestDb;
let wsX: string; // owned by A, M is a member
let wsV: string; // owned by V

async function create(userId: string, name: string): Promise<string> {
  const rows = await db.query<{ create_workspace: string }>(as(userId), "select public.create_workspace($1)", [name]);
  return rows[0].create_workspace;
}
const activeOf = async (userId: string) =>
  (await db.query<{ workspace_id: string }>(as(userId), ACTIVE_WS_SQL, [userId]))[0]?.workspace_id;

beforeAll(async () => {
  db = await TestDb.create();
  for (const id of [UUID_A, UUID_B, UUID_C, UUID_V]) await db.addUser(id);
  wsV = await create(UUID_V, "Victim Co");
  wsX = await create(UUID_A, "Attacker Co");
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr')", [wsX, UUID_C]);
});
afterAll(async () => {
  await db.pg.close();
});

describe("defect 1: owner cannot write other users into their workspace or hijack the active workspace", () => {
  for (const role of ["owner", "sdr", "closer"]) {
    test(`insert victim as ${role}, with and without created_at`, async () => {
      for (const sql of [
        `insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'${role}')`,
        `insert into public.workspace_members (workspace_id, user_id, role, created_at) values ($1,$2,'${role}','1970-01-01')`,
        `insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'${role}') returning user_id`,
      ]) {
        const r = await db.try(as(UUID_A), sql, [wsX, UUID_V]);
        expect(r.error?.message, sql).toMatch(DENIED);
      }
    });
  }

  test("owner cannot update user_id, workspace_id or created_at of any member row", async () => {
    for (const [sql, params] of [
      ["update public.workspace_members set user_id = $2 where workspace_id = $1", [wsX, UUID_V]],
      ["update public.workspace_members set workspace_id = $2 where workspace_id = $1", [wsX, wsV]],
      ["update public.workspace_members set created_at = '1970-01-01' where workspace_id = $1", [wsX]],
    ] as const) {
      const r = await db.try(as(UUID_A), sql, [...params]);
      expect(r.error?.message, sql).toMatch(DENIED);
    }
  });

  test("owner can still change the role of a member (the only updatable column)", async () => {
    const r = await db.try(as(UUID_A), "update public.workspace_members set role = 'closer' where workspace_id = $1 and user_id = $2 returning role", [wsX, UUID_C]);
    expect(r.rows).toHaveLength(1);
  });

  test("after all attempts the victim's active workspace is still their own", async () => {
    expect(await activeOf(UUID_V)).toBe(wsV);
    const mine = await db.query(as(UUID_V), "select 1 from public.workspace_members where workspace_id = $1", [wsX]);
    expect(mine).toHaveLength(0);
  });

  test("the active-workspace query cannot be influenced by another user's writes", async () => {
    // A (owner of wsX) does everything it still can to V's rows: nothing reaches V's memberships.
    await db.try(as(UUID_A), "update public.workspace_members set role = 'sdr' where user_id = $1", [UUID_V]);
    await db.try(as(UUID_A), "delete from public.workspace_members where user_id = $1", [UUID_V]);
    expect(await activeOf(UUID_V)).toBe(wsV);
    expect(await db.query(as(UUID_A), ACTIVE_WS_SQL.replace("limit 1", ""), [UUID_V])).toHaveLength(0); // A cannot even see V's row
  });

  test("ordering is deterministic: equal created_at falls back to workspace_id", async () => {
    const lo = "00000000-0000-4000-8000-000000000001";
    const hi = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await db.admin("insert into public.workspaces (id, name, created_by) values ($1,'lo',$3),($2,'hi',$3)", [lo, hi, UUID_B]);
    await db.admin("update public.workspace_members set created_at = '2000-01-01'");
    expect(await activeOf(UUID_B)).toBe(lo);
  });
});

describe("defect 2: immutable columns", () => {
  test("owner cannot change workspaces.created_by, id or created_at; can rename", async () => {
    for (const [sql, params] of [
      ["update public.workspaces set created_by = $2 where id = $1", [wsX, UUID_V]],
      ["update public.workspaces set id = gen_random_uuid() where id = $1", [wsX]],
      ["update public.workspaces set created_at = '1970-01-01' where id = $1", [wsX]],
    ] as const) {
      const r = await db.try(as(UUID_A), sql, [...params]);
      expect(r.error?.message, sql).toMatch(DENIED);
    }
    const ok = await db.try(as(UUID_A), "update public.workspaces set name = 'Renamed' where id = $1 returning id", [wsX]);
    expect(ok.rows).toHaveLength(1);
  });

  test("nobody can insert into workspaces directly, with or without returning", async () => {
    for (const sql of [
      "insert into public.workspaces (name, created_by) values ('x', $1)",
      "insert into public.workspaces (name, created_by) values ('x', $1) returning id",
    ]) {
      const r = await db.try(as(UUID_A), sql, [UUID_A]);
      expect(r.error?.message, sql).toMatch(DENIED);
    }
  });

  test("the RPC still works and still rejects blank / too-long / null names", async () => {
    const r = await db.try<{ create_workspace: string }>(as(UUID_B), "select public.create_workspace('  Ok  ')");
    expect(r.rows).toHaveLength(1);
    for (const [sql, params] of [
      ["select public.create_workspace('   ')", []],
      ["select public.create_workspace($1)", ["x".repeat(81)]],
      ["select public.create_workspace(null)", []],
    ] as const) {
      expect((await db.try(as(UUID_B), sql, [...params])).error, sql).toBeDefined();
    }
  });

  test("a member cannot set updated_by / updated_at on a profile (insert or update)", async () => {
    for (const [sql, params] of [
      [`insert into public.company_profiles (workspace_id, updated_by) values ($1, $2)`, [wsX, UUID_V]],
      [`insert into public.company_profiles (workspace_id, updated_at) values ($1, '1970-01-01')`, [wsX]],
    ] as const) {
      expect((await db.try(as(UUID_C), sql, [...params])).error?.message, sql).toMatch(DENIED);
    }
    await db.query(as(UUID_C), `insert into public.company_profiles ${PROFILE} values ($1,'a','b','{}','c','d')`, [wsX]);
    for (const [sql, params] of [
      ["update public.company_profiles set updated_by = $2 where workspace_id = $1", [wsX, UUID_V]],
      ["update public.company_profiles set updated_at = '1970-01-01' where workspace_id = $1", [wsX]],
      ["update public.company_profiles set workspace_id = $2 where workspace_id = $1", [wsX, UUID_V]],
    ] as const) {
      expect((await db.try(as(UUID_C), sql, [...params])).error?.message, sql).toMatch(DENIED);
    }
  });

  test("the app's save path works for a member: update (content columns) then insert when missing", async () => {
    const upd = "update public.company_profiles set what_we_do=$2, service_area='MA', wanted_work='{commercial}', good_customer='g', not_wanted='n' where workspace_id=$1 returning workspace_id, updated_by";
    const first = await db.try(as(UUID_C), upd, [wsV, "x"]);
    expect(first.rows).toHaveLength(0); // not a member of wsV: nothing happens
    const ins = await db.query<{ updated_by: string }>(as(UUID_V), `insert into public.company_profiles ${PROFILE} values ($1,'a','b','{maintenance}','c','d') returning updated_by`, [wsV]);
    expect(ins[0].updated_by).toBe(UUID_V);
    const again = await db.try<{ updated_by: string }>(as(UUID_V), upd, [wsV, "novo"]);
    expect(again.rows).toHaveLength(1);
    expect(again.rows![0].updated_by).toBe(UUID_V);
  });

  test("upsert (insert ... on conflict) into another workspace's profile is rejected", async () => {
    await db.query(as(UUID_V), "insert into public.company_profiles (workspace_id) values ($1) on conflict do nothing", [wsV]);
    const r = await db.try(
      as(UUID_A),
      `insert into public.company_profiles ${PROFILE} values ($1,'hack','b','{}','c','d')
       on conflict (workspace_id) do update set what_we_do = excluded.what_we_do`,
      [wsV],
    );
    expect(r.error?.message).toMatch(RLS);
    const stored = await db.admin<{ what_we_do: string }>("select what_we_do from public.company_profiles where workspace_id = $1", [wsV]);
    expect(stored[0].what_we_do).not.toBe("hack");
  });
});

describe("defect 3: a workspace keeps at least one owner", () => {
  let ws: string;
  beforeAll(async () => {
    ws = await create(UUID_V, "Last owner test");
    await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr')", [ws, UUID_C]);
  });

  test("sole owner cannot demote themselves", async () => {
    const r = await db.try(as(UUID_V), "update public.workspace_members set role = 'sdr' where workspace_id = $1 and user_id = $2", [ws, UUID_V]);
    expect(r.error?.message).toMatch(/last owner/);
  });
  test("sole owner cannot delete their own membership", async () => {
    const r = await db.try(as(UUID_V), "delete from public.workspace_members where workspace_id = $1 and user_id = $2", [ws, UUID_V]);
    expect(r.error?.message).toMatch(/last owner/);
  });
  test("sole owner cannot remove all members in one statement", async () => {
    const r = await db.try(as(UUID_V), "delete from public.workspace_members where workspace_id = $1", [ws]);
    expect(r.error?.message).toMatch(/last owner/);
  });
  test("with two owners, one can be demoted and one removed", async () => {
    await db.admin("update public.workspace_members set role = 'owner' where workspace_id = $1 and user_id = $2", [ws, UUID_C]);
    // (each try is rolled back, so both owners are still there for the next statement)
    const demote = await db.try(as(UUID_V), "update public.workspace_members set role = 'sdr' where workspace_id = $1 and user_id = $2 returning user_id", [ws, UUID_V]);
    expect(demote.rows).toHaveLength(1);
    const remove = await db.try(as(UUID_V), "delete from public.workspace_members where workspace_id = $1 and user_id = $2 returning user_id", [ws, UUID_C]);
    expect(remove.rows).toHaveLength(1);
  });
  test("two owners cannot both be removed at once", async () => {
    const r = await db.try(as(UUID_V), "delete from public.workspace_members where workspace_id = $1 and role = 'owner'", [ws]);
    expect(r.error?.message).toMatch(/last owner/);
  });
  test("an owner can still delete the whole workspace; members and profile rows disappear", async () => {
    await db.query(as(UUID_V), `insert into public.company_profiles ${PROFILE} values ($1,'a','b','{}','c','d')`, [ws]);
    const del = await db.query(as(UUID_V), "delete from public.workspaces where id = $1 returning id", [ws]);
    expect(del).toHaveLength(1);
    expect(await db.admin("select 1 from public.workspace_members where workspace_id = $1", [ws])).toHaveLength(0);
    expect(await db.admin("select 1 from public.company_profiles where workspace_id = $1", [ws])).toHaveLength(0);
  });
});

describe("defect 4: deleting auth users", () => {
  test("a non-sole member is removed and created_by / updated_by become null", async () => {
    const ws = await create(UUID_B, "B ws");
    await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'owner')", [ws, UUID_C]); // second owner
    await db.query(as(UUID_C), `insert into public.company_profiles ${PROFILE} values ($1,'a','b','{}','c','d')`, [ws]);
    const wsC = await create(UUID_C, "C ws"); // created_by = C, then B joins so C is not the sole owner
    await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'owner')", [wsC, UUID_B]);

    await db.admin("delete from auth.users where id = $1", [UUID_C]);

    expect(await db.admin("select 1 from public.workspace_members where user_id = $1", [UUID_C])).toHaveLength(0);
    const w = await db.admin<{ created_by: string | null }>("select created_by from public.workspaces where id = $1", [wsC]);
    expect(w).toEqual([{ created_by: null }]);
    const p = await db.admin<{ updated_by: string | null }>("select updated_by from public.company_profiles where workspace_id = $1", [ws]);
    expect(p).toEqual([{ updated_by: null }]);
  });

  test("deleting the sole owner is rejected with the last-owner error", async () => {
    const u = "99999999-9999-4999-8999-999999999999";
    await db.addUser(u);
    await create(u, "Solo");
    const r = await db.admin("delete from auth.users where id = $1", [u]).then(() => null, (e: Error) => e);
    expect(r?.message).toMatch(/last owner/);
    expect(await db.admin("select 1 from auth.users where id = $1", [u])).toHaveLength(1);
  });
});
