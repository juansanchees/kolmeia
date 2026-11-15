import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, anonWithToken, as, openGates, setSchedulerToken, UUID_A } from "./helpers";
import { CIPHER, TOKEN, createOwner } from "./scheduler-seed";

// Migration 0022 (F4 Task 3, C2): the lead's status is the truth. A lead that is discarded, marked do_not_call or moved
// on (D5: with_closer, meeting, won, lost) stops every campaign it is in, and the shared claim (click and clock) never
// takes its messages. Fictional data only.
let db: TestDb;
let ws: string;
beforeAll(async () => {
  db = await TestDb.create();
  ws = await createOwner(db);
});
afterAll(async () => { await db.pg.close(); });

type Claim = { outcome: string; message_id?: string; wait_until?: string };
const HOLDER = "55555555-5555-4555-8555-555555555555";
let n = 0;

async function newLead(email: string): Promise<string> {
  const id = (await db.admin<{ id: string }>("insert into public.leads (workspace_id, origin_kind) values ($1,'import') returning id", [ws]))[0].id;
  await db.admin("insert into public.lead_fields (workspace_id, lead_id, field, value, source) values ($1,$2,'name',$3,'import'), ($1,$2,'email',$4,'import')", [ws, id, `Co ${++n}`, email]);
  return id;
}
async function newCampaign(label: string): Promise<string> {
  const mb = (await db.query<{ id: string }>(as(UUID_A), "select public.save_mailbox($1,$2,$3) as id", [ws, `sales-${label}@neair.example`, CIPHER]))[0].id;
  const id = (await db.query<{ id: string }>(as(UUID_A), "insert into public.email_campaigns (workspace_id, name, mailbox_id) values ($1,$2,$3) returning id", [ws, label, mb]))[0].id;
  await openGates(db, id);
  return id;
}
/** Approved step messages for a prospect (step 1 due now; later steps wait for step 1). */
async function approvedSteps(camp: string, prospect: string, steps = [1]): Promise<string[]> {
  const ids: string[] = [];
  for (const step of steps) {
    const id = (await db.query<{ id: string }>(as(UUID_A),
      "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body, ai_drafted) values ($1,$2,$3,'sequence',$4,'Quick question','Hi, who handles HVAC?',false) returning id",
      [ws, camp, prospect, step]))[0].id;
    await db.query(as(UUID_A), "select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')", [id]);
    ids.push(id);
  }
  return ids;
}
/** A lead put into a fresh active campaign with approved steps. */
async function leadInCampaign(label: string, steps = [1]) {
  const lead = await newLead(`pat@${label}.example`);
  const camp = await newCampaign(label);
  await db.query(as(UUID_A), "select public.add_leads_to_campaign($1,array[$2]::uuid[])", [camp, lead]);
  const prospect = (await db.admin<{ id: string }>("select id from public.email_prospects where campaign_id = $1 and lead_id = $2", [camp, lead]))[0].id;
  const messages = await approvedSteps(camp, prospect, steps);
  await db.query(as(UUID_A), "update public.email_campaigns set status = 'active' where id = $1", [camp]);
  return { lead, camp, prospect, messages };
}
const click = async (camp: string) =>
  (await db.query<{ r: Claim }>(as(UUID_A), "select public.claim_next_email($1,$2) as r", [camp, HOLDER]))[0].r;
async function clock(camp: string): Promise<Claim> {
  await setSchedulerToken(db, TOKEN);
  const c = anonWithToken(TOKEN);
  const run = (await db.query<{ r: { run_id: string } }>(c, "select public.scheduler_begin_run() as r"))[0].r.run_id;
  const r = (await db.query<{ r: Claim }>(c, "select public.scheduler_claim_next_email($1,$2) as r", [run, camp]))[0].r;
  await db.query(c, "select public.scheduler_finish_run($1,'{}'::jsonb,null)", [run]);
  return r;
}
const prospect = async (id: string) =>
  (await db.admin<{ status: string; stop_reason: string | null }>("select status, stop_reason from public.email_prospects where id = $1", [id]))[0];
const messages = async (ids: string[]) =>
  db.admin<{ status: string; cancel_reason: string | null }>("select status, cancel_reason from public.email_messages where id = any($1::uuid[]) order by step", [ids]);
const lock = async (lead: string) => db.admin("select 1 from public.lead_campaign_locks where lead_id = $1", [lead]);

describe("0022 the lead status is the truth (C2)", () => {
  test("C2 a discarded lead's due message is never claimed, by click or by clock; its prospect is stopped and its steps cancelled", async () => {
    // the claim alone (trigger switched off, superuser test setup): the due message is skipped and swept
    const a = await leadInCampaign("c2-gate");
    await db.pg.exec("alter table public.leads disable trigger stop_email_on_lead_block");
    await db.admin("update public.leads set status = 'discarded' where id = $1", [a.lead]);
    await db.pg.exec("alter table public.leads enable trigger stop_email_on_lead_block");
    expect((await prospect(a.prospect)).status).toBe("active");
    expect((await clock(a.camp)).outcome).toBe("nothing_due");
    expect((await click(a.camp)).outcome).toBe("nothing_due");
    expect(await prospect(a.prospect)).toEqual({ status: "stopped", stop_reason: "lead_discarded" });
    expect(await messages(a.messages)).toEqual([{ status: "cancelled", cancel_reason: "lead_discarded" }]);

    // the trigger: discarding stops the prospect and cancels its steps at once; nothing is claimed afterwards
    const b = await leadInCampaign("c2-trig", [1, 2]);
    await db.admin("update public.leads set status = 'discarded' where id = $1", [b.lead]);
    expect(await prospect(b.prospect)).toEqual({ status: "stopped", stop_reason: "lead_discarded" });
    expect(await messages(b.messages)).toEqual([
      { status: "cancelled", cancel_reason: "lead_discarded" },
      { status: "cancelled", cancel_reason: "lead_discarded" },
    ]);
    expect(await lock(b.lead)).toHaveLength(0);
    expect((await clock(b.camp)).outcome).toBe("nothing_due");
    expect((await click(b.camp)).outcome).toBe("nothing_due");
    expect(await db.admin("select 1 from public.email_send_log where prospect_id = any($1::uuid[])", [[a.prospect, b.prospect]])).toHaveLength(0);

    // D5: a lead marked lost by the sdr (client path, set_lead_status) stops too
    const d = await leadInCampaign("c2-d5");
    await db.query(as(UUID_A), "select public.set_lead_status($1,'lost')", [d.lead]);
    expect(await prospect(d.prospect)).toEqual({ status: "stopped", stop_reason: "lead_status" });
    expect(await messages(d.messages)).toEqual([{ status: "cancelled", cancel_reason: "lead_status" }]);
  });

  test("C2 a prospect reached only through its research candidate is stopped too", async () => {
    const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(as(UUID_A), sql, params);
    const run = (await q<{ id: string }>("insert into public.research_runs (workspace_id, title, request_text) values ($1,'cand','builders') returning id", [ws]))[0].id;
    const cand = (await q<{ id: string }>(
      "insert into public.research_candidates (workspace_id, run_id, name, name_key, website, public_email) values ($1,$2,'Cand Co','cand co','https://candco.example','office@candco.example') returning id",
      [ws, run]))[0].id;
    await q("update public.research_candidates set user_decision = 'keep' where id = $1", [cand]);
    await q("select public.add_research_check($1,'has_work',1,'ok','tem obra',$2::jsonb)", [cand, JSON.stringify([{ url: "https://permits.example/cand", title: "Permit", excerpt: "Contact office@candco.example" }])]);
    const list = (await q<{ id: string }>("select public.create_research_list($1,'Lista') as id", [run]))[0].id;
    const mb = (await q<{ id: string }>("select public.save_mailbox($1,'sales-cand@neair.example',$2) as id", [ws, CIPHER]))[0].id;
    const camp = (await q<{ id: string }>("insert into public.email_campaigns (workspace_id, list_id, name, mailbox_id) values ($1,$2,'cand',$3) returning id", [ws, list, mb]))[0].id;
    await q("select public.import_list_into_campaign($1)", [camp]);
    const p = (await db.admin<{ id: string; lead_id: string | null }>("select id, lead_id from public.email_prospects where campaign_id = $1", [camp]))[0];
    // the candidate became a lead after the import: the prospect has no lead_id of its own
    const lead = await newLead("office@candco.example");
    await db.admin("update public.research_candidates set lead_id = $2 where id = $1", [cand, lead]);
    expect((await db.admin<{ lead_id: string | null }>("select lead_id from public.email_prospects where id = $1", [p.id]))[0].lead_id).toBeNull();
    const msgs = await approvedSteps(camp, p.id);
    await db.admin("update public.leads set do_not_call = true where id = $1", [lead]);
    expect(await prospect(p.id)).toEqual({ status: "stopped", stop_reason: "do_not_call" });
    expect(await messages(msgs)).toEqual([{ status: "cancelled", cancel_reason: "do_not_call" }]);
  });

  test("do_not_call during a claim: the message already 'sending' finishes, the next step is cancelled", async () => {
    const s = await leadInCampaign("c2-dnc", [1, 2]);
    const c = await click(s.camp);
    expect(c).toEqual({ outcome: "claimed", message_id: s.messages[0] });
    await db.admin("update public.leads set do_not_call = true where id = $1", [s.lead]);
    expect(await prospect(s.prospect)).toEqual({ status: "stopped", stop_reason: "do_not_call" });
    expect(await messages(s.messages)).toEqual([
      { status: "sending", cancel_reason: null },
      { status: "cancelled", cancel_reason: "do_not_call" },
    ]);
    await db.query(as(UUID_A), "select public.finish_email_send($1,$2,'dry_run',null)", [c.message_id, HOLDER]);
    expect(await messages(s.messages)).toEqual([
      { status: "dry_run", cancel_reason: null },
      { status: "cancelled", cancel_reason: "do_not_call" },
    ]);
  });

  test("un-discarding a lead does not restart anything", async () => {
    const s = await leadInCampaign("c2-undo", [1, 2]);
    await db.admin("update public.leads set status = 'discarded' where id = $1", [s.lead]);
    await db.admin("update public.leads set status = 'new' where id = $1", [s.lead]);
    expect(await prospect(s.prospect)).toEqual({ status: "stopped", stop_reason: "lead_discarded" });
    expect((await messages(s.messages)).map((m) => m.status)).toEqual(["cancelled", "cancelled"]);
    expect(await lock(s.lead)).toHaveLength(0);
    expect((await click(s.camp)).outcome).toBe("nothing_due");
  });

  test("a lead with no blocks sends as before, by click and by clock", async () => {
    const a = await leadInCampaign("c2-ok-click");
    expect(await click(a.camp)).toEqual({ outcome: "claimed", message_id: a.messages[0] });
    const b = await leadInCampaign("c2-ok-clock");
    // an unrelated change of the lead (still allowed to get e-mail) stops nothing
    await db.admin("update public.leads set status = 'call_list' where id = $1", [b.lead]);
    expect((await prospect(b.prospect)).status).toBe("active");
    expect(await clock(b.camp)).toEqual({ outcome: "claimed", message_id: b.messages[0] });
  });
});
