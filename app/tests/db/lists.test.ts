import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, as, UUID_A, UUID_B, UUID_C } from "./helpers";
import { nameKey } from "@/lib/research/dedupe";
import { PHONE_VECTORS, WEBSITE_VECTORS } from "../fixtures/company-key-vectors";

// Migration 0011 (Lists, F3c-1, part 1): lead_fields with sources, import tables, one duplicate rule. Fictional data only.

const UUID_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // closer in workspace A

let db: TestDb;
let wsA: string;

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

async function verified(user: string, ws: string, runId: string, c: { name: string; website?: string; phone?: string }): Promise<string> {
  const r = await db.query<{ id: string }>(
    as(user),
    "insert into public.research_candidates (workspace_id, run_id, name, name_key, website, phone) values ($1,$2,$3,$4,$5,$6) returning id",
    [ws, runId, c.name, nameKey(c.name), c.website ?? null, c.phone ?? null],
  );
  await db.query(as(user), "update public.research_candidates set verified_at = now() where id = $1", [r[0].id]);
  return r[0].id;
}

/** An import-only lead (no candidate) with fields, written as the server would (admin). */
async function importOnlyLead(ws: string, fields: { field: string; value: string; key?: string; status?: string }[]): Promise<string> {
  const [lead] = await db.admin<{ id: string }>("insert into public.leads (workspace_id, origin_kind) values ($1,'import') returning id", [ws]);
  for (const f of fields) {
    await db.admin(
      "insert into public.lead_fields (workspace_id, lead_id, field, value, key, source, source_ref, status) values ($1,$2,$3,$4,$5,'import','imp-1',$6)",
      [ws, lead.id, f.field, f.value, f.key ?? null, f.status ?? "unverified"],
    );
  }
  return lead.id;
}

const leadIds = async (ws: string) => (await db.admin<{ id: string }>("select id from public.leads where workspace_id = $1", [ws])).map((l) => l.id);

beforeAll(async () => {
  db = await TestDb.create();
  for (const id of [UUID_A, UUID_B, UUID_C, UUID_D]) await db.addUser(id);
  wsA = await createWorkspace(UUID_A, "Empresa A");
  await createWorkspace(UUID_B, "Empresa B");
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr'), ($1,$3,'closer')", [wsA, UUID_C, UUID_D]);
});

afterAll(async () => {
  await db.pg.close();
});

async function clean() {
  await db.admin("delete from public.research_runs");
  await db.admin("delete from public.leads");
  await db.admin("delete from public.lead_imports");
}

describe("0011 lead fields and one duplicate rule", () => {
  test("lead_fields keys follow the SQL company keys on the shared vectors", async () => {
    await clean();
    const lead = await importOnlyLead(wsA, []);
    let n = 0; // distinct source_ref: several vectors share one key and the same source would be one row (K-2)
    const ins = (field: string, value: string) =>
      db.admin<{ key: string | null }>(
        "insert into public.lead_fields (workspace_id, lead_id, field, value, source, source_ref) values ($1,$2,$3,$4,'import',$5) returning key",
        [wsA, lead, field, value, `imp-${n++}`],
      );
    for (const w of WEBSITE_VECTORS.filter((v) => v.trim() !== "")) {
      const [exp] = await db.admin<{ k: string | null }>("select public.company_domain_key($1) as k", [w]);
      expect((await ins("website", w))[0].key).toBe(exp.k);
    }
    for (const p of PHONE_VECTORS.filter((v) => v.trim() !== "")) {
      const [exp] = await db.admin<{ k: string | null }>("select public.company_phone_key($1) as k", [p]);
      expect((await ins("phone", p))[0].key).toBe(exp.k);
    }
    expect((await ins("email", "Info@Acme.Example"))[0].key).toBe("info@acme.example");
    expect((await ins("note", "hello"))[0].key).toBeNull();
  });

  test("K-1 a verified candidate joins an import-only lead with the same name, domain or phone", async () => {
    await clean();
    const l1 = await importOnlyLead(wsA, [{ field: "name", value: "Acme Test Builders", key: nameKey("Acme Test Builders") }]);
    const l2 = await importOnlyLead(wsA, [{ field: "website", value: "https://bay.example" }]);
    const l3 = await importOnlyLead(wsA, [{ field: "phone", value: "508-555-0101" }]);
    const r = await run(UUID_A, wsA);
    const c1 = await verified(UUID_A, wsA, r, { name: "ACME Test Builders, Inc." });
    const c2 = await verified(UUID_A, wsA, r, { name: "Bay Dev", website: "http://www.bay.example/x" });
    const c3 = await verified(UUID_A, wsA, r, { name: "Zeta", phone: "+1 508 555 0101" });
    const rows = await db.admin<{ id: string; best_candidate_id: string | null }>("select id, best_candidate_id from public.leads where workspace_id = $1", [wsA]);
    expect(rows).toHaveLength(3);
    const best = Object.fromEntries(rows.map((x) => [x.id, x.best_candidate_id]));
    expect(best[l1]).toBe(c1);
    expect(best[l2]).toBe(c2);
    expect(best[l3]).toBe(c3);
    const link = await db.admin<{ id: string; lead_id: string }>("select id, lead_id from public.research_candidates");
    expect(Object.fromEntries(link.map((x) => [x.id, x.lead_id]))).toMatchObject({ [c1]: l1, [c2]: l2, [c3]: l3 });
  });

  test("refuted fields identify nobody", async () => {
    await clean();
    await importOnlyLead(wsA, [{ field: "phone", value: "508-555-0102", status: "refuted" }]);
    await verified(UUID_A, wsA, await run(UUID_A, wsA), { name: "Other Co", phone: "508-555-0102" });
    expect(await leadIds(wsA)).toHaveLength(2);
  });

  test("deleting the only candidate of a lead with imported values keeps the lead", async () => {
    await clean();
    const imp = await importOnlyLead(wsA, [{ field: "phone", value: "508-555-0103" }]);
    const r = await run(UUID_A, wsA);
    await verified(UUID_A, wsA, r, { name: "Joined Co", phone: "508-555-0103" });
    const r2 = await run(UUID_A, wsA);
    await verified(UUID_A, wsA, r2, { name: "Research Only Co" });
    expect(await leadIds(wsA)).toHaveLength(2);
    await db.admin("delete from public.research_runs");
    const left = await db.admin<{ id: string; best_candidate_id: string | null }>("select id, best_candidate_id from public.leads where workspace_id = $1", [wsA]);
    expect(left).toEqual([{ id: imp, best_candidate_id: null }]);
  });

  test("clients cannot write lead_fields, lead_imports or lead_import_rows", async () => {
    await clean();
    const lead = await importOnlyLead(wsA, [{ field: "note", value: "x" }]);
    const [imp] = await db.admin<{ id: string }>("insert into public.lead_imports (workspace_id, file_name, list_name) values ($1,'f.csv','L') returning id", [wsA]);
    await db.admin("insert into public.lead_import_rows (import_id, workspace_id, row_number, data, outcome) values ($1,$2,1,'{}','new')", [imp.id, wsA]);
    const denied = async (sql: string, params: unknown[]) => expect((await db.try(as(UUID_A), sql, params)).error?.message).toMatch(/permission denied/);
    await denied("insert into public.lead_fields (workspace_id, lead_id, field, value, source) values ($1,$2,'note','y','import')", [wsA, lead]);
    await denied("update public.lead_fields set value = 'z' where lead_id = $1", [lead]);
    await denied("delete from public.lead_fields where lead_id = $1", [lead]);
    await denied("insert into public.lead_imports (workspace_id, file_name, list_name) values ($1,'g.csv','M')", [wsA]);
    await denied("update public.lead_imports set status = 'done' where id = $1", [imp.id]);
    await denied("delete from public.lead_imports where id = $1", [imp.id]);
    await denied("insert into public.lead_import_rows (import_id, workspace_id, row_number, data, outcome) values ($1,$2,2,'{}','new')", [imp.id, wsA]);
    await denied("update public.lead_import_rows set outcome = 'error' where import_id = $1", [imp.id]);
    await denied("delete from public.lead_import_rows where import_id = $1", [imp.id]);
  });

  test("the closer reads fields only of leads assigned to her; another workspace reads nothing", async () => {
    await clean();
    const mine = await importOnlyLead(wsA, [{ field: "note", value: "mine" }]);
    await importOnlyLead(wsA, [{ field: "note", value: "other" }]);
    await db.admin("update public.leads set owner_id = $1 where id = $2", [UUID_D, mine]);
    await db.admin("insert into public.lead_imports (workspace_id, file_name, list_name) values ($1,'f.csv','L')", [wsA]);
    const seen = await db.query<{ value: string }>(as(UUID_D), "select value from public.lead_fields");
    expect(seen).toEqual([{ value: "mine" }]);
    expect(await db.query(as(UUID_D), "select 1 from public.lead_imports")).toHaveLength(0);
    expect(await db.query(as(UUID_B), "select 1 from public.lead_fields")).toHaveLength(0);
    expect(await db.query(as(UUID_B), "select 1 from public.lead_imports")).toHaveLength(0);
    expect(await db.query(as(UUID_A), "select 1 from public.lead_fields")).toHaveLength(2);
    expect(await db.query(as(UUID_A), "select 1 from public.lead_imports")).toHaveLength(1);
  });
});
