import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { MIGRATION_PATHS, TestDb, anon, as, openGates, UUID_A, UUID_B, UUID_C } from "./helpers";
import { CIPHER, createOwner } from "./scheduler-seed";

// Migration 0021 (F4 Task 2): leads go into campaigns with a sourced address (R18), one active campaign per lead (C3),
// the lead moves forward only, add_leads_to_campaign, and old research-list campaigns keep working. Fictional data only.
let db: TestDb;
let ws: string;
let wsB: string;
beforeAll(async () => {
  db = await TestDb.create();
  ws = await createOwner(db);
  wsB = await createOwner(db, UUID_B);
  await db.addUser(UUID_C);
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'closer')", [ws, UUID_C]);
});
afterAll(async () => { await db.pg.close(); });

type Counts = { added: number; no_email: number; blocked: number; in_other_campaign: number; suppressed: number; already: number };
type Field = { field: string; value: string; source?: string; source_ref?: string | null; status?: string; seen?: string };
const HOLDER = "44444444-4444-4444-8444-444444444444";
let n = 0;

/** A lead with its fields (superuser setup: leads come from imports/agents in the app). */
async function newLead(fields: Field[], opts: { status?: string; doNotCall?: boolean; workspace?: string } = {}): Promise<string> {
  const w = opts.workspace ?? ws;
  const id = (await db.admin<{ id: string }>("insert into public.leads (workspace_id, origin_kind) values ($1,'import') returning id", [w]))[0].id;
  for (const f of fields) {
    await db.admin(
      "insert into public.lead_fields (workspace_id, lead_id, field, value, source, source_ref, status, seen_at) values ($1,$2,$3,$4,$5,$6,$7, now() - ($8::text)::interval)",
      [w, id, f.field, f.value, f.source ?? "import", f.source_ref ?? null, f.status ?? "unverified", f.seen ?? "1 day"],
    );
  }
  if (opts.status || opts.doNotCall) {
    await db.admin("update public.leads set status = coalesce($2, status), do_not_call = $3 where id = $1", [id, opts.status ?? null, !!opts.doNotCall]);
  }
  return id;
}
const leadWithEmail = (email: string, name = `Co ${++n}`) => newLead([{ field: "name", value: name }, { field: "email", value: email }]);

/** A rehearsal campaign of the workspace with its own mailbox (gates always open). */
async function newCampaign(label: string, user = UUID_A, w = ws): Promise<string> {
  const mb = (await db.query<{ id: string }>(as(user), "select public.save_mailbox($1,$2,$3) as id", [w, `sales-${label}@neair.example`, CIPHER]))[0].id;
  const id = (await db.query<{ id: string }>(as(user), "insert into public.email_campaigns (workspace_id, name, mailbox_id) values ($1,$2,$3) returning id", [w, label, mb]))[0].id;
  await openGates(db, id);
  return id;
}
const add = async (camp: string, leads: string[], user = UUID_A) =>
  (await db.query<{ r: Counts }>(as(user), "select public.add_leads_to_campaign($1,$2::uuid[]) as r", [camp, leads]))[0].r;
const prospectOf = async (camp: string, lead: string) =>
  (await db.admin<{ id: string; status: string; stop_reason: string | null; email: string | null; email_source: string | null; email_source_ref: string | null; company_name: string; contact_name: string | null; contact_title: string | null }>(
    "select id, status, stop_reason, email, email_source, email_source_ref, company_name, contact_name, contact_title from public.email_prospects where campaign_id = $1 and lead_id = $2",
    [camp, lead],
  ))[0];
const lockOf = async (lead: string) =>
  (await db.admin<{ campaign_id: string; prospect_id: string }>("select campaign_id, prospect_id from public.lead_campaign_locks where lead_id = $1", [lead]))[0];
const leadStatus = async (lead: string) => (await db.admin<{ status: string }>("select status from public.leads where id = $1", [lead]))[0].status;
const setCampaign = (camp: string, status: string) => db.query(as(UUID_A), "update public.email_campaigns set status = $2 where id = $1", [camp, status]);
const setProspect = (p: string, status: string) => db.try(as(UUID_A), "update public.email_prospects set status = $2 where id = $1 returning id", [p, status]);
const zero: Counts = { added: 0, no_email: 0, blocked: 0, in_other_campaign: 0, suppressed: 0, already: 0 };

describe("0021 leads into campaigns", () => {
  test("R18 a lead address carries its source; a refuted e-mail is never used; no e-mail field means no prospect", async () => {
    const camp = await newCampaign("r18");
    const confirmed = await newLead([
      { field: "name", value: "Acme Builders" },
      { field: "contact_name", value: "Pat Doe" },
      { field: "contact_title", value: "Owner" },
      { field: "email", value: "wrong@acme-r18.example", status: "refuted", seen: "1 minute" },
      { field: "email", value: "newer@acme-r18.example", source: "site", source_ref: "https://acme-r18.example/contact", seen: "1 hour" },
      { field: "email", value: "Boss@Acme-R18.example", status: "confirmed", seen: "10 days" },
    ]);
    const newest = await newLead([
      { field: "name", value: "Beta Builders" },
      { field: "email", value: "old@beta-r18.example", seen: "5 days" },
      { field: "email", value: "new@beta-r18.example", source: "site", source_ref: "https://beta-r18.example/team", seen: "1 day" },
    ]);
    const onlyRefuted = await newLead([{ field: "name", value: "Gamma" }, { field: "email", value: "x@gamma-r18.example", status: "refuted" }]);
    const noEmail = await newLead([{ field: "name", value: "Delta" }, { field: "phone", value: "5082906144" }]);
    expect(await add(camp, [confirmed, newest, onlyRefuted, noEmail])).toEqual({ ...zero, added: 2, no_email: 2 });

    const fid = (await db.admin<{ id: string }>("select id from public.lead_fields where lead_id = $1 and status = 'confirmed'", [confirmed]))[0].id;
    expect(await prospectOf(camp, confirmed)).toMatchObject({
      email: "boss@acme-r18.example", email_source: "lead", email_source_ref: `import:${fid}`,
      company_name: "Acme Builders", contact_name: "Pat Doe", contact_title: "Owner", status: "active",
    });
    expect(await prospectOf(camp, newest)).toMatchObject({ email: "new@beta-r18.example", email_source_ref: "site:https://beta-r18.example/team" });
    expect(await prospectOf(camp, onlyRefuted)).toBeUndefined();
    expect(await prospectOf(camp, noEmail)).toBeUndefined();
    // the check itself: a 'lead' address without its source is refused
    const raw = await db.admin<{ ok: boolean }>(
      `select exists (select 1 from pg_constraint where conname = 'email_prospects_r18' and pg_get_constraintdef(oid) like '%lead%') as ok`,
    );
    expect(raw[0].ok).toBe(true);
    await expect(db.admin("update public.email_prospects set email_source_ref = null where campaign_id = $1", [camp])).rejects.toThrow(/email_prospects_r18/);
    // a person typing an address makes it 'manual' and drops the lead source
    const p = (await prospectOf(camp, newest)).id;
    await db.query(as(UUID_A), "update public.email_prospects set email = 'typed@beta-r18.example' where id = $1", [p]);
    expect(await prospectOf(camp, newest)).toMatchObject({ email: "typed@beta-r18.example", email_source: "manual", email_source_ref: null });
  });

  test("C3 one active campaign per lead: a second campaign gets the prospect stopped as in_other_campaign; reactivating it raises 23505; the lock frees when the first campaign is done", async () => {
    const lead = await leadWithEmail("pat@c3.example");
    const one = await newCampaign("c3a");
    const two = await newCampaign("c3b");
    expect(await add(two, [lead])).toEqual({ ...zero, added: 1 });
    const p2 = (await prospectOf(two, lead)).id;
    expect(await lockOf(lead)).toEqual({ campaign_id: two, prospect_id: p2 });
    // skipping frees the lock; another campaign takes it
    expect((await setProspect(p2, "skipped")).error).toBeUndefined();
    await db.query(as(UUID_A), "update public.email_prospects set status = 'skipped' where id = $1", [p2]);
    expect(await lockOf(lead)).toBeUndefined();
    expect(await add(one, [lead])).toEqual({ ...zero, added: 1 });
    const p1 = (await prospectOf(one, lead)).id;
    expect(await lockOf(lead)).toEqual({ campaign_id: one, prospect_id: p1 });
    // un-skipping in the other campaign is refused
    const back = await setProspect(p2, "active");
    expect(back.error?.message).toMatch(/C3: lead already in an active campaign/);
    expect((back.error as { code?: string }).code).toBe("23505");
    // adding again says where it is; a direct insert elsewhere (any path) is stopped, not active
    const three = await newCampaign("c3c");
    expect(await add(three, [lead])).toEqual({ ...zero, in_other_campaign: 1 });
    expect(await prospectOf(three, lead)).toBeUndefined();
    await db.admin("insert into public.email_prospects (workspace_id, campaign_id, lead_id, company_name) values ($1,$2,$3,'Direct')", [ws, three, lead]);
    expect(await prospectOf(three, lead)).toMatchObject({ status: "stopped", stop_reason: "in_other_campaign" });
    expect((await lockOf(lead)).campaign_id).toBe(one);
    // the first campaign ends: its lock is freed, the other prospect may come back
    await setCampaign(one, "done");
    expect(await lockOf(lead)).toBeUndefined();
    expect((await setProspect(p2, "active")).error).toBeUndefined();
    await db.query(as(UUID_A), "update public.email_prospects set status = 'active' where id = $1", [p2]);
    expect(await lockOf(lead)).toEqual({ campaign_id: two, prospect_id: p2 });
    // reopening the first campaign does not steal the lead back: its prospect is stopped
    await setCampaign(one, "active");
    expect(await prospectOf(one, lead)).toMatchObject({ status: "stopped", stop_reason: "in_other_campaign" });
    expect(await lockOf(lead)).toEqual({ campaign_id: two, prospect_id: p2 });
    // archiving frees it too
    await setCampaign(two, "archived");
    expect(await lockOf(lead)).toBeUndefined();
    // clients cannot write locks
    expect((await db.try(as(UUID_A), "insert into public.lead_campaign_locks (lead_id, workspace_id, campaign_id, prospect_id) values ($1,$2,$3,$4)", [lead, ws, two, p2])).error?.message).toMatch(/permission denied/);
    expect((await db.try(as(UUID_A), "delete from public.lead_campaign_locks where lead_id = $1", [lead])).error?.message).toMatch(/permission denied/);
  });

  test("the lead moves forward only: in_campaign on lock, replied on reply; a won lead is not moved back", async () => {
    const camp = await newCampaign("fwd");
    const mb = (await db.admin<{ mailbox_id: string }>("select mailbox_id from public.email_campaigns where id = $1", [camp]))[0].mailbox_id;
    const fresh = await leadWithEmail("a@fwd1.example");
    const called = await leadWithEmail("b@fwd2.example");
    await db.admin("update public.leads set status = 'call_list' where id = $1", [called]);
    const later = await leadWithEmail("c@fwd3.example");
    expect(await add(camp, [fresh, called, later])).toEqual({ ...zero, added: 3 });
    expect(await leadStatus(fresh)).toBe("in_campaign");
    expect(await leadStatus(called)).toBe("in_campaign");
    const reply = (p: string, rfc: string) =>
      db.query(as(UUID_A), "select public.record_email_reply($1,$2,null,'x@y.example','Re: hi','thanks',$3,now(),'reply',null)", [p, mb, rfc]);
    await reply((await prospectOf(camp, fresh)).id, "<fwd-1@test>");
    expect(await leadStatus(fresh)).toBe("replied");
    expect(await lockOf(fresh)).toBeUndefined();
    // won while in the campaign: a reply afterwards does not move it back
    await db.admin("update public.leads set status = 'won' where id = $1", [later]);
    await reply((await prospectOf(camp, later)).id, "<fwd-3@test>");
    expect(await leadStatus(later)).toBe("won");
  });

  test("add_leads_to_campaign counts every outcome and refuses another workspace, a closer and 501 ids", async () => {
    const camp = await newCampaign("cnt");
    const elsewhere = await newCampaign("cnt-other");
    const ok = await leadWithEmail("ok@cnt1.example");
    const noEmail = await newLead([{ field: "name", value: "No Mail" }]);
    const discarded = await newLead([{ field: "email", value: "d@cnt2.example" }], { status: "discarded" });
    const dnc = await newLead([{ field: "email", value: "n@cnt3.example" }], { doNotCall: true });
    const withCloser = await newLead([{ field: "email", value: "w@cnt4.example" }], { status: "with_closer" });
    const busy = await leadWithEmail("busy@cnt5.example");
    await add(elsewhere, [busy]);
    const suppressed = await leadWithEmail("gone@cnt6.example");
    await db.query(as(UUID_A), "insert into public.suppressions (workspace_id, kind, value, reason) values ($1,'domain','cnt6.example','manual')", [ws]);
    expect(await add(camp, [ok, noEmail, discarded, dnc, withCloser, busy, suppressed, ok])).toEqual({
      added: 1, no_email: 1, blocked: 3, in_other_campaign: 1, suppressed: 1, already: 0,
    });
    expect(await add(camp, [ok])).toEqual({ ...zero, already: 1 });
    // a lead of another workspace is not touched
    const foreign = await newLead([{ field: "email", value: "f@cnt7.example" }], { workspace: wsB });
    expect(await add(camp, [foreign])).toEqual(zero);
    expect(await db.admin("select 1 from public.email_prospects where lead_id = $1", [foreign])).toHaveLength(0);
    await expect(db.admin("insert into public.email_prospects (workspace_id, campaign_id, lead_id, company_name) values ($1,$2,$3,'X')", [ws, camp, foreign])).rejects.toThrow(/lead not in this workspace/);

    const err = async (sql: string, params: unknown[], user: string | null) => (await db.try(user ? as(user) : anon, sql, params)).error;
    const call = "select public.add_leads_to_campaign($1,$2::uuid[])";
    expect((await err(call, [camp, [ok]], UUID_B))?.message).toMatch(/not allowed/);
    expect((await err(call, [camp, [ok]], UUID_C))?.message).toMatch(/not allowed/);
    expect((await err(call, [camp, [ok]], null))?.message).toMatch(/permission denied/);
    const many = Array.from({ length: 501 }, () => "00000000-0000-4000-8000-000000000000");
    const tooMany = await err(call, [camp, many], UUID_A);
    expect((tooMany as { code?: string }).code).toBe("22023");
    expect((await err(call, [camp, many.slice(0, 500)], UUID_A))).toBeUndefined();
    const archived = await newCampaign("cnt-arch");
    await setCampaign(archived, "archived");
    expect((await err(call, [archived, [ok]], UUID_A))?.message).toMatch(/archived/);

    // the closer reads the prospect of the lead assigned to her (one assignment: leads.owner_id)
    expect(await db.query(as(UUID_C), "select id from public.email_prospects where lead_id = $1", [ok])).toHaveLength(0);
    await db.admin("update public.leads set owner_id = $2 where id = $1", [ok, UUID_C]);
    expect(await db.query(as(UUID_C), "select id from public.email_prospects where lead_id = $1", [ok])).toHaveLength(1);
    expect(await db.query(as(UUID_C), "select lead_id from public.lead_campaign_locks")).toHaveLength(0);
    expect(await db.query(as(UUID_A), "select lead_id from public.lead_campaign_locks where lead_id = $1", [ok])).toHaveLength(1);
    expect(await db.query(as(UUID_B), "select lead_id from public.lead_campaign_locks where lead_id = $1", [ok])).toHaveLength(0);
  });

  test("E2 one person per company holds across campaigns", async () => {
    const c1 = await newCampaign("e2a");
    const c2 = await newCampaign("e2b");
    const l1 = await leadWithEmail("pat@samecorp-e2.example", "Same Corp");
    const l2 = await leadWithEmail("lee@samecorp-e2.example", "Same Corp East");
    await add(c1, [l1]);
    await add(c2, [l2]);
    for (const [camp, lead] of [[c1, l1], [c2, l2]] as const) {
      const p = (await prospectOf(camp, lead)).id;
      const m = (await db.query<{ id: string }>(as(UUID_A),
        "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body, ai_drafted) values ($1,$2,$3,'sequence',1,'Quick question','Hi, who handles HVAC?',false) returning id",
        [ws, camp, p]))[0].id;
      await db.query(as(UUID_A), "select public.set_email_approval(array[$1]::uuid[], (select array_agg(updated_at) from public.email_messages where id = $1), 'approve')", [m]);
      await setCampaign(camp, "active");
    }
    const claim = async (camp: string) => (await db.query<{ r: { outcome: string; message_id?: string } }>(as(UUID_A), "select public.claim_next_email($1,$2) as r", [camp, HOLDER]))[0].r;
    const first = await claim(c1);
    expect(first.outcome).toBe("claimed");
    await db.query(as(UUID_A), "select public.finish_email_send($1,$2,'dry_run',null)", [first.message_id, HOLDER]);
    expect((await claim(c2)).outcome).toBe("nothing_due");
  });

  test("old research-list campaigns keep working and get lead_id from the candidate", async () => {
    const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(as(UUID_A), sql, params);
    const run = (await q<{ id: string }>("insert into public.research_runs (workspace_id, title, request_text) values ($1,'old','builders') returning id", [ws]))[0].id;
    const cand = (await q<{ id: string }>(
      "insert into public.research_candidates (workspace_id, run_id, name, name_key, website, public_email) values ($1,$2,'Old Co','old co','https://oldco.example','office@oldco.example') returning id",
      [ws, run]))[0].id;
    await q("update public.research_candidates set user_decision = 'keep' where id = $1", [cand]);
    await q("select public.add_research_check($1,'has_work',1,'ok','tem obra',$2::jsonb)", [cand, JSON.stringify([{ url: "https://permits.example/old", title: "Permit", excerpt: "Contact office@oldco.example" }])]);
    const lead = await newLead([{ field: "name", value: "Old Co" }]);
    await db.admin("update public.research_candidates set lead_id = $2 where id = $1", [cand, lead]);
    const list = (await q<{ id: string }>("select public.create_research_list($1,'Lista') as id", [run]))[0].id;
    const mb = (await q<{ id: string }>("select public.save_mailbox($1,'sales-old@neair.example',$2) as id", [ws, CIPHER]))[0].id;
    const camp = (await q<{ id: string }>("insert into public.email_campaigns (workspace_id, list_id, name, mailbox_id) values ($1,$2,'old',$3) returning id", [ws, list, mb]))[0].id;
    expect((await q<{ n: number }>("select public.import_list_into_campaign($1) as n", [camp]))[0].n).toBe(1);
    expect(await prospectOf(camp, lead)).toMatchObject({ status: "active", email: "office@oldco.example", email_source: "research" });
    expect((await lockOf(lead)).campaign_id).toBe(camp);
    expect(await leadStatus(lead)).toBe("in_campaign");
  });
});

describe("0021 is re-runnable after 0022 (I1)", () => {
  test("a prospect stopped with 'lead_status' (0022) survives re-running 0021", async () => {
    const lead = await leadWithEmail("rerun@rerun.example");
    const camp = await newCampaign("rerun");
    await db.query(as(UUID_A), "select public.add_leads_to_campaign($1,$2::uuid[])", [camp, [lead]]);
    await db.admin("update public.leads set status = 'won' where id = $1", [lead]);
    await db.admin("update public.email_prospects set status = 'stopped', stop_reason = 'lead_status' where lead_id = $1", [lead]);
    const file = MIGRATION_PATHS.find((f) => f.endsWith("0021_lead_campaigns.sql"))!;
    await db.pg.exec(readFileSync(file, "utf8")); // must not raise 23514
    expect(await db.admin("select stop_reason from public.email_prospects where lead_id = $1", [lead])).toEqual([{ stop_reason: "lead_status" }]);
  });
});
