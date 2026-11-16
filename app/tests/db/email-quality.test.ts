import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, anon, as, openGates, UUID_B, UUID_C } from "./helpers";
import { CIPHER, createOwner } from "./scheduler-seed";

// Migration 0028 (Fase 2 items 6 and 7): e-mail checks, pattern guesses and the campaign rule. Fictional data only.
let db: TestDb;
let ws: string;
let wsB: string;
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
beforeAll(async () => {
  db = await TestDb.create();
  ws = await createOwner(db, OWNER);
  wsB = await createOwner(db, UUID_B);
  await db.addUser(UUID_C);
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'closer')", [ws, UUID_C]);
});
afterAll(async () => { await db.pg.close(); });

type Counts = { added: number; no_email: number };
type Field = { field: string; value: string; source?: string; seen?: string };
let n = 0;
async function newLead(fields: Field[], w = ws): Promise<string> {
  const id = (await db.admin<{ id: string }>("insert into public.leads (workspace_id, origin_kind) values ($1,'import') returning id", [w]))[0].id;
  for (const f of fields) {
    await db.admin(
      "insert into public.lead_fields (workspace_id, lead_id, field, value, source, seen_at) values ($1,$2,$3,$4,$5, now() - ($6::text)::interval)",
      [w, id, f.field, f.value, f.source ?? "import", f.seen ?? "1 day"],
    );
  }
  return id;
}
async function newCampaign(label: string): Promise<string> {
  const mb = (await db.query<{ id: string }>(as(OWNER), "select public.save_mailbox($1,$2,$3) as id", [ws, `sales-${label}@neair.example`, CIPHER]))[0].id;
  const id = (await db.query<{ id: string }>(as(OWNER), "insert into public.email_campaigns (workspace_id, name, mailbox_id) values ($1,$2,$3) returning id", [ws, label, mb]))[0].id;
  await openGates(db, id);
  return id;
}
const add = async (camp: string, leads: string[]) => (await db.query<{ r: Counts }>(as(OWNER), "select public.add_leads_to_campaign($1,$2::uuid[]) as r", [camp, leads]))[0].r;
const emailOf = async (camp: string, lead: string) =>
  (await db.admin<{ email: string | null }>("select email from public.email_prospects where campaign_id = $1 and lead_id = $2", [camp, lead]))[0]?.email;
/** The statement supabase-js upsert({ onConflict: "workspace_id,email" }) sends: every column it carries is updated. */
const check = (email: string, status: string, method = "mx", user = OWNER, w = ws) =>
  db.query(
    as(user),
    "insert into public.email_checks (workspace_id, email, status, method, detail) values ($1,$2,$3,$4,null) on conflict (workspace_id, email) do update set workspace_id = excluded.workspace_id, email = excluded.email, status = excluded.status, method = excluded.method, detail = excluded.detail",
    [w, email, status, method],
  );
const guess = (lead: string, value: string, status = "unverified", user = OWNER) =>
  db.try(as(user), "insert into public.lead_fields (workspace_id, lead_id, field, value, source, source_ref, status) values ($1,$2,'email',$3,'pattern','first.last',$4)", [ws, lead, value, status]);

describe("0028 e-mail quality", () => {
  test("MX invalid: the address never enters a campaign; the lead falls back to its next address or counts as no_email", async () => {
    const camp = await newCampaign(`inv${++n}`);
    const only = await newLead([{ field: "name", value: "Dead Co" }, { field: "email", value: "pat@dead-mx.example" }]);
    const two = await newLead([
      { field: "name", value: "Two Co" },
      { field: "email", value: "new@dead2-mx.example", seen: "1 hour" },
      { field: "email", value: "old@live-mx.example", seen: "3 days" },
    ]);
    await check("pat@dead-mx.example", "invalid");
    await check("new@dead2-mx.example", "invalid");
    expect(await add(camp, [only, two])).toMatchObject({ added: 1, no_email: 1 });
    expect(await emailOf(camp, only)).toBeUndefined();
    expect(await emailOf(camp, two)).toBe("old@live-mx.example");
    // catch_all and unknown still go in (the owner's call); only invalid is excluded
    const ca = await newLead([{ field: "name", value: "CA Co" }, { field: "email", value: "x@catchall-mx.example" }]);
    await check("x@catchall-mx.example", "catch_all");
    expect(await add(camp, [ca])).toMatchObject({ added: 1 });
  });

  test("any other prospect path: an invalid address is dropped on insert (the prospect stays without e-mail)", async () => {
    const camp = await newCampaign(`trg${++n}`);
    await check("bad@dead3-mx.example", "invalid");
    await db.admin("insert into public.email_prospects (workspace_id, campaign_id, company_name, email, email_source) values ($1,$2,'Raw Co','bad@dead3-mx.example','manual')", [ws, camp]);
    await db.admin("insert into public.email_prospects (workspace_id, campaign_id, company_name, email, email_source) values ($1,$2,'Ok Co','ok@live-mx.example','manual')", [ws, camp]);
    const rows = await db.admin<{ company_name: string; email: string | null; email_source: string | null }>("select company_name, email, email_source from public.email_prospects where campaign_id = $1 order by company_name", [camp]);
    expect(rows).toEqual([{ company_name: "Ok Co", email: "ok@live-mx.example", email_source: "manual" }, { company_name: "Raw Co", email: null, email_source: null }]);
  });

  test("pattern guesses: never sendable until the verifier says verified (an MX 'verified' is not enough)", async () => {
    const camp = await newCampaign(`pat${++n}`);
    const lead = await newLead([{ field: "name", value: "Guess Co" }]);
    expect((await guess(lead, "pat.doe@guess.example")).error).toBeUndefined(); // a sender may add a guess (rolled back here)
    await db.query(as(OWNER), "insert into public.lead_fields (workspace_id, lead_id, field, value, source, source_ref, status) values ($1,$2,'email','pat.doe@guess.example','pattern','first.last','unverified')", [ws, lead]);
    expect(await add(camp, [lead])).toMatchObject({ added: 0, no_email: 1 });
    await check("pat.doe@guess.example", "verified", "mx");
    expect(await add(camp, [lead])).toMatchObject({ added: 0, no_email: 1 });
    await check("pat.doe@guess.example", "verified", "verifier");
    expect(await add(camp, [lead])).toMatchObject({ added: 1 });
    expect(await emailOf(camp, lead)).toBe("pat.doe@guess.example");
  });

  test("a guess is not a fact: no level 1, not the list's e-mail, never 'confirmed'", async () => {
    const lead = await newLead([{ field: "name", value: "Level Co" }]);
    await db.query(as(OWNER), "insert into public.lead_fields (workspace_id, lead_id, field, value, source, source_ref, status) values ($1,$2,'email','x@level.example','pattern','first','unverified')", [ws, lead]);
    expect((await db.admin<{ level: number }>("select level from public.leads where id = $1", [lead]))[0].level).toBe(0);
    const v = await db.query<{ email: string | null }>(as(OWNER), "select email from public.lead_contact_values($1) where lead_id = $2", [ws, lead]);
    expect(v).toEqual([{ email: null }]);
    expect((await guess(lead, "y@level.example", "confirmed")).error?.message).toMatch(/row-level security/);
    await expect(db.admin("insert into public.lead_fields (workspace_id, lead_id, field, value, source, status) values ($1,$2,'email','z@level.example','pattern','confirmed')", [ws, lead])).rejects.toThrow(/lead_fields_pattern_unverified/);
  });

  test("RLS: senders read and write their workspace's checks; the closer, another workspace and anon get nothing", async () => {
    await check("rls@acme-rls.example", "verified");
    expect(await db.query(as(OWNER), "select status from public.email_checks where email = 'rls@acme-rls.example'")).toEqual([{ status: "verified" }]);
    const stamped = await db.admin<{ checked_by: string }>("select checked_by from public.email_checks where workspace_id = $1 and email = 'rls@acme-rls.example'", [ws]);
    expect(stamped[0].checked_by).toBe(OWNER);
    expect(await db.query(as(UUID_C), "select 1 from public.email_checks")).toHaveLength(0);
    expect(await db.query(as(UUID_B), "select 1 from public.email_checks where workspace_id = $1", [ws])).toHaveLength(0);
    expect((await db.try(as(UUID_C), "insert into public.email_checks (workspace_id, email, status, method) values ($1,'c@x.example','verified','mx')", [ws])).error?.message).toMatch(/row-level security/);
    expect((await db.try(as(UUID_B), "insert into public.email_checks (workspace_id, email, status, method) values ($1,'b@x.example','verified','mx')", [ws])).error?.message).toMatch(/row-level security/);
    expect((await db.try(anon, "select 1 from public.email_checks")).error?.message).toMatch(/permission denied/);
    // a closer cannot add guesses either, and nobody can delete checks
    const lead = await newLead([{ field: "name", value: "Closer Co" }]);
    expect((await guess(lead, "c@closer.example", "unverified", UUID_C)).error?.message).toMatch(/row-level security/);
    expect((await db.try(as(OWNER), "delete from public.email_checks where workspace_id = $1", [ws])).error?.message).toMatch(/permission denied/);
    expect(wsB).toBeTruthy();
  });

  test("ai_calls accepts the lead_search task", async () => {
    const def = await db.admin<{ d: string }>("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'ai_calls_task'");
    expect(def[0].d).toContain("lead_search");
  });
});
