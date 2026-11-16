import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MIGRATION_PATHS, TestDb, anon, as, setSchedulerToken } from "./helpers";
import { beginTick, clock } from "./hunter-seed";
import { TOKEN } from "./scheduler-seed";

// Migration 0032: results proposals (source 'results'), the 'avoid' point key, and the two doors (sender session and the
// Caçador clock). Fictional data only.
let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create();
});
afterAll(async () => {
  await db.pg.close();
});

const PROFILE = {
  points: [
    { key: "type", text: "Construtoras de prédios", rows: [1, 2] },
    { key: "avoid", text: "Reformas pequenas de casas", rows: [41] },
  ],
  filter: { companyTypes: ["builder"], towns: ["Worcester"] },
  searchQueries: ["multifamily builders Worcester MA"],
};

async function seedTeam() {
  const [owner, sdr, closer] = [randomUUID(), randomUUID(), randomUUID()];
  for (const u of [owner, sdr, closer]) await db.addUser(u);
  const ws = (await db.query<{ id: string }>(as(owner), "select public.create_workspace('Empresa F7') as id"))[0].id;
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr'), ($1,$3,'closer')", [ws, sdr, closer]);
  return { ws, owner, sdr, closer };
}
const newLead = async (ws: string, status: string) =>
  (await db.admin<{ id: string }>("insert into public.leads (workspace_id, origin_kind, status, level) values ($1,'import',$2,2) returning id", [ws, status]))[0].id;
const addField = (ws: string, lead: string, field: string, value: string) =>
  db.admin("insert into public.lead_fields (workspace_id, lead_id, field, value, source) values ($1,$2,$3,$4,'import')", [ws, lead, field, value]);

type Data = { last_at: string | null; open_id: string | null; current: unknown; rows: { lead_id: string; status: string; interested: boolean; name: string | null; city: string | null; note: string | null }[] };
const rowsAs = (user: string, ws: string) => db.query<{ r: Data }>(as(user), "select public.results_learning_rows($1) as r", [ws]).then((r) => r[0].r);
const propose = (user: string, ws: string, p: unknown = PROFILE, n = 20) =>
  db.query<{ id: string }>(as(user), "select public.propose_results_profile($1,$2::jsonb,$3) as id", [ws, JSON.stringify(p), n]).then((r) => r[0].id);

describe("0032 learning loop", () => {
  test("the sender reads the leads with a result; the closer and anon cannot", async () => {
    const t = await seedTeam();
    const won = await newLead(t.ws, "won");
    const lost = await newLead(t.ws, "lost");
    await newLead(t.ws, "new");
    await newLead(t.ws, "call_list");
    await addField(t.ws, won, "name", "Acme Builders");
    await addField(t.ws, won, "city", "Worcester");
    await db.admin("update public.leads set status = 'call_list' where id = $1", [lost]);
    await db.admin("update public.leads set status = 'lost' where id = $1", [lost]);
    const d = await rowsAs(t.sdr, t.ws);
    expect(d.rows.map((r) => r.status).sort()).toEqual(["lost", "won"]);
    expect(d.rows.find((r) => r.lead_id === won)).toMatchObject({ name: "Acme Builders", city: "Worcester", interested: false });
    expect(d).toMatchObject({ last_at: null, open_id: null, current: null });
    await expect(rowsAs(t.closer, t.ws)).rejects.toThrow(/sender/);
    await expect(db.query(anon, "select public.results_learning_rows($1)", [t.ws])).rejects.toThrow();
    const other = await seedTeam();
    await expect(rowsAs(other.owner, t.ws)).rejects.toThrow(/sender/);
  });

  test("an interested reply counts on an open lead, not on a lost one; the last call note comes along", async () => {
    const t = await seedTeam();
    const camp = (await db.admin<{ id: string }>("insert into public.email_campaigns (workspace_id, name) values ($1,'Campanha') returning id", [t.ws]))[0].id;
    const reply = async (lead: string, key: string) => {
      const p = (await db.admin<{ id: string }>(
        "insert into public.email_prospects (workspace_id, campaign_id, lead_id, company_name, email, email_source) values ($1,$2,$3,'Company',$4,'manual') returning id",
        [t.ws, camp, lead, `pat${key}@company.example`],
      ))[0].id;
      await db.admin(
        "insert into public.email_replies (workspace_id, campaign_id, prospect_id, from_address, subject, body_text, received_at, rfc_message_id, classification) values ($1,$2,$3,'pat@company.example','Re','yes',now(),$4,'interested')",
        [t.ws, camp, p, `<r-${key}@mail.example>`],
      );
    };
    const open = await newLead(t.ws, "replied");
    const gone = await newLead(t.ws, "replied");
    await reply(open, "a");
    await reply(gone, "b");
    await db.admin("update public.leads set status = 'lost' where id = $1", [gone]);
    await addField(t.ws, open, "phone", "508-555-0101");
    await db.query(as(t.sdr), "select public.log_call($1,null,'talked','','Quer orçamento em março','',null)", [open]);
    const rows = (await rowsAs(t.owner, t.ws)).rows;
    expect(rows.find((r) => r.lead_id === open)).toMatchObject({ status: "replied", interested: true, note: "Quer orçamento em março" });
    expect(rows.find((r) => r.lead_id === gone)).toMatchObject({ status: "lost", interested: true });
  });

  test("propose: sender only, valid shape (avoid key ok), one open proposal at a time, approved through approve_profile", async () => {
    const t = await seedTeam();
    await expect(propose(t.closer, t.ws)).rejects.toThrow(/sender/);
    await expect(propose(t.sdr, t.ws, { ...PROFILE, points: [{ key: "hack", text: "x", rows: [1] }] })).rejects.toThrow(/invalid profile/);
    await expect(propose(t.sdr, t.ws, PROFILE, 0)).rejects.toThrow(/invalid profile/);
    const id = await propose(t.sdr, t.ws);
    expect(await propose(t.owner, t.ws)).toBe(id);
    const row = (await db.admin<{ source: string; import_id: string | null; status: string; created_by: string }>("select source, import_id, status, created_by from public.learned_profiles where id = $1", [id]))[0];
    expect(row).toEqual({ source: "results", import_id: null, status: "proposed", created_by: t.sdr });
    expect((await rowsAs(t.sdr, t.ws)).open_id).toBe(id);

    await db.query(as(t.owner), "select public.approve_profile($1,null,null)", [id]);
    const d = await rowsAs(t.sdr, t.ws);
    expect(d.open_id).toBeNull();
    expect(d.last_at).not.toBeNull();
    expect(d.current).toMatchObject({ filter: { towns: ["Worcester"] } });
    // the approved avoid point reaches a new Caçador run as a hint line
    const hints = (await db.admin<{ h: { lines: string[] } }>("select public.profile_hints_of(profile, version) as h from public.learned_profiles where id = $1", [id]))[0].h;
    expect(hints.lines).toContain("avoid: Reformas pequenas de casas");
    // a list proposal is still 'list'
    expect((await db.admin<{ d: string }>("select column_default as d from information_schema.columns where table_name = 'learned_profiles' and column_name = 'source'"))[0].d).toContain("list");
  });

  test("the clock: token + open tick; due list skips open proposals and the last 7 days; charged to the owner", async () => {
    const t = await seedTeam();
    await db.admin("insert into public.agents (workspace_id, type, name, schedule, config, created_by) values ($1,'hunter','Caçador','weekly','{}'::jsonb,$2)", [t.ws, t.owner]);
    const tick = await beginTick(db);
    const rpc = <T>(sql: string, params: unknown[] = []) => db.query<{ r: T }>(clock, sql, params).then((r) => r[0].r);
    const due = () => rpc<{ workspace_id: string }[]>("select public.hunter_results_due($1) as r", [tick]).then((r) => r.map((x) => x.workspace_id));

    expect(await due()).toContain(t.ws);
    await expect(db.query(anon, "select public.hunter_results_due($1)", [tick])).rejects.toThrow();
    await expect(db.query(as(t.owner), "select public.hunter_results_due($1)", [tick])).rejects.toThrow();
    expect((await rpc<Data>("select public.hunter_results_rows($1,$2) as r", [tick, t.ws])).rows).toEqual([]);

    const call = await rpc<string>("select public.hunter_results_reserve_ai_call($1,$2,'profile_learn','claude-sonnet-4-6','profile-results-t',0.2,5,50) as r", [tick, t.ws]);
    expect(await due()).not.toContain(t.ws); // a results call (even one that proposes nothing) waits its 7 days
    expect((await db.admin<{ user_id: string; run_id: string | null }>("select user_id, run_id from public.ai_calls where id = $1", [call]))[0]).toEqual({ user_id: t.owner, run_id: null });
    await expect(rpc("select public.hunter_results_reserve_ai_call($1,$2,'email_draft','m','v1',0.2,5,50) as r", [tick, t.ws])).rejects.toThrow(/profile task/);
    await rpc("select public.hunter_results_settle_ai_call($1,$2,'ok',100,50,0,0,0,0,0.01,null,10) as r", [tick, call]);
    expect((await db.admin<{ status: string }>("select status from public.ai_calls where id = $1", [call]))[0].status).toBe("ok");

    const id = await rpc<string>("select public.hunter_propose_results_profile($1,$2,$3::jsonb,12) as r", [tick, t.ws, JSON.stringify(PROFILE)]);
    expect((await db.admin<{ created_by: string | null; source: string }>("select created_by, source from public.learned_profiles where id = $1", [id]))[0]).toEqual({ created_by: null, source: "results" });
    await db.admin("update public.ai_calls set created_at = now() - interval '8 days' where id = $1", [call]);
    expect(await due()).not.toContain(t.ws); // open proposal
    await db.query(as(t.owner), "select public.reject_profile($1)", [id]);
    expect(await due()).not.toContain(t.ws); // proposed less than 7 days ago
    await db.admin("update public.learned_profiles set created_at = now() - interval '8 days' where id = $1", [id]);
    expect(await due()).toContain(t.ws);
    // a list training (another prompt version) does not count as learning from results
    await db.admin("update public.ai_calls set created_at = now(), prompt_version = 'profile-learn-x' where id = $1", [call]);
    expect(await due()).toContain(t.ws);

    // no owner with AI access: skipped, and nothing can be reserved
    await db.admin("delete from public.ai_access where user_id = $1", [t.owner]);
    expect(await due()).not.toContain(t.ws);
    await expect(rpc("select public.hunter_results_reserve_ai_call($1,$2,'profile_learn','claude-sonnet-4-6','v1',0.2,5,50) as r", [tick, t.ws])).rejects.toThrow(/no_access/);

    // a finished tick or a wrong token: refused
    await db.query(clock, "select public.hunter_finish_tick($1,'{}'::jsonb,null)", [tick]);
    await expect(rpc("select public.hunter_results_due($1) as r", [tick])).rejects.toThrow(/not allowed/);
    await setSchedulerToken(db, TOKEN.replace(/a/g, "b"));
    await expect(rpc("select public.hunter_results_due($1) as r", [tick])).rejects.toThrow(/not allowed/);
    await setSchedulerToken(db, TOKEN);
  });

  test("re-runnable: running 0032 again keeps proposals and their source", async () => {
    const t = await seedTeam();
    const id = await propose(t.sdr, t.ws);
    const sql = readFileSync(MIGRATION_PATHS.find((p) => p.includes("0032_"))!, "utf8");
    await db.pg.exec(sql);
    await db.pg.exec(sql);
    expect((await db.admin<{ source: string }>("select source from public.learned_profiles where id = $1", [id]))[0].source).toBe("results");
    expect(await propose(t.owner, t.ws)).toBe(id);
  });
});
