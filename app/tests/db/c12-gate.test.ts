import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, anon, as, UUID_A, UUID_B, UUID_C } from "./helpers";
import { createOwner, seedCampaign } from "./scheduler-seed";
import { approveAllC12, C12_ITEMS } from "./c12-seed";

// Migration 0018 (C12): real sending needs the owner's checklist (mailboxes, separate sending domain, SPF, DKIM, DMARC,
// warm-up, physical address). Every item is a person's approval with a written evidence note; nothing is auto-verified.

const UUID_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // closer in workspace A
const HOLDER = "33333333-3333-4333-8333-333333333333";

let db: TestDb;
let ws: string;
let wsB: string;
beforeAll(async () => {
  db = await TestDb.create();
  ws = await createOwner(db);
  wsB = await createOwner(db, UUID_B);
  await db.addUser(UUID_C);
  await db.addUser(UUID_D);
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr'),($1,$3,'closer')", [ws, UUID_C, UUID_D]);
});
afterAll(async () => { await db.pg.close(); });

const approve = (user: string, item: string, evidence = "MXToolbox pass 15/11", workspace = ws) =>
  db.try(as(user), "select public.approve_c12_item($1,$2,$3)", [workspace, item, evidence]);
const goReal = (user: string, camp: string) => db.try(as(user), "select public.set_campaign_send_mode($1,'real')", [camp]);
const claim = async (camp: string) => (await db.query<{ r: { outcome: string } }>(as(UUID_A), "select public.claim_next_email($1,$2) as r", [camp, HOLDER]))[0].r;
const ready = async (workspace: string) => (await db.admin<{ r: boolean }>("select public.c12_ready($1) as r", [workspace]))[0].r;

/** A campaign that passes every older R4 check: complete sender profile and a verified mailbox. */
async function readyCampaign(label: string, workspace = ws, owner = UUID_A) {
  const s = await seedCampaign(db, workspace, label, { userId: owner });
  await db.query(as(owner), "select public.set_mailbox_verified($1, true, null)", [s.mailbox]);
  return s;
}

describe("0018 C12 checklist table", () => {
  test("RLS forced; owner and sdr read; closer, another workspace and anon do not; no direct writes", async () => {
    expect((await db.admin("select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.c12_approvals'::regclass"))[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect((await approve(UUID_A, "spf")).error).toBeUndefined();
    await db.query(as(UUID_A), "select public.approve_c12_item($1,'spf','MXToolbox SPF pass 15/11')", [ws]);
    expect(await db.query(as(UUID_A), "select item from public.c12_approvals where workspace_id = $1", [ws])).toEqual([{ item: "spf" }]);
    expect(await db.query(as(UUID_C), "select item from public.c12_approvals where workspace_id = $1", [ws])).toHaveLength(1);
    expect(await db.query(as(UUID_D), "select item from public.c12_approvals where workspace_id = $1", [ws])).toHaveLength(0);
    expect(await db.query(as(UUID_B), "select item from public.c12_approvals where workspace_id = $1", [ws])).toHaveLength(0);
    expect((await db.try(anon, "select 1 from public.c12_approvals")).error?.message).toMatch(/permission denied/);
    const ins = "insert into public.c12_approvals (workspace_id, item, evidence, approved_by) values ($1,'dkim','x',$2)";
    expect((await db.try(as(UUID_A), ins, [ws, UUID_A])).error?.message).toMatch(/permission denied/);
    expect((await db.try(as(UUID_A), "update public.c12_approvals set evidence = 'x' where workspace_id = $1", [ws])).error?.message).toMatch(/permission denied/);
    expect((await db.try(as(UUID_A), "delete from public.c12_approvals where workspace_id = $1", [ws])).error?.message).toMatch(/permission denied/);
  });

  test("only an owner of that workspace approves; sdr, closer and another owner are refused", async () => {
    expect((await approve(UUID_C, "dkim")).error?.message).toMatch(/only an owner/);
    expect((await approve(UUID_D, "dkim")).error?.message).toMatch(/only an owner/);
    expect((await approve(UUID_B, "dkim")).error?.message).toMatch(/only an owner/);
    expect((await db.try(anon, "select public.approve_c12_item($1,'dkim','x')", [ws])).error?.message).toMatch(/permission denied/);
  });

  test("evidence note is required and short; the item must be one of the 7", async () => {
    expect((await approve(UUID_A, "dkim", "  ")).error?.message).toMatch(/evidence/);
    expect((await approve(UUID_A, "dkim", "x".repeat(301))).error?.message).toMatch(/evidence/);
    expect((await approve(UUID_A, "spam_score")).error?.message).toMatch(/invalid item/);
  });

  test("re-approving keeps one row per item and records who and when", async () => {
    const [w] = await db.query<{ id: string }>(as(UUID_A), "select public.create_workspace('Re-approve') as id");
    await db.query(as(UUID_A), "select public.approve_c12_item($1,'dmarc','first')", [w.id]);
    await db.query(as(UUID_A), "select public.approve_c12_item($1,'dmarc','second')", [w.id]);
    const rows = await db.query<{ evidence: string; approved_by: string }>(as(UUID_A), "select evidence, approved_by from public.c12_approvals where workspace_id = $1", [w.id]);
    expect(rows).toEqual([{ evidence: "second", approved_by: UUID_A }]);
  });

  test("c12_ready is internal: no EXECUTE for anon or authenticated", async () => {
    const [g] = await db.admin("select has_function_privilege('anon', 'public.c12_ready(uuid)', 'execute') as a, has_function_privilege('authenticated', 'public.c12_ready(uuid)', 'execute') as u");
    expect(g).toEqual({ a: false, u: false });
  });
});

describe("0018 the switch to real sending needs C12", () => {
  test("every workspace starts not ready", async () => {
    expect(await ready(wsB)).toBe(false);
  });

  test("complete sender + verified mailbox is no longer enough; a partial checklist still fails; all 7 by the owner passes", async () => {
    const [w] = await db.query<{ id: string }>(as(UUID_B), "select public.create_workspace('Gate B') as id");
    await db.query(as(UUID_B), "insert into public.sender_profiles (workspace_id, legal_name, postal_address, sender_name) values ($1,'Gate B Corp','2 Main St, Worcester, MA 01608','Pat Doe')", [w.id]);
    const s = await readyCampaign("c12a", w.id, UUID_B);
    expect((await goReal(UUID_B, s.campaign)).error?.message).toMatch(/C12/);
    for (const item of C12_ITEMS.slice(0, 6)) await db.query(as(UUID_B), "select public.approve_c12_item($1,$2,'checked by hand')", [w.id, item]);
    expect(await ready(w.id)).toBe(false);
    expect((await goReal(UUID_B, s.campaign)).error?.message).toMatch(/C12/);
    await db.query(as(UUID_B), "select public.approve_c12_item($1,$2,'checked by hand')", [w.id, C12_ITEMS[6]]);
    expect(await ready(w.id)).toBe(true);
    await db.query(as(UUID_B), "select public.set_campaign_send_mode($1,'real')", [s.campaign]);
    expect((await db.admin<{ send_mode: string }>("select send_mode from public.email_campaigns where id = $1", [s.campaign]))[0].send_mode).toBe("real");
  });

  test("the older R4 checks still answer first (owner, sender profile, mailbox)", async () => {
    const s = await seedCampaign(db, ws, "c12b");
    expect((await goReal(UUID_C, s.campaign)).error?.message).toMatch(/only an owner/);
    expect((await goReal(UUID_A, s.campaign)).error?.message).toMatch(/verified mailbox/);
  });

  test("dry_run is unaffected: switching back and rehearsal claims work without the checklist", async () => {
    const s = await readyCampaign("c12c");
    expect(await ready(ws)).toBe(false);
    expect((await db.try(as(UUID_A), "select public.set_campaign_send_mode($1,'dry_run')", [s.campaign])).error).toBeUndefined();
    expect((await claim(s.campaign)).outcome).toBe("claimed");
  });
});

describe("0018 the real-send claim refuses without C12 (defence in depth)", () => {
  test("a campaign already in real mode (set before 0018) cannot claim while not ready; it can after", async () => {
    const [w] = await db.query<{ id: string }>(as(UUID_A), "select public.create_workspace('Claim gate') as id");
    await db.query(as(UUID_A), "insert into public.sender_profiles (workspace_id, legal_name, postal_address, sender_name) values ($1,'Claim Corp','3 Main St, Millbury, MA 01527','Juan Sanches')", [w.id]);
    const s = await readyCampaign("c12d", w.id);
    await db.admin("update public.email_campaigns set send_mode = 'real' where id = $1", [s.campaign]);
    const r = await db.try(as(UUID_A), "select public.claim_next_email($1,$2)", [s.campaign, HOLDER]);
    expect(r.error?.message).toMatch(/C12/);
    expect((await db.admin<{ status: string }>("select status from public.email_messages where id = $1", [s.messages[0]]))[0].status).toBe("approved");
    await approveAllC12(db, w.id);
    expect((await claim(s.campaign)).outcome).toBe("claimed");
  });
});

describe("0018 going real again does not revive a finished prospect (M1)", () => {
  test("a sequence sent for real, then real -> rehearsal -> real: the prospect stays done and its C3 lock stays released; one with an unsent step comes back", async () => {
    const OWNER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await db.addUser(OWNER);
    const [w] = await db.query<{ id: string }>(as(OWNER), "select public.create_workspace('Revive gate') as id");
    await db.query(as(OWNER), "insert into public.sender_profiles (workspace_id, legal_name, postal_address, sender_name) values ($1,'Revive Corp','4 Main St, Millbury, MA 01527','Juan Sanches')", [w.id]);
    await approveAllC12(db, w.id, OWNER);
    const s = await readyCampaign("c12m1", w.id, OWNER);
    const [p] = s.prospects;
    await db.admin("update public.email_campaigns set send_mode = 'real' where id = $1", [s.campaign]);
    // a 2-step sequence, both steps sent for real: the prospect is finished (0023) and its lock is gone
    const lead = (await db.admin<{ id: string }>("insert into public.leads (workspace_id, origin_kind) values ($1,'import') returning id", [w.id]))[0].id;
    await db.admin("update public.email_prospects set lead_id = $2 where id = $1", [p, lead]);
    await db.admin("update public.email_messages set status = 'sent', sent_at = now() - interval '3 days', send_mode = 'real' where id = $1", [s.messages[0]]);
    await db.admin("insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body, status, sent_at, send_mode) values ($1,$2,$3,'sequence',2,'Follow up','Hi Pat, any news?','sent', now() - interval '1 day','real')", [w.id, s.campaign, p]);
    await db.admin("update public.email_messages set status = 'sent', sent_at = now() - interval '1 day', send_mode = 'real', approved_by = $2, approved_at = now(), approved_to = 'x@y.example', to_address = 'x@y.example' where prospect_id = $1 and step = 2", [p, OWNER]);
    await db.admin("update public.email_prospects set status = 'done' where id = $1", [p]);
    expect(await db.admin("select 1 from public.lead_campaign_locks where prospect_id = $1", [p])).toHaveLength(0);

    await db.query(as(OWNER), "select public.set_campaign_send_mode($1,'dry_run')", [s.campaign]);
    await db.query(as(OWNER), "select public.set_campaign_send_mode($1,'real')", [s.campaign]);
    expect((await db.admin<{ status: string }>("select status from public.email_prospects where id = $1", [p]))[0].status).toBe("done");
    expect(await db.admin("select 1 from public.lead_campaign_locks where prospect_id = $1", [p])).toHaveLength(0);

    // a done prospect that still has an unsent step 2 does come back
    await db.admin("update public.email_messages set status = 'draft', sent_at = null, send_mode = null where prospect_id = $1 and step = 2", [p]);
    await db.query(as(OWNER), "select public.set_campaign_send_mode($1,'dry_run')", [s.campaign]);
    await db.query(as(OWNER), "select public.set_campaign_send_mode($1,'real')", [s.campaign]);
    expect((await db.admin<{ status: string }>("select status from public.email_prospects where id = $1", [p]))[0].status).toBe("active");
  });
});
