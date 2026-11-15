import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { TestDb, anon, anonWithToken, as, setSchedulerToken, UUID_A, UUID_B } from "./helpers";
import { approveAllC12 } from "./c12-seed";
import { CIPHER, TOKEN, createOwner, seedCampaign, type Seeded } from "./scheduler-seed";

// Migration 0025 (F4 Task 11, D4): the database half of "the clock sends real mail only behind both locks". A real
// campaign reaches the clock only with p_real (the server switch), the C12 gate open and the stop off; the one function
// that hands a mailbox ciphertext to the clock answers only for a real message this very run holds. PGlite, fictional data.

let db: TestDb;
let ws: string;
const clock = anonWithToken(TOKEN);
const code = (e: Error | undefined) => (e as (Error & { code?: string }) | undefined)?.code;
const admin = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.admin<T>(sql, params);
const one = async <T>(sql: string, params: unknown[]) => (await db.query<{ r: T }>(clock, sql, params))[0].r;

async function begin(): Promise<string> {
  return (await one<{ run_id: string }>("select public.scheduler_begin_run() as r", [])).run_id;
}
const finish = (run: string) => db.query(clock, "select public.scheduler_finish_run($1,'{}'::jsonb,null)", [run]);
const due = async (run: string, real: boolean) => (await one<{ campaign_ids: string[] }>("select public.scheduler_due_work($1,$2) as r", [run, real])).campaign_ids;
const claim = (run: string, campaign: string, real: boolean) => one<{ outcome: string; message_id?: string }>("select public.scheduler_claim_next_email($1,$2,$3) as r", [run, campaign, real]);
const secret = (run: string, message: string) => db.try(clock, "select public.scheduler_mailbox_secret($1,$2) as r", [run, message]);
const gateClosed = () => admin("delete from public.c12_approvals where workspace_id = $1 and item = 'spf'", [ws]);

async function realCampaign(label: string): Promise<Seeded> {
  await approveAllC12(db, ws);
  const s = await seedCampaign(db, ws, label);
  await db.query(as(UUID_A), "select public.set_mailbox_verified($1, true, null)", [s.mailbox]);
  await db.query(as(UUID_A), "select public.set_campaign_send_mode($1,'real')", [s.campaign]);
  await db.query(as(UUID_A), "select public.set_clock_real($1,true)", [ws]);
  return s;
}
const park = (s: Seeded) => admin("update public.email_campaigns set status = 'paused' where id = $1", [s.campaign]);

beforeAll(async () => {
  db = await TestDb.create();
  ws = await createOwner(db);
});
afterAll(async () => {
  await db.pg.close();
});
beforeEach(async () => {
  await setSchedulerToken(db, TOKEN);
  await admin("update public.scheduler_state set lease_run = null, lease_until = null");
  await admin("update public.workspace_settings set sending_paused = false where workspace_id = $1", [ws]);
  await approveAllC12(db, ws);
});

describe("the work list and the claim", () => {
  test("a real campaign is listed and claimed only with p_real, the gate open and the stop off; p_real defaults to off", async () => {
    const s = await realCampaign("listing");
    let run = await begin();
    expect(await due(run, false)).not.toContain(s.campaign);
    expect((await one<{ campaign_ids: string[] }>("select public.scheduler_due_work($1) as r", [run])).campaign_ids).not.toContain(s.campaign);
    expect(await claim(run, s.campaign, false)).toEqual({ outcome: "not_active" });
    expect(await one("select public.scheduler_claim_next_email($1,$2) as r", [run, s.campaign])).toEqual({ outcome: "not_active" });

    await gateClosed();
    expect(await due(run, true)).not.toContain(s.campaign);
    expect(await claim(run, s.campaign, true)).toEqual({ outcome: "not_active" });
    expect(await one("select public.scheduler_campaign($1,$2) as r", [run, s.campaign])).toBeNull();
    await approveAllC12(db, ws);

    await db.query(as(UUID_A), "select public.set_sending_paused($1,true)", [ws]);
    expect(await due(run, true)).not.toContain(s.campaign);
    expect(await claim(run, s.campaign, true)).toEqual({ outcome: "not_active" });
    await db.query(as(UUID_A), "select public.set_sending_paused($1,false)", [ws]);

    // the owner's switch off: a token holder passing p_real gets nothing real (lock 1 is in the database)
    await db.query(as(UUID_A), "select public.set_clock_real($1,false)", [ws]);
    expect(await due(run, true)).not.toContain(s.campaign);
    expect(await claim(run, s.campaign, true)).toEqual({ outcome: "not_active" });
    await db.query(as(UUID_A), "select public.set_clock_real($1,true)", [ws]);
    expect(await admin("select 1 from public.email_send_log where campaign_id = $1", [s.campaign])).toHaveLength(0);
    await finish(run);

    run = await begin();
    expect(await due(run, true)).toContain(s.campaign);
    const c = await claim(run, s.campaign, true);
    expect(c.outcome).toBe("claimed");
    const [m] = await admin<{ send_mode: string; claim_holder: string; claimed_by: string | null }>("select send_mode, claim_holder, claimed_by from public.email_messages where id = $1", [c.message_id]);
    expect(m).toEqual({ send_mode: "real", claim_holder: run, claimed_by: null });
    // the stop re-read before SMTP: off now; on with the stop, with the gate revoked, or with the owner's switch off
    const paused = () => one<boolean>("select public.scheduler_sending_paused($1,$2) as r", [run, ws]);
    expect(await paused()).toBe(false);
    await db.query(as(UUID_A), "select public.set_sending_paused($1,true)", [ws]);
    expect(await paused()).toBe(true);
    await db.query(as(UUID_A), "select public.set_sending_paused($1,false)", [ws]);
    await gateClosed();
    expect(await paused()).toBe(true);
    await approveAllC12(db, ws);
    await db.query(as(UUID_A), "select public.set_clock_real($1,false)", [ws]);
    expect(await paused()).toBe(true);
    await db.query(as(UUID_A), "select public.set_clock_real($1,true)", [ws]);
    expect(await paused()).toBe(false);
    // a workspace where this run holds nothing: answered "stopped"
    expect(await one<boolean>("select public.scheduler_sending_paused($1,$2) as r", [run, "00000000-0000-4000-8000-000000000000"])).toBe(true);
    // a real message the run holds can be read, and finished as 'sent' (never 'dry_run')
    expect(await one("select public.scheduler_message($1,$2) as r", [run, c.message_id])).toMatchObject({ send_mode: "real" });
    expect((await db.try(clock, "select public.scheduler_finish_email_send($1,$2,'dry_run',null)", [run, c.message_id])).error?.message).toMatch(/send mode/);
    await db.query(clock, "select public.scheduler_finish_email_send($1,$2,'sent',null)", [run, c.message_id]);
    expect((await admin<{ status: string }>("select status from public.email_messages where id = $1", [c.message_id]))[0].status).toBe("sent");
    await finish(run);
    await park(s);
  });

  test("a rehearsal campaign still goes through the clock as before, with or without p_real", async () => {
    const s = await seedCampaign(db, ws, "rehearsal");
    const run = await begin();
    expect(await due(run, false)).toContain(s.campaign);
    const c = await claim(run, s.campaign, true);
    expect(c.outcome).toBe("claimed");
    expect((await admin<{ send_mode: string }>("select send_mode from public.email_messages where id = $1", [c.message_id]))[0].send_mode).toBe("dry_run");
    // a rehearsal message never opens the mailbox secret
    expect(code((await secret(run, c.message_id!)).error)).toBe("42501");
    await db.query(clock, "select public.scheduler_finish_email_send($1,$2,'dry_run',null)", [run, c.message_id]);
    await finish(run);
    await park(s);
  });
});

describe("scheduler_mailbox_secret", () => {
  test("scheduler_mailbox_secret refuses unless the message is claimed by this run, real, and the workspace gate is open", async () => {
    const s = await realCampaign("secret");
    const n = await seedCampaign(db, ws, "secret-other");
    const run = await begin();
    // nothing claimed yet: an approved message is refused
    expect(code((await secret(run, s.messages[0])).error)).toBe("42501");
    const c = await claim(run, s.campaign, true);
    expect(c.outcome).toBe("claimed");
    const msg = c.message_id!;

    // the right run, real, gate open, mailbox ok: exactly the four fields
    const ok = await secret(run, msg);
    expect(ok.error).toBeUndefined();
    const got = (ok.rows as { r: Record<string, unknown> }[])[0].r;
    expect(Object.keys(got).sort()).toEqual(["ciphertext", "email", "id", "workspace_id"]);
    expect(got).toEqual({ id: s.mailbox, workspace_id: ws, email: s.address, ciphertext: CIPHER });

    // gate closed after the claim
    await gateClosed();
    expect(code((await secret(run, msg)).error)).toBe("42501");
    await approveAllC12(db, ws);
    // stop on
    await db.query(as(UUID_A), "select public.set_sending_paused($1,true)", [ws]);
    expect(code((await secret(run, msg)).error)).toBe("42501");
    await db.query(as(UUID_A), "select public.set_sending_paused($1,false)", [ws]);
    // the owner's switch off
    await db.query(as(UUID_A), "select public.set_clock_real($1,false)", [ws]);
    expect(code((await secret(run, msg)).error)).toBe("42501");
    await db.query(as(UUID_A), "select public.set_clock_real($1,true)", [ws]);
    // mailbox no longer verified, or paused on bounces
    await admin("update public.mailboxes set status = 'error' where id = $1", [s.mailbox]);
    expect(code((await secret(run, msg)).error)).toBe("42501");
    await admin("update public.mailboxes set status = 'ok', health_status = 'paused_bounce' where id = $1", [s.mailbox]);
    expect(code((await secret(run, msg)).error)).toBe("42501");
    await admin("update public.mailboxes set health_status = 'ok' where id = $1", [s.mailbox]);
    // no token, a wrong token, a logged-in owner
    expect(code((await db.try(anon, "select public.scheduler_mailbox_secret($1,$2)", [run, msg])).error)).toBe("42501");
    expect((await db.try(as(UUID_A), "select public.scheduler_mailbox_secret($1,$2)", [run, msg])).error?.message).toMatch(/permission denied/);
    // another run id: no lease
    expect(code((await secret("00000000-0000-4000-8000-000000000000", msg)).error)).toBe("55000");
    // a message of another campaign, not held by this run
    expect(code((await secret(run, n.messages[0])).error)).toBe("42501");
    // still fine after all that: then finished, it is refused (no longer 'sending')
    expect((await secret(run, msg)).error).toBeUndefined();
    await db.query(clock, "select public.scheduler_finish_email_send($1,$2,'failed','test')", [run, msg]);
    expect(code((await secret(run, msg)).error)).toBe("42501");
    await finish(run);
    await park(s);
    await park(n);
  });

  test("only scheduler_mailbox_secret reads the ciphertext; only it and scheduler_mailbox_failed touch public.mailboxes", async () => {
    const fns = await admin<{ proname: string; prosrc: string }>(
      "select proname, prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname like 'scheduler\\_%'",
    );
    // 0026 (E5) adds the reply side: scheduler_imap_secret (a mailbox listed for replies in this run, same locks) and the
    // functions that list, read the sent references of, or record for such a mailbox (tests/db/clock-replies.test.ts)
    expect(fns.filter((f) => /ciphertext|mailbox_secret\(/i.test(f.prosrc)).map((f) => f.proname).sort()).toEqual(["scheduler_imap_secret", "scheduler_mailbox_secret"]);
    expect(fns.filter((f) => /public\.mailboxes/i.test(f.prosrc)).map((f) => f.proname).sort()).toEqual([
      "scheduler_imap_secret", "scheduler_mailbox_failed", "scheduler_mailbox_secret", "scheduler_record_reply", "scheduler_reply_mailboxes", "scheduler_reply_sent_refs",
    ]);
    const grants = await admin<{ proname: string; anon: boolean; authed: boolean }>(
      "select proname, has_function_privilege('anon', oid, 'execute') as anon, has_function_privilege('authenticated', oid, 'execute') as authed from pg_proc where pronamespace = 'public'::regnamespace and proname in ('scheduler_mailbox_secret','scheduler_mailbox_failed','scheduler_sending_paused','scheduler_due_work','scheduler_claim_next_email')",
    );
    expect(grants).toHaveLength(5); // the old signatures were dropped, not overloaded
    for (const g of grants) expect(g, g.proname).toMatchObject({ anon: true, authed: false });
  });
});

describe("the owner's switch and broken mailboxes", () => {
  test("set_clock_real: only an owner; turning it on needs the C12 gate; clients cannot write the column", async () => {
    await db.query(as(UUID_A), "select public.set_clock_real($1,false)", [ws]);
    const flag = async () => (await admin<{ v: boolean }>("select clock_real_enabled as v from public.workspace_settings where workspace_id = $1", [ws]))[0].v;
    expect(await flag()).toBe(false);
    await db.addUser(UUID_B);
    await admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr')", [ws, UUID_B]);
    expect(code((await db.try(as(UUID_B), "select public.set_clock_real($1,true)", [ws])).error)).toBe("42501");
    expect(code((await db.try(anon, "select public.set_clock_real($1,true)", [ws])).error)).toBe("42501");
    await gateClosed();
    expect(code((await db.try(as(UUID_A), "select public.set_clock_real($1,true)", [ws])).error)).toBe("23514");
    await approveAllC12(db, ws);
    await db.query(as(UUID_A), "select public.set_clock_real($1,true)", [ws]);
    expect(await flag()).toBe(true);
    expect((await db.try(as(UUID_A), "update public.workspace_settings set clock_real_enabled = false where workspace_id = $1", [ws])).error?.message).toMatch(/permission denied/);
    await db.query(as(UUID_A), "select public.set_clock_real($1,false)", [ws]);
    expect(await flag()).toBe(false);
  });

  test("scheduler_mailbox_failed marks only the mailbox of a real message this run held, with a mailbox code only", async () => {
    const s = await realCampaign("mbfail");
    const run = await begin();
    const c = await claim(run, s.campaign, true);
    expect(c.outcome).toBe("claimed");
    const msg = c.message_id!;
    const failed = (code_: string, m = msg, r = run) => db.try(clock, "select public.scheduler_mailbox_failed($1,$2,$3)", [r, m, code_]);
    expect(code((await failed("timeout")).error)).toBe("22023");
    expect(code((await failed("auth_failed", s.messages[0] === msg ? "00000000-0000-4000-8000-000000000000" : s.messages[0])).error)).toBe("42501");
    expect((await db.try(as(UUID_A), "select public.scheduler_mailbox_failed($1,$2,'auth_failed')", [run, msg])).error?.message).toMatch(/permission denied/);
    // the engine records the failure first, then reports the mailbox
    await db.query(clock, "select public.scheduler_finish_email_send($1,$2,'failed','auth_failed')", [run, msg]);
    await db.query(clock, "select public.scheduler_mailbox_failed($1,$2,'auth_failed')", [run, msg]);
    expect((await admin<{ status: string; last_error: string }>("select status, last_error from public.mailboxes where id = $1", [s.mailbox]))[0]).toEqual({ status: "error", last_error: "auth_failed" });
    await finish(run);
    // a rehearsal message held by a run cannot mark its mailbox
    const r2 = await seedCampaign(db, ws, "mbfail-dry");
    const run2 = await begin();
    const c2 = await claim(run2, r2.campaign, true);
    expect(code((await failed("auth_failed", c2.message_id!, run2)).error)).toBe("42501");
    await finish(run2);
    await park(s);
    await park(r2);
  });
});
