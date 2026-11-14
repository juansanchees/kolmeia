import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MIGRATIONS_DIR, TestDb, as, UUID_A, UUID_B, UUID_C } from "./helpers";
import { nameKey } from "@/lib/research/dedupe";
import { PHONE_VECTORS, WEBSITE_VECTORS } from "../fixtures/company-key-vectors";
import { row, seedImport } from "./lists-seed";
import { seedHunter, beginTick, clock } from "./hunter-seed";

// Migration 0011 (Lists, F3c-1, part 1): lead_fields with sources, import tables, one duplicate rule. Fictional data only.

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
  wsB = await createWorkspace(UUID_B, "Empresa B");
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

const rpc = (user: string, sql: string, params: unknown[] = []) => db.query<{ r: unknown }>(as(user), sql, params).then((x) => x[0]?.r);
const count = async (table: string) => Number((await db.admin<{ n: string }>(`select count(*) as n from public.${table}`))[0].n);
const fieldsOf = (lead: string) =>
  db.admin<{ field: string; value: string; key: string | null; source_ref: string | null; status: string }>(
    "select field, value, key, source_ref, status from public.lead_fields where lead_id = $1 order by field, value",
    [lead],
  );

describe("0011 workspace integrity (composite keys)", () => {
  test("a field cannot carry another workspace than its lead, and an import row another than its import", async () => {
    await clean();
    const lead = await importOnlyLead(wsA, []);
    const bad = await db.try(as(UUID_A), "select 1");
    expect(bad.error).toBeUndefined();
    await expect(
      db.admin("insert into public.lead_fields (workspace_id, lead_id, field, value, source) values ($1,$2,'note','x','import')", [wsB, lead]),
    ).rejects.toThrow(/foreign key|violates/);
    const [imp] = await db.admin<{ id: string }>("insert into public.lead_imports (workspace_id, file_name, list_name) values ($1,'f.csv','L') returning id", [wsA]);
    await expect(
      db.admin("insert into public.lead_import_rows (import_id, workspace_id, row_number, data, outcome) values ($1,$2,1,'{}','new')", [imp.id, wsB]),
    ).rejects.toThrow(/foreign key|violates/);
    await expect(
      db.admin("insert into public.lead_import_rows (import_id, workspace_id, row_number, data, outcome, lead_id) values ($1,$2,1,'{}','new',$3)", [imp.id, wsA, (await importOnlyLead(wsB, []))]),
    ).rejects.toThrow(/foreign key|violates/);
  });

  test("find_lead never returns a lead of another workspace, even on a poisoned key", async () => {
    await clean();
    const other = await importOnlyLead(wsB, [{ field: "name", value: "Acme Test Builders", key: nameKey("Acme Test Builders") }]);
    const found = await db.admin<{ f: string | null }>("select public.find_lead($1,$2,null,null,null) as f", [wsA, nameKey("Acme Test Builders")]);
    expect(found[0].f).toBeNull();
    const own = await importOnlyLead(wsA, [{ field: "name", value: "Acme Test Builders", key: nameKey("Acme Test Builders") }]);
    expect((await db.admin<{ f: string }>("select public.find_lead($1,$2,null,null,null) as f", [wsA, nameKey("Acme Test Builders")]))[0].f).toBe(own);
    expect(other).not.toBe(own);
  });

  test("lead_visible_to_assignee needs the lead and the workspace to match", async () => {
    await clean();
    const mine = await importOnlyLead(wsA, []);
    await db.admin("update public.leads set owner_id = $1 where id = $2", [UUID_D, mine]);
    const v = (ws: string) => rpc(UUID_D, "select public.lead_visible_to_assignee($1,$2) as r", [mine, ws]);
    expect(await v(wsA)).toBe(true);
    expect(await v(wsB)).toBe(false);
  });
});

describe("0011 import RPCs", () => {
  test("import creates one lead per company and merges into existing leads (D1)", async () => {
    await clean();
    const cand = await verified(UUID_A, wsA, await run(UUID_A, wsA), { name: "Bay Dev", website: "https://bay.example" });
    const before = await db.admin("select * from public.research_candidates where id = $1", [cand]);
    const { importId, result } = await seedImport(db, UUID_A, wsA, [
      row(1, "Acme Test Builders", { website: "https://acme.example" }),
      row(2, "Bay Developers", { website: "https://www.bay.example" }),
      row(3, "Zeta"),
    ]);
    expect(result).toEqual({ new: 2, merged: 1, errors: 0 });
    const leads = await db.admin<{ origin_kind: string; origin_import_id: string | null; best_candidate_id: string | null }>(
      "select origin_kind, origin_import_id, best_candidate_id from public.leads where workspace_id = $1 order by created_at, id",
      [wsA],
    );
    expect(leads).toHaveLength(3);
    expect(leads.filter((l) => l.origin_kind === "import" && l.origin_import_id === importId && l.best_candidate_id === null)).toHaveLength(2);
    expect(await db.admin("select * from public.research_candidates where id = $1", [cand])).toEqual(before);
    const bay = (await db.admin<{ id: string }>("select id from public.leads where best_candidate_id = $1", [cand]))[0].id;
    // the import's name and website, plus the candidate's own (0014 copies a verified candidate's values onto its lead)
    expect((await fieldsOf(bay)).map((f) => f.field)).toEqual(["name", "name", "website", "website"]);
    const imp = (await db.admin<Record<string, unknown>>("select status, row_count, new_count, merged_count, error_count, finished_at from public.lead_imports where id = $1", [importId]))[0];
    expect(imp).toMatchObject({ status: "done", row_count: 3, new_count: 2, merged_count: 1, error_count: 0 });
    expect(imp.finished_at).not.toBeNull();
  });

  test("rows of one batch that are the same company merge into the first", async () => {
    await clean();
    const { result } = await seedImport(db, UUID_A, wsA, [
      row(1, "Acme Test Builders", { phone: "508-555-0101" }),
      row(2, "ACME TEST BUILDERS, Inc.", { phone: "508-555-0102" }),
    ]);
    expect(result).toEqual({ new: 1, merged: 1, errors: 0 });
    const ids = await leadIds(wsA);
    expect(ids).toHaveLength(1);
    const f = await fieldsOf(ids[0]);
    expect(f.filter((x) => x.field === "name").map((x) => x.value).sort()).toEqual(["ACME TEST BUILDERS, Inc.", "Acme Test Builders"]);
    expect(f.filter((x) => x.field === "name").every((x) => x.key === nameKey("Acme Test Builders"))).toBe(true);
    expect(f.filter((x) => x.field === "phone")).toHaveLength(2);
  });

  test("the same phone in two rows of one file merges into one lead with one phone field", async () => {
    await clean();
    const { result } = await seedImport(db, UUID_A, wsA, [row(1, "Alpha Homes", { phone: "508-555-0111" }), row(2, "Totally Different", { phone: "(508) 555-0111" })]);
    expect(result).toEqual({ new: 1, merged: 1, errors: 0 });
    expect(await leadIds(wsA)).toHaveLength(1);
  });

  test("importing the same list again creates 0 leads", async () => {
    await clean();
    const rows = [row(1, "Acme Test Builders", { website: "https://acme.example" }), row(2, "Zeta", { phone: "508-555-0104" })];
    await seedImport(db, UUID_A, wsA, rows);
    const again = await seedImport(db, UUID_A, wsA, rows, { listName: "Outra" });
    expect(again.result).toEqual({ new: 0, merged: 2, errors: 0 });
    expect(await leadIds(wsA)).toHaveLength(2);
  });

  test("K-2 every distinct phone and e-mail stays, each with its list; nothing is overwritten", async () => {
    await clean();
    const a = await seedImport(db, UUID_A, wsA, [row(1, "Acme Test Builders", { phone: "508-555-0101", email: "a@acme.example" })]);
    const b = await seedImport(db, UUID_A, wsA, [row(1, "Acme Test Builders", { phone: "508-555-0199", email: "a@acme.example" })]);
    const [lead] = await leadIds(wsA);
    const f = await fieldsOf(lead);
    const phones = f.filter((x) => x.field === "phone");
    expect(phones.map((p) => [p.value, p.source_ref]).sort()).toEqual([["508-555-0101", a.importId], ["508-555-0199", b.importId]].sort());
    expect(f.filter((x) => x.field === "email").map((e) => e.source_ref).sort()).toEqual([a.importId, b.importId].sort());
    expect(f.every((x) => x.status === "unverified")).toBe(true);
    expect(f.filter((x) => x.field === "name")).toHaveLength(2);
  });

  test("error rows are stored with their code and create nothing", async () => {
    await clean();
    const { importId, result } = await seedImport(db, UUID_A, wsA, [
      { row: 1, error: "phone", data: { name: "Bad Phone Co", phone: "12" } },
      { row: 2, error: "too_long", data: { note: "x".repeat(6000) } },
      row(3, "Good Co"),
    ]);
    expect(result).toEqual({ new: 1, merged: 0, errors: 2 });
    expect(await leadIds(wsA)).toHaveLength(1);
    const rows = await db.admin<{ row_number: number; outcome: string; error: string | null; lead_id: string | null; data: Record<string, unknown> }>(
      "select row_number, outcome, error, lead_id, data from public.lead_import_rows where import_id = $1 order by row_number",
      [importId],
    );
    expect(rows.map((r) => [r.row_number, r.outcome, r.error, r.lead_id === null])).toEqual([[1, "error", "phone", true], [2, "error", "too_long", true], [3, "new", null, false]]);
    expect(rows[1].data).toEqual({ truncated: true });
    expect((await db.admin<{ error_count: number }>("select error_count from public.lead_imports where id = $1", [importId]))[0].error_count).toBe(2);
  });

  test("a batch sent twice is not counted twice", async () => {
    await clean();
    const id = (await rpc(UUID_A, "select public.create_lead_import($1,'f.csv',null,'L','{}'::jsonb,false) as r", [wsA])) as string;
    const batch = JSON.stringify([row(1, "Acme Test Builders"), row(2, "Zeta")]);
    await rpc(UUID_A, "select public.import_lead_rows($1,$2::jsonb) as r", [id, batch]);
    expect(await rpc(UUID_A, "select public.import_lead_rows($1,$2::jsonb) as r", [id, batch])).toEqual({ new: 0, merged: 0, errors: 0 });
    expect((await db.admin<{ row_count: number }>("select row_count from public.lead_imports where id = $1", [id]))[0].row_count).toBe(2);
  });

  test("limits: 501 rows in one call, more than 5,000 in one import, or rows after finish are refused (22023)", async () => {
    await clean();
    const id = (await rpc(UUID_A, "select public.create_lead_import($1,'f.csv',null,'L','{}'::jsonb,false) as r", [wsA])) as string;
    const rows = (from: number, n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => row(from + i, `Company ${from + i}`)));
    const imp = (json: string) => db.try(as(UUID_A), "select public.import_lead_rows($1,$2::jsonb)", [id, json]);
    expect((await imp(rows(1, 501))).error?.message).toMatch(/too many rows/);
    for (let i = 0; i < 10; i++) await db.query(as(UUID_A), "select public.import_lead_rows($1,$2::jsonb)", [id, rows(1 + i * 500, 500)]);
    expect((await db.admin<{ row_count: number }>("select row_count from public.lead_imports where id = $1", [id]))[0].row_count).toBe(5000);
    const over = await imp(rows(5001, 1)); // row numbers stop at 5,000, so the 5,001st is refused either way
    expect((over.error as unknown as { code?: string }).code).toBe("22023");
    await db.query(as(UUID_A), "select public.finish_lead_import($1)", [id]);
    const late = await imp(rows(1, 1));
    expect((late.error as unknown as { code?: string }).code).toBe("22023");
    expect(((await db.try(as(UUID_A), "select public.finish_lead_import($1)", [id])).error as unknown as { code?: string }).code).toBe("22023");
  }, 120_000);

  test("hostile cells are stored as text; hostile websites, long cells and unknown keys are refused", async () => {
    await clean();
    const id = (await rpc(UUID_A, "select public.create_lead_import($1,'f.csv',null,'L','{}'::jsonb,false) as r", [wsA])) as string;
    const refused = async (r: Record<string, unknown>) => {
      const x = await db.try(as(UUID_A), "select public.import_lead_rows($1,$2::jsonb)", [id, JSON.stringify([r])]);
      expect((x.error as unknown as { code?: string } | undefined)?.code).toBe("22023");
    };
    await refused({ ...row(1, "A"), website: "javascript:alert(1)" });
    await refused({ ...row(1, "A"), website: "https://x.example/ y" });
    await refused({ ...row(1, "A"), note: "x".repeat(1001) });
    await refused({ ...row(1, "A"), name: "x".repeat(201) });
    await refused({ ...row(1, "A"), phone: "9".repeat(301) });
    await refused({ ...row(1, "A"), email: "not an email" });
    await refused({ ...row(1, "A"), place_id: "zzz" });
    await refused({ ...row(1, "A"), note: 5 });
    await refused({ row: 1, name: "A" }); // no name_key
    await refused({ ...row(0, "A") });
    await refused({ row: 1, error: "phone", data: {}, extra: 1 });
    expect(await count("lead_import_rows")).toBe(0);
    const r = await rpc(UUID_A, "select public.import_lead_rows($1,$2::jsonb) as r", [
      id,
      JSON.stringify([row(1, "<script>alert(1)</script>", { note: '=HYPERLINK("http://x","y")' })]),
    ]);
    expect(r).toEqual({ new: 1, merged: 0, errors: 0 });
    const f = await fieldsOf((await leadIds(wsA))[0]);
    expect(f.find((x) => x.field === "note")?.value).toBe('=HYPERLINK("http://x","y")');
    expect(f.find((x) => x.field === "name")?.value).toBe("<script>alert(1)</script>");
  });

  test("preview says new or existing and writes nothing", async () => {
    await clean();
    await verified(UUID_A, wsA, await run(UUID_A, wsA), { name: "Bay Dev", website: "https://bay.example" });
    const id = (await rpc(UUID_A, "select public.create_lead_import($1,'f.csv',null,'L','{}'::jsonb,false) as r", [wsA])) as string;
    const snap = async () => [await count("leads"), await count("lead_fields"), await count("lead_import_rows")];
    const before = await snap();
    const out = (await rpc(UUID_A, "select public.preview_import_rows($1,$2::jsonb) as r", [
      id,
      JSON.stringify([row(1, "Bay Developers", { website: "bay.example".length ? "https://www.bay.example" : undefined }), row(2, "Zeta"), { row: 3, error: "phone", data: {} }]),
    ])) as { row: number; lead_id: string | null }[];
    expect(out.map((o) => [o.row, o.lead_id !== null])).toEqual([[1, true], [2, false], [3, false]]);
    expect(await snap()).toEqual(before);
    const imp = await db.try(as(UUID_A), "select public.preview_import_rows($1,$2::jsonb)", [id, JSON.stringify(Array.from({ length: 501 }, (_, i) => row(i + 1, `C${i}`)))]);
    expect((imp.error as unknown as { code?: string }).code).toBe("22023");
  });

  test("K-9 undo deletes only what this import created", async () => {
    await clean();
    // (b) existed before: a researched lead
    await verified(UUID_A, wsA, await run(UUID_A, wsA), { name: "Bay Dev", website: "https://bay.example" });
    const a = await seedImport(db, UUID_A, wsA, [
      row(1, "Only By A Co"), // (a) deleted
      row(2, "Bay Developers", { website: "https://bay.example" }), // (b) kept
      row(3, "Joined Later Co", { phone: "508-555-0121" }), // (c) kept: candidate joins
      row(4, "Shared With B Co"), // (d) kept: B merges
    ]);
    await verified(UUID_A, wsA, await run(UUID_A, wsA), { name: "Joined Later Inc", phone: "508-555-0121" });
    const b = await seedImport(db, UUID_A, wsA, [row(1, "Shared With B Co", { phone: "508-555-0130" })], { listName: "B" });
    expect(b.result).toEqual({ new: 0, merged: 1, errors: 0 });
    expect(await leadIds(wsA)).toHaveLength(4);

    const res = await rpc(UUID_A, "select public.undo_lead_import($1) as r", [a.importId]);
    expect(res).toEqual({ deleted: 1, kept: 3 });
    expect(await leadIds(wsA)).toHaveLength(3);
    const imp = await db.admin<{ status: string }>("select status from public.lead_imports where id = $1", [a.importId]);
    expect(imp[0].status).toBe("undone");
    expect(await db.admin("select 1 from public.lead_import_rows where import_id = $1", [a.importId])).toHaveLength(0);
    expect(await db.admin("select 1 from public.lead_fields where source_ref = $1", [a.importId])).toHaveLength(0);
    const shared = (await db.admin<{ lead_id: string }>("select lead_id from public.lead_fields where source_ref = $1 and field = 'phone'", [b.importId]))[0].lead_id;
    expect((await db.admin<{ origin_import_id: string }>("select origin_import_id from public.leads where id = $1", [shared]))[0].origin_import_id).toBe(b.importId);
    // (c) a lead that had only A's values and now a candidate: stays, origin_kind import, no list
    const joined = (await db.admin<{ id: string; origin_kind: string; origin_import_id: string | null }>(
      "select l.id, l.origin_kind, l.origin_import_id from public.leads l join public.research_candidates c on c.id = l.best_candidate_id where c.name = 'Joined Later Inc'",
    ))[0];
    expect(joined).toMatchObject({ origin_kind: "import", origin_import_id: null });
    // B's values remain intact
    expect((await fieldsOf(shared)).filter((f) => f.source_ref === b.importId).length).toBeGreaterThan(0);
    expect(((await db.try(as(UUID_A), "select public.undo_lead_import($1)", [a.importId])).error as unknown as { code?: string }).code).toBe("22023");
  });

  test("undo keeps leads that were already worked (status or owner) and counts them as kept", async () => {
    await clean();
    const a = await seedImport(db, UUID_A, wsA, [row(1, "Plain Co"), row(2, "Worked Status Co"), row(3, "Assigned Co")]);
    await db.admin("update public.leads set status = 'call_list' where id = (select lead_id from public.lead_fields where field = 'name' and value = 'Worked Status Co')");
    await db.admin("update public.leads set owner_id = $1 where id = (select lead_id from public.lead_fields where field = 'name' and value = 'Assigned Co')", [UUID_D]);
    expect(await rpc(UUID_A, "select public.undo_lead_import($1) as r", [a.importId])).toEqual({ deleted: 1, kept: 2 });
    const left = await db.admin<{ origin_kind: string; origin_import_id: string | null }>("select origin_kind, origin_import_id from public.leads where workspace_id = $1", [wsA]);
    expect(left).toEqual([
      { origin_kind: "import", origin_import_id: null },
      { origin_kind: "import", origin_import_id: null },
    ]);
    // the worked leads keep this list's values: a re-upload still finds them (no duplicate, no blank lead)
    expect(await count("lead_fields")).toBe(2);
    const again = await seedImport(db, UUID_A, wsA, [row(1, "Worked Status Co"), row(2, "Assigned Co")]);
    expect(again.result).toEqual({ new: 0, merged: 2, errors: 0 });
    expect(await leadIds(wsA)).toHaveLength(2);
  });

  test("undo removes a lead that only an import value kept alive (its candidate is gone), never leaves a blank one", async () => {
    await clean();
    const cand = await verified(UUID_A, wsA, await run(UUID_A, wsA), { name: "Ghost Builders", website: "https://ghost.example" });
    const a = await seedImport(db, UUID_A, wsA, [row(1, "Ghost Builders", { website: "https://ghost.example" })]);
    expect(a.result.merged).toBe(1);
    await db.admin("delete from public.research_candidates where id = $1", [cand]);
    expect(await leadIds(wsA)).toHaveLength(1);
    expect(await rpc(UUID_A, "select public.undo_lead_import($1) as r", [a.importId])).toEqual({ deleted: 1, kept: 0 });
    expect(await leadIds(wsA)).toHaveLength(0);
  });

  test("applying 0011 a second time on a database with data loses nothing", async () => {
    // own database: re-applying leaves stale planner statistics (no autovacuum in PGlite) that would slow the 5,000-row test below
    const db2 = await TestDb.create();
    try {
      await db2.addUser(UUID_A);
      const ws = (await db2.query<{ create_workspace: string }>(as(UUID_A), "select public.create_workspace($1)", ["Empresa R"]))[0].create_workspace;
      await seedImport(db2, UUID_A, ws, [row(1, "Rerun Co", { phone: "508-555-0188" }), row(2, "Rerun Two")]);
      const n = async (t: string) => Number((await db2.admin<{ n: string }>(`select count(*) as n from public.${t}`))[0].n);
      const snap = async () => [await n("leads"), await n("lead_fields"), await n("lead_imports"), await n("lead_import_rows")];
      const before = await snap();
      expect(before[0]).toBe(2);
      expect(before[1]).toBeGreaterThan(2);
      await db2.pg.exec(readFileSync(path.join(MIGRATIONS_DIR, "0011_lists.sql"), "utf8"));
      expect(await snap()).toEqual(before);
    } finally {
      await db2.pg.close();
    }
  });

  test("a 1,000-character multi-byte note imports (index entries stay small)", async () => {
    await clean();
    const note = "建".repeat(1000);
    const { result } = await seedImport(db, UUID_A, wsA, [row(1, "Acme Test Builders", { note: "x".repeat(300) }), row(2, "Zeta")]);
    expect(result.errors).toBe(0);
    const id = (await rpc(UUID_A, "select public.create_lead_import($1,'f.csv',null,'L','{}'::jsonb,false) as r", [wsA])) as string;
    // the cap on note is 1,000 characters: a CJK note of exactly 1,000 characters is 3,000 bytes
    expect(await rpc(UUID_A, "select public.import_lead_rows($1,$2::jsonb) as r", [id, JSON.stringify([row(1, "Zeta", { note })])])).toEqual({ new: 0, merged: 1, errors: 0 });
    expect((await fieldsOf((await leadIds(wsA))[0])).some((f) => f.value === note) || (await fieldsOf((await leadIds(wsA))[1])).some((f) => f.value === note)).toBe(true);
  });

  test("re-sending the last batch of a 5,000-row import is idempotent, not a cap error", async () => {
    await clean();
    const id = (await rpc(UUID_A, "select public.create_lead_import($1,'f.csv',null,'L','{}'::jsonb,false) as r", [wsA])) as string;
    const rows = (from: number, n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => row(from + i, `Company ${from + i}`)));
    for (let i = 0; i < 10; i++) await db.query(as(UUID_A), "select public.import_lead_rows($1,$2::jsonb)", [id, rows(1 + i * 500, 500)]);
    expect(await rpc(UUID_A, "select public.import_lead_rows($1,$2::jsonb) as r", [id, rows(4501, 500)])).toEqual({ new: 0, merged: 0, errors: 0 });
    expect(((await db.try(as(UUID_A), "select public.import_lead_rows($1,$2::jsonb)", [id, rows(5001, 1)])).error as unknown as { code?: string }).code).toBe("22023");
  }, 120_000);

  test("an unfinished import can be undone and its leads are gone", async () => {
    await clean();
    const id = (await rpc(UUID_A, "select public.create_lead_import($1,'f.csv',null,'L','{}'::jsonb,false) as r", [wsA])) as string;
    const batch = (from: number) => JSON.stringify(Array.from({ length: 3 }, (_, i) => row(from + i, `Unfinished ${from + i}`)));
    await rpc(UUID_A, "select public.import_lead_rows($1,$2::jsonb) as r", [id, batch(1)]);
    await rpc(UUID_A, "select public.import_lead_rows($1,$2::jsonb) as r", [id, batch(4)]);
    expect((await db.admin<{ status: string }>("select status from public.lead_imports where id = $1", [id]))[0].status).toBe("importing");
    expect(await leadIds(wsA)).toHaveLength(6);
    expect(await rpc(UUID_A, "select public.undo_lead_import($1) as r", [id])).toEqual({ deleted: 6, kept: 0 });
    expect(await leadIds(wsA)).toHaveLength(0);
    expect(await count("lead_fields")).toBe(0);
  });

  test("the closer, a non-member and another workspace cannot create, preview, import, finish or undo (42501)", async () => {
    await clean();
    const id = (await rpc(UUID_A, "select public.create_lead_import($1,'f.csv',null,'L','{}'::jsonb,false) as r", [wsA])) as string;
    const calls: [string, unknown[]][] = [
      ["select public.create_lead_import($1,'f.csv',null,'L','{}'::jsonb,false)", [wsA]],
      ["select public.preview_import_rows($1,'[]'::jsonb)", [id]],
      ["select public.import_lead_rows($1,'[]'::jsonb)", [id]],
      ["select public.finish_lead_import($1)", [id]],
      ["select public.undo_lead_import($1)", [id]],
    ];
    for (const user of [UUID_D, UUID_B]) {
      for (const [sql, params] of calls) {
        const r = await db.try(as(user), sql, params);
        expect((r.error as unknown as { code?: string }).code, `${user} ${sql}`).toBe("42501");
      }
    }
    // the sdr (UUID_C) may
    expect(await rpc(UUID_C, "select public.import_lead_rows($1,'[]'::jsonb) as r", [id])).toEqual({ new: 0, merged: 0, errors: 0 });
    // signed out
    expect((await db.try({ role: "anon" }, "select public.create_lead_import($1,'f.csv',null,'L','{}'::jsonb,false)", [wsA])).error?.message).toMatch(/permission denied|not allowed/);
    // the internal guard is not callable
    expect((await db.try(as(UUID_A), "select public.lead_import_guard($1, array['importing'], false)", [id])).error?.message).toMatch(/permission denied/);
    // other workspace's rows cannot be touched through a foreign import id; rows land in the import's workspace
    const { importId } = await seedImport(db, UUID_A, wsA, [row(1, "Acme Test Builders")]);
    expect(await db.admin("select 1 from public.lead_fields where workspace_id <> $1", [wsA])).toHaveLength(0);
    expect(await db.admin("select 1 from public.lead_import_rows where import_id = $1 and workspace_id <> $2", [importId, wsA])).toHaveLength(0);
  });

  test("no AI is used: ai_calls has no row after imports", async () => {
    await clean();
    await seedImport(db, UUID_A, wsA, [row(1, "Acme Test Builders"), row(2, "Zeta")]);
    expect(await count("ai_calls")).toBe(0);
  });

  test("C4 the Caçador's known companies include import-only leads, oldest value first, refuted ones never", async () => {
    await clean();
    const h = await seedHunter(db, { userId: "99999999-9999-4999-8999-999999999999" });
    const tick = await beginTick(db);
    await db.query(clock, "select public.hunter_due_work($1) as r", [tick]);
    const runId = (await db.admin<{ id: string }>("select id from public.research_runs where agent_id = $1", [h.agent]))[0].id;
    await seedImport(db, "99999999-9999-4999-8999-999999999999", h.ws, [
      row(1, "Acme Test Builders", { website: "https://acme.example", phone: "508-555-0101" }),
    ]);
    await seedImport(db, "99999999-9999-4999-8999-999999999999", h.ws, [row(1, "Acme Test Builders", { website: "https://acme.example", phone: "508-555-0188" })], { listName: "2" });
    await db.admin("update public.lead_fields set status = 'refuted' where value = '508-555-0101'");
    const known = (await db.query<{ r: { name: string; website: string | null; phone: string | null }[] }>(clock, "select public.hunter_known_companies($1,$2) as r", [tick, runId]))[0].r;
    expect(known).toEqual([{ name: "Acme Test Builders", website: "https://acme.example", phone: "508-555-0188" }]);
  });
});
