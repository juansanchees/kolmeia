import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, anon, as, UUID_A, UUID_B, UUID_C } from "./helpers";
import { domainKey, nameKey, phoneKey } from "@/lib/research/dedupe";
import { PHONE_VECTORS, WEBSITE_VECTORS } from "../fixtures/company-key-vectors";

// Migration 0009 (Leads, F3a): one lead per company per workspace, built from verified candidates. Fictional data only.
// Real migrations, non-superuser roles (PGlite).

const UUID_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // closer in workspace A

let db: TestDb;
let wsA: string;
let wsB: string;

async function createWorkspace(userId: string, name: string): Promise<string> {
  const rows = await db.query<{ create_workspace: string }>(as(userId), "select public.create_workspace($1)", [name]);
  return rows[0].create_workspace;
}

async function run(user: string, ws: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    as(user),
    "insert into public.research_runs (workspace_id, title, request_text, region_text, rigor) values ($1,'t','pedido','Worcester, MA','careful') returning id",
    [ws],
  );
  return r[0].id;
}

async function cand(user: string, ws: string, runId: string, c: { name: string; website?: string; phone?: string }): Promise<string> {
  const r = await db.query<{ id: string }>(
    as(user),
    "insert into public.research_candidates (workspace_id, run_id, name, name_key, website, phone) values ($1,$2,$3,$4,$5,$6) returning id",
    [ws, runId, c.name, nameKey(c.name), c.website ?? null, c.phone ?? null],
  );
  return r[0].id;
}

async function verify(user: string, id: string): Promise<void> {
  await db.query(as(user), "update public.research_candidates set verified_at = now() where id = $1", [id]);
}

async function verified(user: string, ws: string, runId: string, c: { name: string; website?: string; phone?: string }): Promise<string> {
  const id = await cand(user, ws, runId, c);
  await verify(user, id);
  return id;
}

type Lead = { id: string; status: string; origin_kind: string; origin_agent_id: string | null; origin_run_id: string | null; best_candidate_id: string | null };
const leadsOf = (ws: string) =>
  db.admin<Lead>("select id, status, origin_kind, origin_agent_id, origin_run_id, best_candidate_id from public.leads where workspace_id = $1", [ws]);

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

// Each test starts from an empty set of leads and searches of workspace A.
async function clean() {
  await db.admin("delete from public.research_runs");
  await db.admin("delete from public.leads");
}

describe("0009 leads", () => {
  test("leads: RLS on and forced; clients cannot insert, update or delete; anon has nothing", async () => {
    const rows = await db.admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = 'leads'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].relrowsecurity).toBe(true);
    expect(rows[0].relforcerowsecurity).toBe(true);
    expect((await db.try(anon, "select * from public.leads")).error?.message).toMatch(/permission denied/);
    await clean();
    await verified(UUID_A, wsA, await run(UUID_A, wsA), { name: "Acme Builders" });
    const id = (await leadsOf(wsA))[0].id;
    expect((await db.try(as(UUID_A), "insert into public.leads (workspace_id, origin_kind) values ($1,'one_off')", [wsA])).error?.message).toMatch(/permission denied/);
    expect((await db.try(as(UUID_A), "update public.leads set status = 'won' where id = $1", [id])).error?.message).toMatch(/permission denied/);
    expect((await db.try(as(UUID_A), "delete from public.leads where id = $1", [id])).error?.message).toMatch(/permission denied/);
  });

  test("a verified candidate becomes a lead stamped with its origin; an unverified one does not", async () => {
    await clean();
    const r1 = await run(UUID_A, wsA);
    const c1 = await cand(UUID_A, wsA, r1, { name: "Pine Homes" });
    expect(await leadsOf(wsA)).toHaveLength(0);
    await verify(UUID_A, c1);
    const leads = await leadsOf(wsA);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ status: "new", origin_kind: "one_off", origin_run_id: r1, best_candidate_id: c1, origin_agent_id: null });
    const [row] = await db.admin<{ lead_id: string }>("select lead_id from public.research_candidates where id = $1", [c1]);
    expect(row.lead_id).toBe(leads[0].id);

    await cand(UUID_A, wsA, r1, { name: "Unverified Co" });
    expect(await leadsOf(wsA)).toHaveLength(1);

    // inserted already verified, from a run that belongs to an agent
    const [agent] = await db.admin<{ id: string }>("insert into public.agents (workspace_id, type, name) values ($1,'hunter','Caçador X') returning id", [wsA]);
    const r2 = await run(UUID_A, wsA);
    await db.admin("update public.research_runs set agent_id = $1 where id = $2", [agent.id, r2]);
    const [c2] = await db.admin<{ id: string }>(
      "insert into public.research_candidates (workspace_id, run_id, name, name_key, verified_at) values ($1,$2,'Oak Group',$3, now()) returning id",
      [wsA, r2, nameKey("Oak Group")],
    );
    const oak = (await leadsOf(wsA)).find((l) => l.best_candidate_id === c2.id);
    expect(oak).toMatchObject({ origin_kind: "agent", origin_agent_id: agent.id, origin_run_id: r2 });
  });

  test("G9 same company across runs is one lead: name key, website domain or last 10 phone digits", async () => {
    await clean();
    const [r1, r2, r3, r4] = [await run(UUID_A, wsA), await run(UUID_A, wsA), await run(UUID_A, wsA), await run(UUID_A, wsA)];
    await verified(UUID_A, wsA, r1, { name: "Acme Builders, Inc.", website: "https://www.acme.com/contact", phone: "+1 (508) 555-0199" });
    const c2 = await verified(UUID_A, wsA, r2, { name: "ACME BUILDERS" });
    let leads = await leadsOf(wsA);
    expect(leads).toHaveLength(1);
    expect(leads[0].best_candidate_id).toBe(c2);

    await verified(UUID_A, wsA, r3, { name: "Acme Construction Group", website: "http://acme.com" });
    expect(await leadsOf(wsA)).toHaveLength(1);

    await verified(UUID_A, wsA, r4, { name: "Totally Other LLC", phone: "508.555.0199" });
    leads = await leadsOf(wsA);
    expect(leads).toHaveLength(1);
    expect(leads[0].origin_run_id).toBe(r1);
  });

  test("shared hosts and short phones never merge companies", async () => {
    await clean();
    const r = await run(UUID_A, wsA);
    await verified(UUID_A, wsA, r, { name: "Alpha Roofing", website: "https://facebook.com/a" });
    await verified(UUID_A, wsA, r, { name: "Beta Roofing", website: "https://m.facebook.com/b" });
    expect(await leadsOf(wsA)).toHaveLength(2);
    await verified(UUID_A, wsA, r, { name: "Gamma Plumbing", phone: "555-0199" });
    await verified(UUID_A, wsA, r, { name: "Delta Plumbing", phone: "555-0199" });
    expect(await leadsOf(wsA)).toHaveLength(4);
  });

  test("a company in another workspace is never merged", async () => {
    await clean();
    await verified(UUID_A, wsA, await run(UUID_A, wsA), { name: "Acme Builders" });
    await verified(UUID_B, wsB, await run(UUID_B, wsB), { name: "Acme Builders" });
    expect(await leadsOf(wsA)).toHaveLength(1);
    expect(await leadsOf(wsB)).toHaveLength(1);
    await db.admin("delete from public.research_runs");
    await db.admin("delete from public.leads");
  });

  test("SQL company keys match lib/research/dedupe.ts on the shared vectors", async () => {
    for (const v of WEBSITE_VECTORS) {
      const [r] = await db.admin<{ k: string | null }>("select public.company_domain_key($1) as k", [v]);
      expect(r.k, `website ${JSON.stringify(v)}`).toBe(domainKey(v));
    }
    for (const v of PHONE_VECTORS) {
      const [r] = await db.admin<{ k: string | null }>("select public.company_phone_key($1) as k", [v]);
      expect(r.k, `phone ${JSON.stringify(v)}`).toBe(phoneKey(v));
    }
    const [n] = await db.admin<{ a: string | null; b: string | null }>("select public.company_domain_key(null) as a, public.company_phone_key(null) as b");
    expect(n).toEqual({ a: null, b: null });
  });

  test('C1 old verified candidates are back-filled as "pesquisa avulsa"; the newest verification is the best; running it again changes nothing', async () => {
    await clean();
    const r1 = await run(UUID_A, wsA);
    const r2 = await run(UUID_A, wsA);
    await db.admin("alter table public.research_candidates disable trigger link_candidate_lead");
    const ins = async (runId: string, at: string) =>
      (
        await db.admin<{ id: string }>(
          "insert into public.research_candidates (workspace_id, run_id, name, name_key, verified_at) values ($1,$2,'Old Acme',$3,$4) returning id",
          [wsA, runId, nameKey("Old Acme"), at],
        )
      )[0].id;
    await ins(r1, "2026-01-01T00:00:00Z");
    const newer = await ins(r2, "2026-02-01T00:00:00Z");
    await db.admin("alter table public.research_candidates enable trigger link_candidate_lead");
    expect(await leadsOf(wsA)).toHaveLength(0);

    const [first] = await db.admin<{ n: number }>("select public.backfill_leads() as n");
    expect(first.n).toBe(2);
    const leads = await leadsOf(wsA);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ origin_kind: "one_off", origin_run_id: r1, best_candidate_id: newer });
    const [d] = await db.admin<{ f: string; l: string }>("select first_seen_at::text as f, last_seen_at::text as l from public.leads where workspace_id = $1", [wsA]);
    expect(new Date(d.f).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(new Date(d.l).toISOString()).toBe("2026-02-01T00:00:00.000Z");

    const [second] = await db.admin<{ n: number }>("select public.backfill_leads() as n");
    expect(second.n).toBe(0);
    expect(await leadsOf(wsA)).toHaveLength(1);
  });

  test("deleting a search re-points or removes its leads", async () => {
    await clean();
    const r1 = await run(UUID_A, wsA);
    const r2 = await run(UUID_A, wsA);
    const c1 = await verified(UUID_A, wsA, r1, { name: "Acme Builders" });
    const c2 = await verified(UUID_A, wsA, r2, { name: "Acme Builders" });
    let leads = await leadsOf(wsA);
    expect(leads).toHaveLength(1);
    expect(leads[0].best_candidate_id).toBe(c2);

    await db.query(as(UUID_A), "delete from public.research_runs where id = $1", [r2]);
    leads = await leadsOf(wsA);
    expect(leads).toHaveLength(1);
    expect(leads[0].best_candidate_id).toBe(c1);

    await db.query(as(UUID_A), "delete from public.research_runs where id = $1", [r1]);
    expect(await leadsOf(wsA)).toHaveLength(0);
  });

  test("R8 leads of another workspace are invisible", async () => {
    await clean();
    await verified(UUID_A, wsA, await run(UUID_A, wsA), { name: "Acme Builders" });
    expect(await db.query(as(UUID_B), "select id from public.leads where workspace_id = $1", [wsA])).toHaveLength(0);
    expect(await db.query(as(UUID_A), "select id from public.leads where workspace_id = $1", [wsA])).toHaveLength(1);
    expect(await db.query(as(UUID_C), "select id from public.leads where workspace_id = $1", [wsA])).toHaveLength(1); // sdr
    expect(await db.query(as(UUID_D), "select id from public.leads where workspace_id = $1", [wsA])).toHaveLength(0); // closer, nothing assigned
  });

  test("agent_id and lead_id are the database's: clients cannot write them", async () => {
    await clean();
    const [agent] = await db.admin<{ id: string }>("insert into public.agents (workspace_id, type, name) values ($1,'hunter','X') returning id", [wsA]);
    const ins = await db.try(
      as(UUID_A),
      "insert into public.research_runs (workspace_id, title, request_text, region_text, rigor, agent_id) values ($1,'t','p','r','careful',$2)",
      [wsA, agent.id],
    );
    expect(ins.error).toMatchObject({ code: "42501" });
    const c = await cand(UUID_A, wsA, await run(UUID_A, wsA), { name: "Acme Builders" });
    const upd = await db.try(as(UUID_A), "update public.research_candidates set lead_id = gen_random_uuid() where id = $1", [c]);
    expect(upd.error).toMatchObject({ code: "42501" });
  });
});

describe("0009 closer", () => {
  let candA: string;
  let candB: string;
  let runA: string;

  // One verified lead (with a check and evidence added through add_research_check) plus a second, unassigned one.
  async function seed() {
    await clean();
    runA = await run(UUID_A, wsA);
    candA = await cand(UUID_A, wsA, runA, { name: "Acme Builders" });
    candB = await cand(UUID_A, wsA, runA, { name: "Beta Homes" });
    for (const id of [candA, candB]) {
      await db.query(as(UUID_A), "select public.add_research_check($1,'exists_active',1,'ok','ok',$2::jsonb)", [
        id,
        JSON.stringify([{ url: "https://example.com/p", title: "Page", excerpt: "text" }]),
      ]);
      await verify(UUID_A, id);
    }
  }

  test("J2 the closer cannot start, answer, approve or advance research", async () => {
    await seed();
    const ins = await db.try(
      as(UUID_D),
      "insert into public.research_runs (workspace_id, title, request_text, region_text, rigor) values ($1,'t','p','r','careful')",
      [wsA],
    );
    expect(ins.error).toBeDefined();
    expect(await db.query(as(UUID_D), "update public.research_runs set answers = '{}'::jsonb where id = $1 returning id", [runA])).toHaveLength(0);
    const holder = "dddddddd-0000-4000-8000-000000000001";
    const claim = await db.try<{ claim_research_step: boolean }>(as(UUID_D), "select public.claim_research_step($1,$2,60)", [runA, holder]);
    expect(claim.error ?? claim.rows?.[0]?.claim_research_step === false).toBeTruthy();
    const [locked] = await db.admin<{ locked_by: string | null }>("select locked_by from public.research_runs where id = $1", [runA]);
    expect(locked.locked_by).toBeNull();
    const chk = await db.try(as(UUID_D), "select public.add_research_check($1,'exists_active',2,'ok','x','[]'::jsonb)", [candA]);
    expect(chk.error).toBeDefined();
    expect(await db.query(as(UUID_D), "update public.research_candidates set user_decision = 'keep' where id = $1 returning id", [candA])).toHaveLength(0);
    // the reviewer note: verified_at (and so the lead link) is out of the closer's hands too
    expect(await db.query(as(UUID_D), "update public.research_candidates set verified_at = null where id = $1 returning id", [candA])).toHaveLength(0);
  });

  test("J2 the closer sees no research runs, sources, jobs or lists", async () => {
    await seed();
    await db.admin("insert into public.research_sources (workspace_id, run_id, kind, title, url, status) values ($1,$2,'permits','s','https://example.com/s','used')", [wsA, runA]);
    await db.admin("insert into public.research_jobs (workspace_id, run_id, address, source_url) values ($1,$2,'1 Main St','https://example.com/j')", [wsA, runA]);
    await db.admin("update public.research_candidates set user_decision = 'keep' where id = $1", [candA]);
    const [l] = await db.admin<{ id: string }>("insert into public.research_lists (workspace_id, run_id, name) values ($1,$2,'L') returning id", [wsA, runA]);
    await db.admin("insert into public.research_list_items (list_id, candidate_id, workspace_id) values ($1,$2,$3)", [l.id, candA, wsA]);
    for (const t of ["research_runs", "research_sources", "research_jobs", "research_lists", "research_list_items"]) {
      expect(await db.query(as(UUID_D), `select 1 from public.${t}`), t).toHaveLength(0);
      expect((await db.query(as(UUID_A), `select 1 from public.${t}`)).length, t).toBeGreaterThan(0);
    }
  });

  test("J2 the closer sees only the leads assigned to her, and their proof", async () => {
    await seed();
    const count = (t: string) => db.query(as(UUID_D), `select 1 from public.${t}`).then((r) => r.length);
    expect(await count("leads")).toBe(0);
    for (const t of ["research_candidates", "research_checks", "research_evidence"]) expect(await count(t), t).toBe(0);
    const [lead] = await db.admin<{ id: string }>("select lead_id as id from public.research_candidates where id = $1", [candA]);
    await db.admin("update public.leads set owner_id = $1 where id = $2", [UUID_D, lead.id]);
    expect(await count("leads")).toBe(1);
    expect(await db.query(as(UUID_D), "select id from public.research_candidates")).toEqual([{ id: candA }]);
    expect(await count("research_checks")).toBe(1);
    expect(await count("research_evidence")).toBe(1);
    expect(await db.query(as(UUID_D), "select 1 from public.research_candidates where id = $1", [candB])).toHaveLength(0);
    // sees the proof but still cannot change it
    expect(await db.query(as(UUID_D), "update public.research_candidates set user_decision = 'keep' where id = $1 returning id", [candA])).toHaveLength(0);
  });

  test("owner and sdr keep full research access", async () => {
    await seed();
    for (const u of [UUID_A, UUID_C]) {
      const r = await run(u, wsA);
      expect(await db.query(as(u), "update public.research_runs set answers = '{}'::jsonb where id = $1 returning id", [r])).toHaveLength(1);
      const holder = "cccccccc-0000-4000-8000-000000000001";
      const c = await db.query<{ claim_research_step: boolean }>(as(u), "select public.claim_research_step($1,$2,60)", [r, holder]);
      expect(c[0].claim_research_step).toBe(true);
      await db.query(as(u), "select public.release_research_step($1,$2)", [r, holder]);
      const [after] = await db.admin<{ locked_by: string | null }>("select locked_by from public.research_runs where id = $1", [r]);
      expect(after.locked_by).toBeNull();
      await db.query(as(u), "select public.add_research_check($1,'has_work',1,'unknown','ok','[]'::jsonb)", [candA]);
    }
  });
});
