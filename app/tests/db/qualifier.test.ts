import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, as, UUID_A, UUID_B, UUID_C } from "./helpers";
import { nameKey } from "@/lib/research/dedupe";

// Migration 0014 (Qualificador, F3c-2, part 1): level, settings, queue, ai_calls per lead. Fictional data only.

const UUID_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // closer in workspace A

let db: TestDb;
let wsA: string;
let wsB: string;

async function createWorkspace(userId: string, name: string): Promise<string> {
  const rows = await db.query<{ create_workspace: string }>(as(userId), "select public.create_workspace($1)", [name]);
  return rows[0].create_workspace;
}

async function clean() {
  await db.admin("delete from public.research_runs");
  await db.admin("delete from public.leads");
}

async function newRun(ws = wsA): Promise<string> {
  const r = await db.admin<{ id: string }>(
    "insert into public.research_runs (workspace_id, title, request_text, region_text, rigor, created_by) values ($1,'t','pedido','Worcester, MA','careful',$2) returning id",
    [ws, UUID_A],
  );
  return r[0].id;
}

type Cand = { name: string; phone?: string; phoneUrl?: string; email?: string; emailUrl?: string; askName?: string; askTitle?: string; temperature?: string; website?: string };
async function candidate(runId: string, c: Cand, ws = wsA): Promise<string> {
  const r = await db.admin<{ id: string }>(
    `insert into public.research_candidates (workspace_id, run_id, name, name_key, city, state, website, phone, phone_source_url, public_email, email_source_url, ask_for_name, ask_for_title, temperature, verified_at)
     values ($1,$2,$3,$4,'Worcester','MA',$5,$6,$7,$8,$9,$10,$11,$12, now()) returning id`,
    [ws, runId, c.name, nameKey(c.name), c.website ?? null, c.phone ?? null, c.phoneUrl ?? null, c.email ?? null, c.emailUrl ?? null, c.askName ?? null, c.askTitle ?? null, c.temperature ?? null],
  );
  return r[0].id;
}

async function leadOf(candidateId: string): Promise<string> {
  return (await db.admin<{ lead_id: string }>("select lead_id from public.research_candidates where id = $1", [candidateId]))[0].lead_id;
}

async function importLead(ws = wsA, origin = "import"): Promise<string> {
  return (await db.admin<{ id: string }>("insert into public.leads (workspace_id, origin_kind) values ($1,$2) returning id", [ws, origin]))[0].id;
}

async function field(lead: string, f: string, value: string, status = "unverified", source = "import", ref = "imp-1", ws = wsA) {
  await db.admin("insert into public.lead_fields (workspace_id, lead_id, field, value, source, source_ref, status) values ($1,$2,$3,$4,$5,$6,$7)", [ws, lead, f, value, source, ref, status]);
}

/** An ok check and its evidence in one transaction (P1: an ok check needs a source at commit). */
async function okCheck(runId: string, candidateId: string, kind: string, ws = wsA): Promise<void> {
  await db.pg.transaction(async (tx) => {
    const k = await tx.query<{ id: string }>(
      "insert into public.research_checks (workspace_id, run_id, candidate_id, kind, pass, result) values ($1,$2,$3,$4,1,'ok') returning id",
      [ws, runId, candidateId, kind],
    );
    await tx.query("insert into public.research_evidence (workspace_id, check_id, url, title, excerpt) values ($1,$2,'https://example.com/proof','Proof','proof text')", [ws, k.rows[0].id]);
  });
}

const levelOf = async (lead: string) => (await db.admin<{ level: number }>("select level from public.leads where id = $1", [lead]))[0].level;

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

describe("0014 level, Qualificador and queue", () => {
  test("a verified candidate copies its values onto its lead with the research source", async () => {
    await clean();
    const run = await newRun();
    const withProof = await candidate(run, { name: "Alfa Construtora", phone: "508-555-0101", phoneUrl: "https://example.com/p", email: "a@alfa.example", askName: "Maria Souza", askTitle: "Owner" });
    const lead = await leadOf(withProof);
    const rows = await db.admin<{ field: string; value: string; key: string | null; status: string; source: string; source_ref: string }>(
      "select field, value, key, status, source, source_ref from public.lead_fields where lead_id = $1 order by field",
      [lead],
    );
    const by = Object.fromEntries(rows.map((r) => [r.field, r]));
    expect(by.phone.status).toBe("confirmed"); // has phone_source_url
    expect(by.email.status).toBe("unverified"); // no email_source_url
    expect(by.contact_name.status).toBe("unverified"); // no decision_maker proof
    expect(by.contact_title.status).toBe("unverified");
    expect(by.name.key).toBe(nameKey("Alfa Construtora"));
    expect(by.name.status).toBe("confirmed");
    expect(by.city.value).toBe("Worcester");
    expect(rows.every((r) => r.source === "research" && r.source_ref === withProof)).toBe(true);

    const run2 = await newRun();
    const noUrl = await candidate(run2, { name: "Beta Homes", phone: "508-555-0102" });
    const phone = await db.admin<{ status: string }>("select status from public.lead_fields where lead_id = $1 and field = 'phone'", [await leadOf(noUrl)]);
    expect(phone[0].status).toBe("unverified");

    // contact confirmed only with an ok decision_maker check that has evidence
    const run3 = await newRun();
    const c3 = await db.admin<{ id: string }>(
      "insert into public.research_candidates (workspace_id, run_id, name, name_key, ask_for_name, ask_for_title) values ($1,$2,'Gama Builders',$3,'Joao Lima','Director') returning id",
      [wsA, run3, nameKey("Gama Builders")],
    );
    await okCheck(run3, c3[0].id, "decision_maker");
    await db.admin("update public.research_candidates set verified_at = now() where id = $1", [c3[0].id]);
    const contact = await db.admin<{ field: string; status: string }>("select field, status from public.lead_fields where lead_id = $1 and field like 'contact_%'", [await leadOf(c3[0].id)]);
    expect(contact.map((r) => r.status)).toEqual(["confirmed", "confirmed"]);
    // running the copy again changes nothing
    expect((await db.admin<{ n: number }>("select public.copy_candidate_fields($1) as n", [c3[0].id]))[0].n).toBe(0);
  });

  test("level follows the values: 0 name, 1 imported phone, 2 confirmed site and address, 3 confirmed contact and title, 4 confirmed active work", async () => {
    await clean();
    const lead = await importLead();
    await field(lead, "name", "Delta Corp");
    expect(await levelOf(lead)).toBe(0);
    await field(lead, "phone", "5085550103");
    expect(await levelOf(lead)).toBe(1);
    await field(lead, "website", "https://delta.example", "confirmed");
    expect(await levelOf(lead)).toBe(1); // site alone is not level 2
    await field(lead, "address", "1 Main St, Worcester MA", "confirmed");
    expect(await levelOf(lead)).toBe(2);
    await field(lead, "contact_name", "Ana Reis", "confirmed");
    expect(await levelOf(lead)).toBe(2); // name alone is not level 3
    await field(lead, "contact_title", "Owner", "confirmed");
    expect(await levelOf(lead)).toBe(3);
    await field(lead, "active_project", "42-unit building, permit 2026", "confirmed");
    expect(await levelOf(lead)).toBe(4);

    // research path: a hot candidate with an ok has_work check (with evidence) counts
    const run = await newRun();
    const cand = await candidate(run, { name: "Epsilon LLC", phone: "508-555-0104", temperature: "hot" });
    const l2 = await leadOf(cand);
    expect(await levelOf(l2)).toBe(1);
    await db.admin("insert into public.research_checks (workspace_id, run_id, candidate_id, kind, pass, result) values ($1,$2,$3,'fits_profile',1,'no')", [wsA, run, cand]);
    expect(await levelOf(l2)).toBe(1); // a 'no' check of another kind proves nothing
    await okCheck(run, cand, "has_work");
    expect(await levelOf(l2)).toBe(4);
    await db.admin("update public.research_candidates set second_pass = 'refuted' where id = $1", [cand]);
    expect(await levelOf(l2)).toBe(1);
    const note = await db.admin<{ level_note: { from: number; to: number; field: string } }>("select level_note from public.leads where id = $1", [l2]);
    expect(note[0].level_note).toEqual({ from: 4, to: 1, field: "second_pass" });
  });

  test("K-3 a refuted field lowers the level visibly", async () => {
    await clean();
    const lead = await importLead();
    await field(lead, "phone", "5085550105");
    expect(await levelOf(lead)).toBe(1);
    expect((await db.admin<{ level_note: unknown }>("select level_note from public.leads where id = $1", [lead]))[0].level_note).toBeNull();
    await db.admin("update public.lead_fields set status = 'refuted' where lead_id = $1 and field = 'phone'", [lead]);
    expect(await levelOf(lead)).toBe(0);
    const n = await db.admin<{ level_note: { from: number; to: number; field: string } }>("select level_note from public.leads where id = $1", [lead]);
    expect(n[0].level_note).toEqual({ from: 1, to: 0, field: "phone" });

    expect((await db.try(as(UUID_D), "select public.ack_level_note($1)", [lead])).error).toMatchObject({ code: "42501" });
    expect((await db.try(as(UUID_B), "select public.ack_level_note($1)", [lead])).error).toMatchObject({ code: "42501" }); // another workspace
    await db.query(as(UUID_A), "select public.ack_level_note($1)", [lead]);
    expect((await db.admin<{ level_note: unknown }>("select level_note from public.leads where id = $1", [lead]))[0].level_note).toBeNull();
  });

  test("every workspace gets one Qualificador: on, US$ 5 a day, US$ 0.50 a lead, automatic deep check on; it cannot be inserted, deleted or duplicated by a client", async () => {
    for (const ws of [wsA, wsB]) {
      const rows = await db.admin<Record<string, unknown>>("select * from public.qualifiers where workspace_id = $1", [ws]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "on", paused_reason: null, paused_until: null, auto_deep: true });
      expect(Number(rows[0].daily_cap_usd)).toBe(5);
      expect(Number(rows[0].lead_cap_usd)).toBe(0.5);
    }
    expect(Number((await db.admin<{ n: string }>("select count(*) n from public.qualifiers"))[0].n)).toBe(2);
    expect((await db.admin<{ c: string }>("select charge_user_id c from public.qualifiers where workspace_id = $1", [wsA]))[0].c).toBe(UUID_A);

    expect((await db.try(as(UUID_A), "insert into public.qualifiers (workspace_id) values ($1)", [wsA])).error).toMatchObject({ code: "42501" });
    expect((await db.try(as(UUID_A), "delete from public.qualifiers where workspace_id = $1", [wsA])).error).toMatchObject({ code: "42501" });
    expect((await db.try(as(UUID_B), "select * from public.qualifiers where workspace_id = $1", [wsA])).rows).toHaveLength(0);
    await expect(db.admin("insert into public.qualifiers (workspace_id) values ($1)", [wsA])).rejects.toThrow(/duplicate key/);
    // a workspace created later gets its own
    const wsC = await createWorkspace(UUID_C, "Empresa C");
    expect((await db.admin("select 1 from public.qualifiers where workspace_id = $1", [wsC])).length).toBe(1);
  });

  test("J-1 the caps are editable inside the hard caps; only on and paused move; the closer cannot", async () => {
    await db.admin("insert into public.workspace_settings (workspace_id, ai_daily_cap_usd) values ($1, 10) on conflict (workspace_id) do update set ai_daily_cap_usd = 10", [wsA]);
    const upd = (user: string, set: string, params: unknown[] = []) =>
      db.try(as(user), `update public.qualifiers set ${set} where workspace_id = '${wsA}' returning *`, params);

    await db.query(as(UUID_A), "update public.qualifiers set daily_cap_usd = 7 where workspace_id = $1", [wsA]);
    expect((await upd(UUID_A, "daily_cap_usd = 7")).rows).toHaveLength(1);
    expect((await upd(UUID_C, "lead_cap_usd = 1.25")).rows).toHaveLength(1); // sdr
    const high = await upd(UUID_A, "daily_cap_usd = 11");
    expect(high.error).toMatchObject({ code: "23514" });
    expect(high.error?.message).toMatch(/^Q1:/);
    const low = await upd(UUID_A, "lead_cap_usd = 0.01");
    expect(low.error).toMatchObject({ code: "23514" });
    expect(low.error?.message).toMatch(/^Q1:/);
    expect((await upd(UUID_A, "lead_cap_usd = 6")).error?.message).toMatch(/^Q1:/);
    expect((await upd(UUID_A, "paused_reason = 'daily_cap'")).error).toMatchObject({ code: "42501" });
    expect((await upd(UUID_A, `charge_user_id = '${UUID_B}'`)).error).toMatchObject({ code: "42501" });

    const paused = await upd(UUID_A, "status = 'paused'");
    expect(paused.rows?.[0]).toMatchObject({ status: "paused", paused_reason: "user" });
    await db.query(as(UUID_A), "update public.qualifiers set status = 'paused' where workspace_id = $1", [wsA]);
    const on = await db.query<{ status: string; paused_reason: string | null }>(as(UUID_A), "update public.qualifiers set status = 'on' where workspace_id = $1 returning *", [wsA]);
    expect(on[0]).toMatchObject({ status: "on", paused_reason: null });
    expect((await upd(UUID_A, "status = 'broken'")).error).toBeDefined();

    // the closer neither sees nor changes it
    expect((await db.try(as(UUID_D), "select * from public.qualifiers where workspace_id = $1", [wsA])).rows).toHaveLength(0);
    expect((await upd(UUID_D, "daily_cap_usd = 1")).rows).toHaveLength(0);
    // another workspace's owner cannot either
    expect((await upd(UUID_B, "daily_cap_usd = 1")).rows).toHaveLength(0);
    expect(Number((await db.admin<{ d: string }>("select daily_cap_usd d from public.qualifiers where workspace_id = $1", [wsA]))[0].d)).toBe(7);
  });

  test("every new lead enters the queue, Caçador leads with priority; new imported values re-queue a finished lead but not a dead one", async () => {
    await clean();
    const agentLead = await importLead(wsA, "agent");
    const importLd = await importLead(wsA, "import");
    const q = await db.admin<{ lead_id: string; next_step: string; priority_hunter: boolean; spent_usd: string; deep_requested: boolean }>(
      "select * from public.qualifier_queue where workspace_id = $1",
      [wsA],
    );
    expect(q).toHaveLength(2);
    expect(q.every((r) => r.next_step === "p1" && Number(r.spent_usd) === 0 && r.deep_requested === false)).toBe(true);
    expect(q.find((r) => r.lead_id === agentLead)?.priority_hunter).toBe(true);
    expect(q.find((r) => r.lead_id === importLd)?.priority_hunter).toBe(false);

    await db.admin("update public.qualifier_queue set next_step = 'done', done_reason = 'complete', last_step_at = now() where lead_id = $1", [importLd]);
    await db.admin("update public.qualifier_queue set next_step = 'done', done_reason = 'dead', last_step_at = now() where lead_id = $1", [agentLead]);
    await field(importLd, "phone", "5085550106");
    await field(agentLead, "phone", "5085550107");
    const after = await db.admin<{ lead_id: string; next_step: string; done_reason: string | null }>("select lead_id, next_step, done_reason from public.qualifier_queue");
    expect(after.find((r) => r.lead_id === importLd)).toMatchObject({ next_step: "p1", done_reason: null });
    expect(after.find((r) => r.lead_id === agentLead)).toMatchObject({ next_step: "done", done_reason: "dead" });

    // a value that did not come from an import does not re-queue
    await db.admin("update public.qualifier_queue set next_step = 'done', done_reason = 'complete' where lead_id = $1", [importLd]);
    await field(importLd, "email", "x@delta.example", "unverified", "site", "https://delta.example");
    expect((await db.admin<{ next_step: string }>("select next_step from public.qualifier_queue where lead_id = $1", [importLd]))[0].next_step).toBe("done");

    // clients: read for the sender, never write
    expect((await db.try(as(UUID_A), "select * from public.qualifier_queue")).rows).toHaveLength(2);
    expect((await db.try(as(UUID_D), "select * from public.qualifier_queue")).rows).toHaveLength(0);
    expect((await db.try(as(UUID_A), "update public.qualifier_queue set next_step = 'p5'")).error).toMatchObject({ code: "42501" });
    expect((await db.try(as(UUID_A), "delete from public.qualifier_step_log")).error).toMatchObject({ code: "42501" });
    expect((await db.try(as(UUID_D), "select * from public.qualifier_step_log")).rows).toHaveLength(0);

    // qualifier_status
    await db.admin("insert into public.qualifier_step_log (workspace_id, lead_id, step, outcome) values ($1,$2,'p2','ok'), ($1,$2,'p4','ok'), ($1,$2,'p5','error')", [wsA, importLd]);
    const st = (await db.query<{ s: Record<string, unknown> }>(as(UUID_A), "select public.qualifier_status($1) as s", [wsA]))[0].s;
    expect(st).toMatchObject({ status: "on", queued: 0, daily_cap_usd: 7, auto_deep: true });
    expect(st.levels).toEqual({ "0": 0, "1": 2, "2": 0, "3": 0, "4": 0 });
    expect(st.steps_today).toEqual({ free: 1, places: 0, light: 1, deep: 0 });
    expect(Number(st.spent_today)).toBe(0);
    expect((await db.try(as(UUID_D), "select public.qualifier_status($1)", [wsA])).error).toMatchObject({ code: "42501" });
    expect((await db.try(as(UUID_B), "select public.qualifier_status($1)", [wsA])).error).toMatchObject({ code: "42501" });
    expect((await db.try({ role: "anon" }, "select public.qualifier_status($1)", [wsA])).error).toMatchObject({ code: "42501" });
  });

  test("the Qualificador's day is New York's", async () => {
    const at = async (iso: string) =>
      (await db.admin<{ t: string }>("select to_char(public.qualifier_day_start_at($1::timestamptz) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') t", [iso]))[0].t;
    expect(await at("2026-11-15 03:30+00")).toBe("2026-11-14 05:00"); // EST
    expect(await at("2026-07-01 03:30+00")).toBe("2026-06-30 04:00"); // EDT
    expect(await at("2026-11-15 05:00+00")).toBe("2026-11-15 05:00"); // exactly midnight
  });

  test("ai_calls is read by owner and sdr only, takes lead_id and the new tasks; settled cost adds to the lead", async () => {
    await clean();
    const lead = await importLead();
    const ins = (task: string, cost: number, status = "ok") =>
      db.admin(
        "insert into public.ai_calls (workspace_id, user_id, lead_id, task, model, prompt_version, status, cost_usd, reserve_usd) values ($1,$2,$3,$4,'claude-haiku-5-5','v1',$5,$6,0.1)",
        [wsA, UUID_A, lead, task, status, cost],
      );
    await ins("qualify_light", 0.02);
    expect(Number((await db.admin<{ s: string }>("select spent_usd s from public.qualifier_queue where lead_id = $1", [lead]))[0].s)).toBeCloseTo(0.02, 6);
    for (const t of ["qualify_deep", "qualify_places", "profile_learn"]) await ins(t, 0);
    await expect(ins("nonsense", 0)).rejects.toThrow(/ai_calls_task/);

    expect((await db.try(as(UUID_D), "select * from public.ai_calls")).rows).toHaveLength(0); // closer
    expect((await db.try(as(UUID_A), "select * from public.ai_calls where lead_id = $1", [lead])).rows).toHaveLength(4);
    expect((await db.try(as(UUID_C), "select * from public.ai_calls where lead_id = $1", [lead])).rows).toHaveLength(4);

    // a settling update adds only the difference; a pending row counts at its reserve today
    const pend = await db.admin<{ id: string }>(
      "insert into public.ai_calls (workspace_id, user_id, lead_id, task, model, prompt_version, status, reserve_usd) values ($1,$2,$3,'qualify_deep','claude-sonnet-5-5','v1','pending',0.30) returning id",
      [wsA, UUID_A, lead],
    );
    expect(Number((await db.admin<{ s: string }>("select public.qualifier_spent_today($1) s", [wsA]))[0].s)).toBeCloseTo(0.32, 6);
    await db.admin("update public.ai_calls set status = 'ok', cost_usd = 0.12 where id = $1", [pend[0].id]);
    expect(Number((await db.admin<{ s: string }>("select spent_usd s from public.qualifier_queue where lead_id = $1", [lead]))[0].s)).toBeCloseTo(0.14, 6);
    expect(Number((await db.admin<{ s: string }>("select public.qualifier_spent_today($1) s", [wsA]))[0].s)).toBeCloseTo(0.14, 6);

    // deleting the lead keeps the ledger row (lead_id set null)
    await db.admin("delete from public.leads where id = $1", [lead]);
    expect(Number((await db.admin<{ n: string }>("select count(*) n from public.ai_calls where task like 'qualify_%' and lead_id is null"))[0].n)).toBe(4);
  });
});
