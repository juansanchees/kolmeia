import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, anon, as } from "./helpers";

// Migration 0030: leads.archived_at / leads.segment, written only through two sender-only RPCs. Fictional data only.
let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create();
});
afterAll(async () => {
  await db.pg.close();
});

async function seedTeam() {
  const [owner, sdr, closer] = [randomUUID(), randomUUID(), randomUUID()];
  for (const u of [owner, sdr, closer]) await db.addUser(u);
  const ws = (await db.query<{ id: string }>(as(owner), "select public.create_workspace('Empresa F7') as id"))[0].id;
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr'), ($1,$3,'closer')", [ws, sdr, closer]);
  return { ws, owner, sdr, closer };
}
const newLead = async (ws: string, status = "new") =>
  (await db.admin<{ id: string }>("insert into public.leads (workspace_id, origin_kind, status, level) values ($1,'import',$2,2) returning id", [ws, status]))[0].id;
const rowOf = (id: string) =>
  db.admin<{ archived_at: string | null; segment: string | null; status: string; level: number }>("select archived_at, segment, status, level from public.leads where id = $1", [id]).then((r) => r[0]);
const archive = (user: string, ws: string, ids: string[], on: boolean) =>
  db.query<{ n: number }>(as(user), "select public.set_leads_archived($1,$2::uuid[],$3) as n", [ws, ids, on]).then((r) => r[0].n);
const segment = (user: string, ws: string, ids: string[], seg: string | null) =>
  db.query<{ n: number }>(as(user), "select public.set_leads_segment($1,$2::uuid[],$3) as n", [ws, ids, seg]).then((r) => r[0].n);

describe("0030 archive and segment", () => {
  test("sdr archives: only archived_at changes; status, level and list membership stay", async () => {
    const t = await seedTeam();
    const l = await newLead(t.ws, "replied");
    const list = (await db.admin<{ id: string }>("insert into public.lists (workspace_id, name) values ($1,'Lista X') returning id", [t.ws]))[0].id;
    await db.admin("insert into public.list_leads (list_id, lead_id, workspace_id) values ($1,$2,$3)", [list, l, t.ws]);
    expect(await archive(t.sdr, t.ws, [l], true)).toBe(1);
    const r = await rowOf(l);
    expect(r.archived_at).not.toBeNull();
    expect(r.status).toBe("replied");
    expect(r.level).toBe(2);
    expect((await db.admin("select 1 from public.list_leads where lead_id = $1", [l])).length).toBe(1);
    const at = r.archived_at;
    expect(await archive(t.sdr, t.ws, [l], true)).toBe(0);
    expect((await rowOf(l)).archived_at).toEqual(at);
    expect(await archive(t.sdr, t.ws, [l], false)).toBe(1);
    const back = await rowOf(l);
    expect(back.archived_at).toBeNull();
    expect(back.status).toBe("replied");
  });

  test("closer and anon cannot archive or set segment (42501)", async () => {
    const t = await seedTeam();
    const l = await newLead(t.ws);
    await expect(archive(t.closer, t.ws, [l], true)).rejects.toThrow(/sender|42501|permission/i);
    await expect(segment(t.closer, t.ws, [l], "large")).rejects.toThrow();
    await expect(db.query(anon, "select public.set_leads_archived($1,$2::uuid[],true)", [t.ws, [l]])).rejects.toThrow();
    await expect(db.query(anon, "select public.set_leads_segment($1,$2::uuid[],'large')", [t.ws, [l]])).rejects.toThrow();
    expect((await rowOf(l)).archived_at).toBeNull();
  });

  test("another workspace's ids are ignored (returns 0)", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    const l = await newLead(b.ws);
    expect(await archive(a.sdr, a.ws, [l], true)).toBe(0);
    expect(await segment(a.sdr, a.ws, [l], "large")).toBe(0);
    expect(await rowOf(l)).toMatchObject({ archived_at: null, segment: null });
  });

  test("set_leads_segment: 'large' sets, null clears, 'huge' fails 22023", async () => {
    const t = await seedTeam();
    const l = await newLead(t.ws);
    expect(await segment(t.sdr, t.ws, [l], "large")).toBe(1);
    expect((await rowOf(l)).segment).toBe("large");
    expect(await segment(t.sdr, t.ws, [l], "large")).toBe(0);
    expect(await segment(t.sdr, t.ws, [l], null)).toBe(1);
    expect((await rowOf(l)).segment).toBeNull();
    await expect(segment(t.sdr, t.ws, [l], "huge")).rejects.toThrow(/segment/i);
  });

  test("more than 5000 ids fail 22023", async () => {
    const t = await seedTeam();
    const ids = Array.from({ length: 5001 }, () => randomUUID());
    await expect(archive(t.sdr, t.ws, ids, true)).rejects.toThrow(/5000/);
    await expect(segment(t.sdr, t.ws, ids, "small")).rejects.toThrow(/5000/);
  });

  test("clients still cannot update leads directly", async () => {
    const t = await seedTeam();
    const l = await newLead(t.ws);
    await expect(db.query(as(t.sdr), "update public.leads set archived_at = now() where id = $1", [l])).rejects.toThrow(/permission denied/);
  });
});
