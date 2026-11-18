import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb, as, service } from "./helpers";

// 0041: kb_deliver + lead_opportunities + call queue order. Invented data only (Acme*, 508-555-01xx, example.com).

let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create();
});
afterAll(async () => {
  await db.pg.close();
});

const code = (e: unknown) => (e as { code?: string } | undefined)?.code;
let seq = 0;

async function seed() {
  const [owner, other] = [randomUUID(), randomUUID()];
  await db.addUser(owner);
  await db.addUser(other);
  const ws = (await db.query<{ id: string }>(as(owner), "select public.create_workspace('Empresa A') as id"))[0].id;
  const ws2 = (await db.query<{ id: string }>(as(other), "select public.create_workspace('Empresa B') as id"))[0].id;
  return { owner, other, ws, ws2 };
}
const company = async (name: string) => {
  const n = ++seq;
  return (await db.admin<{ id: string }>("insert into public.kb_companies (name, name_key) values ($1, $2) returning id", [name, `${name.toLowerCase()} ${n}`]))[0].id;
};
const signal = async (company_id: string) =>
  (await db.admin<{ id: string }>("insert into public.kb_signals (company_id, kind, source, source_ref) values ($1,'permit','permit',$2) returning id", [company_id, `P-${++seq}`]))[0].id;
const opp = (sig: string | null, over: Record<string, unknown> = {}) => ({
  kb_signal_id: sig, offer: "hvac_new_construction", title: "New build", priority: 50, priority_codes: ["a"], hook_en: "Saw your permit", contact_path: "phone", ...over,
});
const row = (n: number, co: string, opps?: unknown[]) => ({ row: n, name: `Acme ${n}`, name_key: `acme ${n}`, phone: `508-555-01${String(n).padStart(2, "0")}`, kb_company_id: co, ...(opps ? { opportunities: opps } : {}) });
const deliver = (ws: string, rows: unknown[], imp: string | null = null) =>
  db.query<{ r: Record<string, unknown> }>(service, "select public.kb_deliver($1,$2,'Base Kolmeia: teste',$3::jsonb) as r", [ws, imp, JSON.stringify(rows)]).then((x) => x[0].r);
const opps = (ws: string) => db.admin<{ lead_id: string; priority: number; title: string }>("select lead_id, priority, title from public.lead_opportunities where workspace_id = $1 order by priority desc", [ws]);

describe("kb_deliver opportunities", () => {
  it("first delivery with 2 opportunities", async () => {
    const t = await seed();
    const c = await company("Acme One");
    const r = await deliver(t.ws, [row(1, c, [opp(await signal(c)), opp(await signal(c), { priority: 70 })])]);
    expect(r).toMatchObject({ new: 1, merged: 0, errors: 0, skipped_linked: 0 });
    expect(await opps(t.ws)).toHaveLength(2);
    expect(Number((await db.admin<{ n: string }>("select count(*) n from public.kb_lead_links where workspace_id = $1", [t.ws]))[0].n)).toBe(1);
  });

  it("retry idempotent: same count, fields updated", async () => {
    const t = await seed();
    const c = await company("Acme Two");
    const s = await signal(c);
    const first = await deliver(t.ws, [row(1, c, [opp(s)])]);
    await deliver(t.ws, [row(1, c, [opp(s, { title: "Changed", priority: 80 })])], first.import_id as string);
    expect(await opps(t.ws)).toMatchObject([{ title: "Changed", priority: 80 }]);
  });

  it("second delivery on linked lead upserts opportunity only", async () => {
    const t = await seed();
    const c = await company("Acme Three");
    await deliver(t.ws, [row(1, c, [opp(await signal(c))])]);
    const r = await deliver(t.ws, [row(1, c, [opp(await signal(c), { priority: 90 })])]);
    expect(r).toMatchObject({ new: 0, skipped_linked: 1 });
    expect(await opps(t.ws)).toHaveLength(2);
    expect(Number((await db.admin<{ n: string }>("select count(*) n from public.leads where workspace_id = $1", [t.ws]))[0].n)).toBe(1);
  });

  it("member of other workspace cannot read opportunities; owner can", async () => {
    const t = await seed();
    const c = await company("Acme Four");
    await deliver(t.ws, [row(1, c, [opp(null)])]);
    expect(await db.query(as(t.other), "select id from public.lead_opportunities")).toHaveLength(0);
    expect(await db.query(as(t.owner), "select id from public.lead_opportunities")).toHaveLength(1);
  });

  it("authenticated cannot write opportunities", async () => {
    const t = await seed();
    const c = await company("Acme Five");
    await deliver(t.ws, [row(1, c, [opp(null)])]);
    const lead = (await opps(t.ws))[0].lead_id;
    expect(code((await db.try(as(t.owner), "update public.lead_opportunities set priority = 1")).error)).toBe("42501");
    expect(code((await db.try(as(t.owner), "insert into public.lead_opportunities (workspace_id, lead_id, offer) values ($1,$2,'x')", [t.ws, lead])).error)).toBe("42501");
    expect(code((await db.try(as(t.owner), "select public.kb_deliver($1,null,'x','[]'::jsonb)", [t.ws])).error)).toBe("42501");
  });
});

describe("call queue with opportunities", () => {
  async function agent(t: { owner: string; ws: string }) {
    const id = (await db.query<{ id: string }>(as(t.owner), "insert into public.agents (workspace_id, type, name, config) values ($1,'call','Ligação',$2::jsonb) returning id", [t.ws, JSON.stringify({ caller_id: t.owner, per_day: 20, min_level: 1, temperatures: [] })]))[0].id;
    await db.query(as(t.owner), "update public.agents set status = 'paused' where id = $1", [id]);
    await db.query(as(t.owner), "update public.agents set status = 'running' where id = $1", [id]);
    return id;
  }
  const build = async (u: string, a: string) => (await db.query<{ n: number }>(as(u), "select public.build_call_list($1) as n", [a]))[0].n;

  it("call list puts opportunity leads first by priority", async () => {
    const t = await seed();
    // a plain lead (level 2, phone) that would normally lead the queue
    const run = (await db.admin<{ id: string }>("insert into public.research_runs (workspace_id, title, request_text) values ($1,'t','p') returning id", [t.ws]))[0].id;
    const plain = (await db.admin<{ lead_id: string }>("insert into public.research_candidates (workspace_id, run_id, name, name_key, phone, user_decision, verified_at) values ($1,$2,'Plain Co','plain co','508-555-0199','keep',now()) returning lead_id", [t.ws, run]))[0].lead_id;
    await db.admin("update public.leads set level = 2 where id = $1", [plain]);
    const [c1, c2] = [await company("Acme Low"), await company("Acme High")];
    await deliver(t.ws, [row(1, c1, [opp(null, { priority: 20 })]), row(2, c2, [opp(null, { priority: 90 })])]);
    const a = await agent(t);
    expect(await build(t.owner, a)).toBe(3);
    const items = await db.admin<{ lead_id: string }>("select lead_id from public.call_list_items where agent_id = $1 order by position", [a]);
    const byPrio = await db.admin<{ lead_id: string }>("select lead_id from public.lead_opportunities where workspace_id = $1 order by priority desc", [t.ws]);
    expect(items.map((i) => i.lead_id)).toEqual([...byPrio.map((o) => o.lead_id), plain]);
  });

  it("rebuild call list no duplicate items", async () => {
    const t = await seed();
    const c = await company("Acme Six");
    await deliver(t.ws, [row(1, c, [opp(null)])]);
    const a = await agent(t);
    await build(t.owner, a);
    await deliver(t.ws, [row(1, c, [opp(null, { priority: 99 })])]);
    expect(await build(t.owner, a)).toBe(0);
    expect(Number((await db.admin<{ n: string }>("select count(*) n from public.call_list_items where agent_id = $1", [a]))[0].n)).toBe(1);
  });
});

describe("kb_deliver as a list", () => {
  const cnt = async (sql: string, p: unknown[] = []) => Number((await db.admin<{ n: string }>(sql, p))[0].n);

  it("first delivery, retry, second delivery, undo", async () => {
    const t = await seed();
    const [c1, c2] = [await company("Acme Seven"), await company("Acme Eight")];
    const rows = [row(1, c1), row(2, c2)];
    const r = await deliver(t.ws, rows);
    expect(r).toMatchObject({ new: 2, merged: 0, errors: 0, skipped_linked: 0 });
    const imp = r.import_id as string;
    expect(await db.admin("select kind from public.lead_imports where id = $1", [imp])).toEqual([{ kind: "kb" }]);
    expect(await cnt("select count(*) n from public.lead_fields where workspace_id = $1 and source = 'kb'", [t.ws])).toBeGreaterThan(0);
    // retry with the same import: nothing new, still 2 links
    expect(await deliver(t.ws, rows, imp)).toMatchObject({ new: 0, merged: 0 });
    expect(await cnt("select count(*) n from public.kb_lead_links where workspace_id = $1", [t.ws])).toBe(2);
    // a second delivery run skips linked
    expect(await deliver(t.ws, rows)).toMatchObject({ new: 0, skipped_linked: 2 });
    expect(await cnt("select count(*) n from public.leads where workspace_id = $1", [t.ws])).toBe(2);
    // undo removes leads and links; redelivery possible
    await db.query(as(t.owner), "select public.undo_lead_import($1)", [imp]);
    expect(await cnt("select count(*) n from public.leads where workspace_id = $1", [t.ws])).toBe(0);
    expect(await cnt("select count(*) n from public.kb_lead_links where workspace_id = $1", [t.ws])).toBe(0);
    expect(await deliver(t.ws, rows)).toMatchObject({ new: 2 });
  });

  it("merges into an existing lead", async () => {
    const t = await seed();
    const run = (await db.admin<{ id: string }>("insert into public.research_runs (workspace_id, title, request_text) values ($1,'t','p') returning id", [t.ws]))[0].id;
    const lead = (await db.admin<{ lead_id: string }>("insert into public.research_candidates (workspace_id, run_id, name, name_key, website, user_decision, verified_at) values ($1,$2,'Acme Nine','acme nine','https://acme9.example.com','keep',now()) returning lead_id", [t.ws, run]))[0].lead_id;
    const c = await company("Acme Nine KB");
    expect(await deliver(t.ws, [{ ...row(1, c), name: "Acme Nine", name_key: "acme nine", website: "https://acme9.example.com" }])).toMatchObject({ new: 0, merged: 1 });
    expect(await db.admin("select lead_id from public.kb_lead_links where workspace_id = $1", [t.ws])).toEqual([{ lead_id: lead }]);
  });

  it("wrong workspace refused; file import refuses source kb", async () => {
    const t = await seed();
    const c = await company("Acme Ten");
    const r = await deliver(t.ws, [row(1, c)]);
    const e = await db.try(service, "select public.kb_deliver($1,$2,'x','[]'::jsonb)", [t.ws2, r.import_id]);
    expect(code(e.error)).toBe("22023");
    const fileImp = (await db.admin<{ id: string }>("insert into public.lead_imports (workspace_id, kind, file_name, list_name) values ($1,'file','f','l') returning id", [t.ws]))[0].id;
    const e2 = await db.try(service, "select public.import_rows_core($1,'[]'::jsonb,'kb')", [fileImp]);
    expect(code(e2.error)).toBe("22023");
  });
});
