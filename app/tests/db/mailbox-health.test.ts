import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, anonWithToken, as, setSchedulerToken, UUID_A, UUID_B, UUID_C } from "./helpers";
import { addCampaignMailbox, createOwner, seedCampaign, TOKEN } from "./scheduler-seed";
import { approveAllC12 } from "./c12-seed";

// Migration 0024 (F4 Task 10, E4): mailbox health (auto pause on bounces), warm-up ramp, emergency stop.
// D7: ramp 5 a day + 3 per business day; pause at >= 3 bounces AND >= 5 % of the mailbox's real sends in 30 days.
// Fictional data only.
let db: TestDb;
let ws: string;
const SDR = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
beforeAll(async () => {
  db = await TestDb.create();
  ws = await createOwner(db);
  await createOwner(db, UUID_B); // another workspace's owner
  await approveAllC12(db, ws);
  await db.addUser(UUID_C);
  await db.addUser(SDR);
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'closer'), ($1,$3,'sdr')", [ws, UUID_C, SDR]);
});
afterAll(async () => { await db.pg.close(); });

type Claim = { outcome: string; message_id?: string; wait_until?: string };
const HOLDER = "66666666-6666-4666-8666-666666666666";
const claim = async (camp: string, message: string | null = null, user = UUID_A) =>
  (await db.query<{ r: Claim }>(as(user), "select public.claim_next_email($1,$2,$3) as r", [camp, HOLDER, message]))[0].r;
const finish = (msg: string, result: string) => db.query(as(UUID_A), "select public.finish_email_send($1,$2,$3,null)", [msg, HOLDER, result]);
const noGap = (camp: string) => db.admin("update public.email_campaigns set min_gap_minutes = 0, random_gap_minutes = 0 where id = $1", [camp]);
const verify = (mb: string) => db.query(as(UUID_A), "select public.set_mailbox_verified($1, true, null)", [mb]);
const goReal = (camp: string) => db.query(as(UUID_A), "select public.set_campaign_send_mode($1,'real')", [camp]);
const fromOf = async (msg: string) => (await db.admin<{ from_address: string }>("select from_address from public.email_messages where id = $1", [msg]))[0].from_address;
const health = async (mb: string) =>
  (await db.admin<{ health_status: string; paused_reason: string | null }>("select health_status, paused_reason from public.mailboxes where id = $1", [mb]))[0];
const effective = async (mb: string, mode: string) =>
  (await db.admin<{ n: number }>("select public.mailbox_effective_limit($1,$2) as n", [mb, mode]))[0].n;
async function clock(camp: string): Promise<Claim> {
  await setSchedulerToken(db, TOKEN);
  const c = anonWithToken(TOKEN);
  const run = (await db.query<{ r: { run_id: string } }>(c, "select public.scheduler_begin_run() as r"))[0].r.run_id;
  const r = (await db.query<{ r: Claim }>(c, "select public.scheduler_claim_next_email($1,$2) as r", [run, camp]))[0].r;
  await db.query(c, "select public.scheduler_finish_run($1,'{}'::jsonb,null)", [run]);
  return r;
}
/** A delivery failure report for a message we really sent, read from the mailbox that sent it. */
async function bounce(msg: string, mailbox: string) {
  const m = (await db.admin<{ prospect_id: string; to_address: string; rfc_message_id: string }>(
    "select prospect_id, to_address, rfc_message_id from public.email_messages where id = $1", [msg]))[0];
  await db.query(as(UUID_A), "select public.record_email_reply($1,$2,$3,'mailer-daemon@googlemail.com','Delivery Status Notification (Failure)','550 5.1.1 user unknown',$4,now(),'bounce',$5)",
    [m.prospect_id, mailbox, msg, `<bounce-${msg}@mail.example>`, m.to_address]);
}

describe("0024 E4 mailbox health", () => {
  test("a mailbox with high bounces stops alone and the campaign goes on through the others", async () => {
    const s = await seedCampaign(db, ws, "hb", { n: 6 });
    await noGap(s.campaign);
    await verify(s.mailbox);
    await goReal(s.campaign);
    const sentA: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await claim(s.campaign);
      expect(c.outcome).toBe("claimed");
      expect(await fromOf(c.message_id!)).toBe(s.address);
      await finish(c.message_id!, "sent");
      sentA.push(c.message_id!);
    }
    const b = await addCampaignMailbox(db, ws, s.campaign, "hbb");
    await verify(b.mailbox);

    // 2 bounces out of 3 sends: not yet (D7 needs at least 3)
    await bounce(sentA[0], s.mailbox);
    await bounce(sentA[1], s.mailbox);
    expect(await health(s.mailbox)).toEqual({ health_status: "ok", paused_reason: null });
    // the 3rd bounce (3 of 3 sends, >= 5 %): this mailbox pauses itself; the other does not
    await bounce(sentA[2], s.mailbox);
    expect((await health(s.mailbox)).health_status).toBe("paused_bounce");
    expect((await health(s.mailbox)).paused_reason).toMatch(/3/);
    expect((await health(b.mailbox)).health_status).toBe("ok");

    // the campaign goes on, only through the healthy mailbox
    for (let i = 0; i < 3; i++) {
      const c = await claim(s.campaign);
      expect(c.outcome).toBe("claimed");
      expect(await fromOf(c.message_id!)).toBe(b.address);
      await finish(c.message_id!, "sent");
    }
    expect((await claim(s.campaign)).outcome).toBe("nothing_due");

    // a campaign whose only mailbox is paused sends nothing, in rehearsal too
    const r = await seedCampaign(db, ws, "hbr", { n: 1 });
    await db.admin("update public.mailboxes set health_status = 'paused_bounce', paused_reason = 'test' where id = $1", [r.mailbox]);
    expect((await claim(r.campaign)).outcome).toBe("mailbox_not_verified");

    // only an owner clears a pause (not the sdr, not the closer, not another workspace's owner)
    for (const u of [SDR, UUID_C, UUID_B]) {
      expect((await db.try(as(u), "select public.clear_mailbox_pause($1)", [s.mailbox])).error?.message).toMatch(/owner|not allowed/);
    }
    // health columns are not writable by clients
    expect((await db.try(as(UUID_A), "update public.mailboxes set health_status = 'ok' where id = $1", [s.mailbox])).error).toBeDefined();
    await db.query(as(UUID_A), "select public.clear_mailbox_pause($1)", [s.mailbox]);
    expect(await health(s.mailbox)).toEqual({ health_status: "ok", paused_reason: null });
  });

  test("3 bounces under 5 % of the mailbox's real sends in 30 days do not pause it", async () => {
    const s = await seedCampaign(db, ws, "lowb", { n: 3 });
    await noGap(s.campaign);
    await verify(s.mailbox);
    await goReal(s.campaign);
    // 100 earlier real sends from this address, 10 days ago (append-only log; test-only back-dated rows)
    await db.pg.exec("alter table public.email_send_log disable trigger guard_email_send_log");
    await db.admin(
      "insert into public.email_send_log (workspace_id, mailbox_address, mode, to_address, claimed_at, result) select $1, $2, 'real', 'old' || g || '@past.example', now() - interval '10 days', 'sent' from generate_series(1,100) g",
      [ws, s.address]);
    await db.pg.exec("alter table public.email_send_log enable trigger guard_email_send_log");
    await db.admin("update public.mailboxes set ramp_enabled = false where id = $1", [s.mailbox]);
    const sent: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await claim(s.campaign);
      await finish(c.message_id!, "sent");
      sent.push(c.message_id!);
    }
    for (const m of sent) await bounce(m, s.mailbox);
    expect((await health(s.mailbox)).health_status).toBe("ok"); // 3 of 103 < 5 %
  });
});

describe("0024 E4 warm-up ramp", () => {
  test("ramp: day 0 allows 5 real sends, a week later 20, never above daily_limit; rehearsal ignores the ramp", async () => {
    const s = await seedCampaign(db, ws, "ramp", { n: 8 });
    await noGap(s.campaign);
    await verify(s.mailbox);
    expect(await effective(s.mailbox, "real")).toBe(5); // not started: day 0
    await goReal(s.campaign);
    for (let i = 0; i < 5; i++) {
      const c = await claim(s.campaign);
      expect(c.outcome).toBe("claimed");
      await finish(c.message_id!, "sent");
    }
    expect((await claim(s.campaign)).outcome).toBe("daily_limit");
    const started = (await db.admin<{ ramp_started_at: string | null }>("select ramp_started_at from public.mailboxes where id = $1", [s.mailbox]))[0].ramp_started_at;
    expect(started).not.toBeNull(); // the first real claim starts the ramp

    // a week later (7 calendar days = 5 business days): 5 + 3 * 5 = 20
    await db.admin("update public.mailboxes set ramp_started_at = ramp_started_at - interval '7 days' where id = $1", [s.mailbox]);
    expect(await effective(s.mailbox, "real")).toBe(20);
    expect((await claim(s.campaign)).outcome).toBe("claimed");

    // never above the mailbox's own daily_limit
    await db.admin("update public.mailboxes set ramp_started_at = ramp_started_at - interval '60 days' where id = $1", [s.mailbox]);
    expect(await effective(s.mailbox, "real")).toBe(30);
    await db.query(as(UUID_A), "update public.mailboxes set daily_limit = 12 where id = $1", [s.mailbox]);
    expect(await effective(s.mailbox, "real")).toBe(12);
    // ramp off: the daily limit alone
    await db.admin("update public.mailboxes set ramp_enabled = false, ramp_started_at = now() where id = $1", [s.mailbox]);
    expect(await effective(s.mailbox, "real")).toBe(12);

    // rehearsal ignores the ramp: 8 rehearsed sends from a brand-new mailbox on day 0
    const r = await seedCampaign(db, ws, "rampr", { n: 8 });
    await noGap(r.campaign);
    expect(await effective(r.mailbox, "dry_run")).toBe(30);
    for (let i = 0; i < 8; i++) {
      const c = await claim(r.campaign);
      expect(c.outcome).toBe("claimed");
      await finish(c.message_id!, "dry_run");
    }
    expect((await db.admin<{ ramp_started_at: string | null }>("select ramp_started_at from public.mailboxes where id = $1", [r.mailbox]))[0].ramp_started_at).toBeNull();
  });
});

describe("0024 E4 emergency stop", () => {
  test("with sending_paused nothing is claimed, not even approved messages; only the owner turns it off", async () => {
    const reh = await seedCampaign(db, ws, "stop", { n: 2 });
    await noGap(reh.campaign);
    const real = await seedCampaign(db, ws, "stopr", { n: 1 });
    await verify(real.mailbox);
    await goReal(real.campaign);

    // a closer cannot press stop; an sdr can
    expect((await db.try(as(UUID_C), "select public.set_sending_paused($1,true)", [ws])).error?.message).toMatch(/not allowed/);
    expect((await db.try(as(UUID_B), "select public.set_sending_paused($1,true)", [ws])).error?.message).toMatch(/not allowed/);
    await db.query(as(SDR), "select public.set_sending_paused($1,true)", [ws]);
    const st = (await db.admin<{ sending_paused: boolean; sending_paused_by: string }>("select sending_paused, sending_paused_by from public.workspace_settings where workspace_id = $1", [ws]))[0];
    expect(st).toEqual({ sending_paused: true, sending_paused_by: SDR });

    const logBefore = (await db.admin("select 1 from public.email_send_log")).length;
    expect((await claim(reh.campaign)).outcome).toBe("sending_paused");                     // a person's click, rehearsal
    expect((await claim(reh.campaign, reh.messages[0])).outcome).toBe("sending_paused");    // that exact approved message
    expect((await claim(real.campaign)).outcome).toBe("sending_paused");                    // real
    expect((await clock(reh.campaign)).outcome).toBe("sending_paused");                     // the clock
    expect((await db.admin("select 1 from public.email_send_log")).length).toBe(logBefore);
    expect((await db.admin<{ status: string }>("select status from public.email_messages where id = any($1::uuid[])", [[...reh.messages, ...real.messages]])).map((m) => m.status))
      .toEqual(["approved", "approved", "approved"]);

    // only the owner turns it off (the sdr cannot; pressing stop again is harmless)
    expect((await db.try(as(SDR), "select public.set_sending_paused($1,false)", [ws])).error?.message).toMatch(/owner/);
    await db.query(as(SDR), "select public.set_sending_paused($1,true)", [ws]);
    // the flag is not writable directly
    expect((await db.try(as(UUID_A), "update public.workspace_settings set sending_paused = false where workspace_id = $1", [ws])).error).toBeDefined();
    await db.query(as(UUID_A), "select public.set_sending_paused($1,false)", [ws]);
    expect((await claim(reh.campaign)).outcome).toBe("claimed");
  });
});
