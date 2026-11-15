import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { TestDb, as, tryCommit } from "./helpers";
import { row, seedImport } from "./lists-seed";
import { beginTick, clock, seedHunter } from "./hunter-seed";

// Migration 0015 (F3c-3): versioned learned profiles, the run stamp, the profile match filter, coverage marks.
// PGlite, the real migrations, fictional data only.

let db: TestDb;
const code = (e: Error | undefined) => (e as (Error & { code?: string }) | undefined)?.code;

type Profile = {
  points: { key: string; text: string; rows: number[] }[];
  filter: { companyTypes: string[]; towns: string[] };
  searchQueries: string[];
};
const profile = (over: Partial<Profile> = {}): Profile => ({
  points: [
    { key: "type", text: "Construtoras de prédios multifamiliares", rows: [1, 2] },
    { key: "region", text: "Região de Worcester", rows: [1] },
  ],
  filter: { companyTypes: ["builder"], towns: ["Worcester"] },
  searchQueries: ["multifamily builder Worcester MA"],
  ...over,
});

/** A new owner with a workspace and a finished training import. */
async function seedTraining(opts: { training?: boolean } = {}) {
  const owner = randomUUID();
  await db.addUser(owner);
  const ws = (await db.query<{ id: string }>(as(owner), "select public.create_workspace('Empresa Perfil') as id"))[0].id;
  const { importId } = await seedImport(db, owner, ws, [row(1, "Alfa Obras LLC", { city: "Worcester" }), row(2, "Beta Builders Inc", { city: "Worcester" })]);
  if (opts.training !== false) await db.admin("update public.lead_imports set use_as_training = true where id = $1", [importId]);
  return { owner, ws, importId };
}

const propose = (user: string, importId: string, p: unknown = profile(), n = 2) =>
  db.try<{ id: string }>(as(user), "select public.propose_profile($1,$2::jsonb,$3) as id", [importId, JSON.stringify(p), n]);
async function proposeOk(user: string, importId: string, p: unknown = profile()): Promise<string> {
  const r = await tryCommit<{ id: string }>(db, as(user), "select public.propose_profile($1,$2::jsonb,2) as id", [importId, JSON.stringify(p)]);
  if (r.error) throw r.error;
  return r.rows[0].id;
}
const approve = (user: string, id: string, edited: unknown = null, agent: string | null = null) =>
  tryCommit<{ v: number }>(db, as(user), "select public.approve_profile($1,$2::jsonb,$3) as v", [id, edited === null ? null : JSON.stringify(edited), agent]);
const status = async (id: string) => (await db.admin<{ status: string; version: number | null }>("select status, version from public.learned_profiles where id = $1", [id]))[0];

beforeAll(async () => {
  db = await TestDb.create();
}, 120_000);
afterAll(async () => {
  await db.pg.close();
});

describe("0015 learned profiles", () => {
  test("a proposal needs a finished training import of the same workspace; clients cannot write profiles directly", async () => {
    const a = await seedTraining();
    const plain = await seedTraining({ training: false });
    const b = await seedTraining();
    // a good proposal: the original is kept, the status is proposed, no version yet
    const id = await proposeOk(a.owner, a.importId);
    const [p] = await db.admin<{ status: string; version: number | null; original: Profile; profile: Profile; sample_rows: number; created_by: string }>(
      "select status, version, original, profile, sample_rows, created_by from public.learned_profiles where id = $1",
      [id],
    );
    expect(p.status).toBe("proposed");
    expect(p.version).toBeNull();
    expect(p.original).toEqual(profile());
    expect(p.profile).toEqual(profile());
    expect(p.created_by).toBe(a.owner);
    // not a training list, not the same workspace, not finished
    expect(code((await propose(plain.owner, plain.importId)).error)).toBe("22023");
    expect(code((await propose(b.owner, a.importId)).error)).toBe("42501");
    const importing = (await db.admin<{ id: string }>("insert into public.lead_imports (workspace_id, file_name, list_name, use_as_training) values ($1,'x.csv','x',true) returning id", [a.ws]))[0].id;
    expect(code((await propose(a.owner, importing)).error)).toBe("22023");
    // a non-object profile is refused
    expect((await propose(a.owner, a.importId, [1, 2])).error).toBeDefined();
    // a closer cannot propose
    const closer = randomUUID();
    await db.addUser(closer);
    await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'closer')", [a.ws, closer]);
    expect(code((await propose(closer, a.importId)).error)).toBe("42501");
    // clients cannot write the table; the owner reads it, the closer and the other workspace do not
    for (const sql of [
      "insert into public.learned_profiles (workspace_id, profile, original, sample_rows) values ($1,'{}','{}',1)",
      "update public.learned_profiles set status = 'approved' where workspace_id = $1",
      "delete from public.learned_profiles where workspace_id = $1",
    ]) {
      const r = await db.try(as(a.owner), sql, [a.ws]);
      expect(r.error?.message, sql).toMatch(/permission denied|row-level security/);
    }
    expect(await db.query(as(a.owner), "select id from public.learned_profiles")).toHaveLength(1);
    expect(await db.query(as(closer), "select id from public.learned_profiles")).toHaveLength(0);
    expect(await db.query(as(b.owner), "select id from public.learned_profiles")).toHaveLength(0);
  });

  test("approving gives the next version, supersedes the previous one for the same target, applies the edits and keeps the original; rejected and proposed never apply; only approve applies", async () => {
    const a = await seedTraining();
    const p1 = await proposeOk(a.owner, a.importId);
    const p2 = await proposeOk(a.owner, a.importId, profile({ searchQueries: ["a"] }));
    const p3 = await proposeOk(a.owner, a.importId, profile({ searchQueries: ["b"] }));
    // nothing applies yet
    expect(await db.admin("select 1 from public.learned_profiles where status = 'approved'")).toHaveLength(0);
    // approve with edits (replace per key); the original stays
    const edited = { filter: { companyTypes: [], towns: ["Boston"] }, searchQueries: ["editada"] };
    expect((await approve(a.owner, p1, edited)).rows?.[0].v).toBe(1);
    const [row1] = await db.admin<{ profile: Profile; original: Profile; approved_by: string; approved_at: string | null }>("select profile, original, approved_by, approved_at from public.learned_profiles where id = $1", [p1]);
    expect(row1.profile.filter).toEqual(edited.filter);
    expect(row1.profile.searchQueries).toEqual(["editada"]);
    expect(row1.profile.points).toEqual(profile().points);
    expect(row1.original).toEqual(profile());
    expect(row1.approved_by).toBe(a.owner);
    expect(row1.approved_at).not.toBeNull();
    // the next approval for the same target (every hunter) is version 2 and supersedes version 1
    expect((await approve(a.owner, p2)).rows?.[0].v).toBe(2);
    expect(await status(p1)).toEqual({ status: "superseded", version: 1 });
    expect(await status(p2)).toEqual({ status: "approved", version: 2 });
    // another target (one hunter) does not supersede it
    const hunter = await seedHunter(db, { userId: a.owner, ws: a.ws });
    expect((await approve(a.owner, p3, null, hunter.agent)).rows?.[0].v).toBe(3);
    expect(await status(p2)).toEqual({ status: "approved", version: 2 });
    // a second approve of the same row fails and keeps its version
    expect((await approve(a.owner, p3)).error).toBeDefined();
    expect(await status(p3)).toEqual({ status: "approved", version: 3 });
    // reject: only from proposed, never applies; an unknown key is 22023; a closer, 42501
    const p4 = await proposeOk(a.owner, a.importId);
    expect(code((await approve(a.owner, p4, { points: [], mystery: 1 })).error)).toBe("22023");
    expect(await status(p4)).toEqual({ status: "proposed", version: null });
    const closer = randomUUID();
    await db.addUser(closer);
    await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'closer')", [a.ws, closer]);
    expect(code((await approve(closer, p4)).error)).toBe("42501");
    expect(code((await tryCommit(db, as(closer), "select public.reject_profile($1)", [p4])).error)).toBe("42501");
    await db.query(as(a.owner), "select public.reject_profile($1)", [p4]);
    expect(await status(p4)).toEqual({ status: "rejected", version: null });
    expect((await approve(a.owner, p4)).error).toBeDefined();
    expect((await tryCommit(db, as(a.owner), "select public.reject_profile($1)", [p3])).error).toBeDefined();
    // p_agent must be a hunter of the workspace
    const other = await seedHunter(db, { userId: randomUUID() });
    const p5 = await proposeOk(a.owner, a.importId);
    expect(code((await approve(a.owner, p5, null, other.agent)).error)).toBe("22023");
    // the other workspace's owner cannot approve it
    expect(code((await approve(other.ws === a.ws ? a.owner : (await db.admin<{ user_id: string }>("select user_id from public.workspace_members where workspace_id = $1", [other.ws]))[0].user_id, p5)).error)).toBe("42501");
  });

  test("K-7 a new Caçador run records the approved version and its hints; a one-off run and an unapproved profile stamp nothing", async () => {
    const owner = randomUUID();
    const h = await seedHunter(db, { userId: owner });
    const { importId } = await seedImport(db, owner, h.ws, [row(1, "Gama Obras LLC", { city: "Worcester" })]);
    await db.admin("update public.lead_imports set use_as_training = true where id = $1", [importId]);
    const tick = await beginTick(db);
    const due = () => db.query(clock, "select public.hunter_due_work($1)", [tick]);
    const newRun = async () => {
      await db.admin("update public.agents set next_run_at = now() - interval '1 minute' where id = $1", [h.agent]);
      await db.admin("update public.research_runs set status = 'cancelled' where agent_id = $1 and status in ('ready','running','paused')", [h.agent]);
      await due();
      return (await db.admin<{ id: string; profile_id: string | null; profile_hints: { version: number; lines: string[]; queries: string[] } | null }>(
        "select id, profile_id, profile_hints from public.research_runs where agent_id = $1 order by created_at desc, id desc limit 1", [h.agent]))[0];
    };
    // a run created before any approval keeps null
    const r0 = await newRun();
    expect(r0.profile_id).toBeNull();
    expect(r0.profile_hints).toBeNull();
    // a proposal alone changes nothing
    const p1 = await proposeOk(owner, importId);
    const r1 = await newRun();
    expect(r1.profile_id).toBeNull();
    // approve for every hunter: the next run records version and hints
    await approve(owner, p1);
    const r2 = await newRun();
    expect(r2.profile_id).toBe(p1);
    expect(r2.profile_hints).toEqual({
      version: 1,
      lines: ["type: Construtoras de prédios multifamiliares", "region: Região de Worcester"],
      queries: ["multifamily builder Worcester MA"],
    });
    // the one-off run (no agent) and the setup run stamp nothing; the earlier run keeps null
    const oneOff = await db.query<{ profile_id: string | null; profile_hints: unknown }>(
      as(owner), "insert into public.research_runs (workspace_id, title, request_text, region_text, rigor) values ($1,'t','pedido','Worcester, MA','careful') returning profile_id, profile_hints", [h.ws]);
    expect(oneOff[0]).toEqual({ profile_id: null, profile_hints: null });
    expect((await db.admin<{ profile_id: string | null }>("select profile_id from public.research_runs where id = $1", [h.setupRun]))[0].profile_id).toBeNull();
    expect((await db.admin<{ profile_id: string | null }>("select profile_id from public.research_runs where id = $1", [r0.id]))[0].profile_id).toBeNull();
    // an agent-specific profile beats the all-hunters one; the run in flight keeps what it started with
    const p2 = await proposeOk(owner, importId, profile({ points: [{ key: "signals", text: "Obra nova", rows: [1] }], searchQueries: [] }));
    await approve(owner, p2, null, h.agent);
    expect((await db.admin<{ profile_id: string }>("select profile_id from public.research_runs where id = $1", [r2.id]))[0].profile_id).toBe(p1);
    const r3 = await newRun();
    expect(r3.profile_id).toBe(p2);
    expect(r3.profile_hints).toEqual({ version: 2, lines: ["signals: Obra nova"], queries: [] });
    // the run reads its stamp through hunter_get_run
    const got = (await db.query<{ r: { profile_id: string; profile_hints: { version: number } } }>(clock, "select public.hunter_get_run($1,$2) as r", [tick, r3.id]))[0].r;
    expect(got.profile_id).toBe(p2);
    expect(got.profile_hints.version).toBe(2);
    // a stamp cannot be rewritten by a client
    const w = await db.try(as(owner), "update public.research_runs set profile_id = null where id = $1", [r3.id]);
    expect(w.error?.message ?? "").toMatch(/permission denied|row-level security/);
  });

  test("K-11 profile match is a filter: company type and town, both required when both set; an empty filter matches nothing; approving refreshes the queue and a new city refreshes one lead", async () => {
    const a = await seedTraining();
    const mkLead = async (fields: [string, string, string?][]) => {
      const lead = (await db.admin<{ id: string }>("insert into public.leads (workspace_id, origin_kind) values ($1,'import') returning id", [a.ws]))[0].id;
      let i = 0;
      for (const [field, value, st] of fields) {
        await db.admin("insert into public.lead_fields (workspace_id, lead_id, field, value, source, source_ref, status) values ($1,$2,$3,$4,'import',$5,$6)", [a.ws, lead, field, value, `m-${lead}-${i++}`, st ?? "unverified"]);
      }
      return lead;
    };
    const match = async (lead: string) => (await db.admin<{ profile_match: boolean }>("select profile_match from public.qualifier_queue where lead_id = $1", [lead]))[0].profile_match;
    const both = await mkLead([["city", " WORCESTER "], ["company_type", "Builder"]]);
    const wrongType = await mkLead([["city", "Worcester"], ["company_type", "developer"]]);
    const wrongTown = await mkLead([["city", "Boston, MA"], ["company_type", "builder"]]);
    const onlyTown = await mkLead([["city", "Worcester"]]);
    const refuted = await mkLead([["city", "Worcester", "refuted"], ["company_type", "builder"]]);
    const bare = await mkLead([]);
    const all = [both, wrongType, wrongTown, onlyTown, refuted, bare];
    // nothing approved: nobody matches
    for (const l of all) expect(await match(l)).toBe(false);
    // a proposal alone does not apply
    const p1 = await proposeOk(a.owner, a.importId); // builder + Worcester
    for (const l of all) expect(await match(l)).toBe(false);
    await approve(a.owner, p1);
    expect(await Promise.all(all.map(match))).toEqual([true, false, false, false, false, false]);
    // a town-only filter: the type no longer matters
    const p2 = await proposeOk(a.owner, a.importId, profile({ filter: { companyTypes: [], towns: ["worcester", "Boston"] } }));
    await approve(a.owner, p2);
    expect(await Promise.all(all.map(match))).toEqual([true, true, true, true, false, false]);
    // a new city on a lead refreshes that lead only (the others are untouched even if flipped by hand)
    await db.admin("update public.qualifier_queue set profile_match = false where lead_id = $1", [both]);
    await db.admin("insert into public.lead_fields (workspace_id, lead_id, field, value, source, source_ref) values ($1,$2,'city','Boston','import','late')", [a.ws, bare]);
    expect(await match(bare)).toBe(true);
    expect(await match(both)).toBe(false);
    // an empty filter (or only junk) matches nothing, and it is the newest profile, so it wins
    const p3 = await proposeOk(a.owner, a.importId, profile({ filter: { companyTypes: [], towns: [] } }));
    await approve(a.owner, p3);
    for (const l of all) expect(await match(l)).toBe(false);
    const f = await db.admin<{ m: boolean }>("select public.lead_matches_profile($1, '{}'::jsonb) as m", [both]);
    expect(f[0].m).toBe(false);
    // the function is internal
    expect((await db.try(as(a.owner), "select public.refresh_profile_match($1)", [a.ws])).error?.message).toMatch(/permission denied/);
    expect((await db.try(as(a.owner), "select public.lead_matches_profile($1,'{}'::jsonb)", [both])).error?.message).toMatch(/permission denied/);
  });
});

describe("0015 coverage marks", () => {
  test("coverage marks: owner and sdr add and remove; the closer and another workspace cannot; no future date", async () => {
    const a = await seedTraining();
    const sdr = randomUUID();
    const closer = randomUUID();
    await db.addUser(sdr);
    await db.addUser(closer);
    await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr'), ($1,$3,'closer')", [a.ws, sdr, closer]);
    const other = await seedTraining();
    const ins = (user: string, ws: string, town = "Barnstable", county = "Barnstable", date = "2026-01-10") =>
      tryCommit<{ id: string; created_by: string }>(db, as(user), "insert into public.coverage_marks (workspace_id, town, county, note, searched_at) values ($1,$2,$3,'fora do app',$4) returning id, created_by", [ws, town, county, date]);
    const m1 = await ins(a.owner, a.ws);
    expect(m1.error).toBeUndefined();
    expect(m1.rows?.[0].created_by).toBe(a.owner);
    const m2 = await ins(sdr, a.ws, "Worcester", "Worcester");
    expect(m2.error).toBeUndefined();
    expect(m2.rows?.[0].created_by).toBe(sdr);
    // the closer and another workspace cannot add or read
    expect((await ins(closer, a.ws)).error?.message).toMatch(/row-level security/);
    expect((await ins(other.owner, a.ws)).error?.message).toMatch(/row-level security/);
    expect(await db.query(as(closer), "select id from public.coverage_marks")).toHaveLength(0);
    expect(await db.query(as(other.owner), "select id from public.coverage_marks")).toHaveLength(0);
    expect(await db.query(as(sdr), "select id from public.coverage_marks")).toHaveLength(2);
    // created_by cannot be forged, a future date and bad text are refused
    expect((await db.try(as(a.owner), "insert into public.coverage_marks (workspace_id, town, county, searched_at, created_by) values ($1,'X','Y','2026-01-01',$2)", [a.ws, sdr])).error?.message).toMatch(/permission denied/);
    expect((await ins(a.owner, a.ws, "Boston", "Suffolk", "2999-01-01")).error).toBeDefined();
    expect((await ins(a.owner, a.ws, "", "Suffolk")).error).toBeDefined();
    // remove: the closer and another workspace delete nothing; sender does
    await db.query(as(closer), "delete from public.coverage_marks where id = $1", [m1.rows![0].id]);
    await db.query(as(other.owner), "delete from public.coverage_marks where id = $1", [m1.rows![0].id]);
    expect(await db.admin("select 1 from public.coverage_marks")).toHaveLength(2);
    await db.query(as(sdr), "delete from public.coverage_marks where id = $1", [m1.rows![0].id]);
    await db.query(as(a.owner), "delete from public.coverage_marks where id = $1", [m2.rows![0].id]);
    expect(await db.admin("select 1 from public.coverage_marks")).toHaveLength(0);
    // no update at all
    const m3 = await ins(a.owner, a.ws);
    expect((await db.try(as(a.owner), "update public.coverage_marks set note = 'x' where id = $1", [m3.rows![0].id])).error?.message).toMatch(/permission denied/);
  });
});
