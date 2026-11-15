import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { TestDb, anon, anonWithToken, as, setSchedulerToken, tryCommit, UUID_A, UUID_B } from "./helpers";
import { approveAllC12 } from "./c12-seed";
import { CIPHER, TOKEN, createOwner, seedCampaign, type Seeded } from "./scheduler-seed";

// Migration 0026 (F4 Task 12, E5): the database half of "the clock reads replies only behind the same locks as sending".
// A mailbox reaches the clock only while it is 'ok' with health 'ok', attached to an ACTIVE REAL campaign, has real
// mail sent in the last 30 days, and its workspace is clock_real_ready (C12 gate, owner switch, stop off). Its secret,
// its sent references and the recording of a reply are answered only for a mailbox listed in THIS run. PGlite, fictional data.

let db: TestDb;
let ws: string;
const clock = anonWithToken(TOKEN);
const HOLDER = "77777777-7777-4777-8777-777777777777";
const code = (e: Error | undefined) => (e as (Error & { code?: string }) | undefined)?.code;
const admin = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.admin<T>(sql, params);
const one = async <T>(sql: string, params: unknown[]) => (await db.query<{ r: T }>(clock, sql, params))[0].r;

type Mb = { id: string; workspace_id: string; email: string };
async function begin(): Promise<string> {
  return (await one<{ run_id: string }>("select public.scheduler_begin_run() as r", [])).run_id;
}
const finish = (run: string) => db.query(clock, "select public.scheduler_finish_run($1,'{}'::jsonb,null)", [run]);
const listed = async (run: string) => (await one<{ mailboxes: Mb[] }>("select public.scheduler_reply_mailboxes($1) as r", [run])).mailboxes;
const ids = async (run: string) => (await listed(run)).map((m) => m.id);
const secret = (run: string, mb: string) => db.try(clock, "select public.scheduler_imap_secret($1,$2) as r", [run, mb]);
const refs = (run: string, mb: string) => db.try<{ r: unknown[] }>(clock, "select public.scheduler_reply_sent_refs($1,$2,now() - interval '30 days') as r", [run, mb]);
const record = (actor: typeof clock, run: string, s: Seeded, msg: string, kind = "reply", rule: string | null = null, rfc = `<r-${msg}-${kind}@mail.example>`) =>
  tryCommit<{ r: string | null }>(db, actor, "select public.scheduler_record_reply($1,$2,$3,$4,$5,'Re: Quick question','Thanks, call me',$6,now(),$7,null,$8) as r",
    [run, s.prospects[0], s.mailbox, msg, s.emails[0], rfc, kind, rule]);

/** A real campaign (gate open, owner switch on) whose first message was really sent by the owner's click. */
async function sentCampaign(label: string): Promise<Seeded> {
  await approveAllC12(db, ws);
  const s = await seedCampaign(db, ws, label);
  await db.query(as(UUID_A), "select public.set_mailbox_verified($1, true, null)", [s.mailbox]);
  await db.query(as(UUID_A), "select public.set_campaign_send_mode($1,'real')", [s.campaign]);
  await db.query(as(UUID_A), "select public.set_clock_real($1,true)", [ws]);
  const c = (await db.query<{ r: { outcome: string; message_id: string } }>(as(UUID_A), "select public.claim_next_email($1,$2,null) as r", [s.campaign, HOLDER]))[0].r;
  expect(c.outcome).toBe("claimed");
  await db.query(as(UUID_A), "select public.finish_email_send($1,$2,'sent',null)", [c.message_id, HOLDER]);
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

describe("0026 entry points: token, lease, grants", () => {
  const ZERO = "00000000-0000-4000-8000-000000000000";
  const calls: [string, unknown[]][] = [
    ["select public.scheduler_reply_mailboxes($1)", [ZERO]],
    ["select public.scheduler_imap_secret($1,$2)", [ZERO, ZERO]],
    ["select public.scheduler_reply_sent_refs($1,$2,now())", [ZERO, ZERO]],
    ["select public.scheduler_record_reply($1,$2,$3,null,'a@b.example','s','b','<x@y.example>',now(),'reply',null)", [ZERO, ZERO, ZERO]],
    ["select public.scheduler_mailbox_failed($1,null,'auth_failed',$2)", [ZERO, ZERO]],
  ];
  test("without the token every function refuses (42501); a logged-in user has no grant at all", async () => {
    for (const [sql, params] of calls) {
      expect(code((await db.try(anon, sql, params)).error), sql).toBe("42501");
      expect((await db.try(as(UUID_A), sql, params)).error?.message, sql).toMatch(/permission denied/);
    }
  });
  test("with the token but no lease held by that run: 55000", async () => {
    for (const [sql, params] of calls) expect(code((await db.try(clock, sql, params)).error), sql).toBe("55000");
  });
  test("record_email_reply_core and set_reply_class_core have no grant; record_email_reply / set_reply_class keep theirs", async () => {
    const rows = await admin<{ proname: string; anon: boolean; auth: boolean; definer: boolean }>(
      `select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth, p.prosecdef as definer
         from pg_proc p where p.pronamespace = 'public'::regnamespace
          and p.proname in ('record_email_reply', 'record_email_reply_core', 'set_reply_class', 'set_reply_class_core', 'clock_reply_mailbox_ok')
        order by p.proname`,
    );
    expect(rows).toEqual([
      { proname: "clock_reply_mailbox_ok", anon: false, auth: false, definer: false },
      { proname: "record_email_reply", anon: false, auth: true, definer: true },
      { proname: "record_email_reply_core", anon: false, auth: false, definer: false },
      { proname: "set_reply_class", anon: false, auth: true, definer: true },
      { proname: "set_reply_class_core", anon: false, auth: false, definer: false },
    ]);
  });
});

describe("which mailboxes the clock may read", () => {
  test("only a mailbox ok + healthy, on an active real campaign with real mail sent, in a clock_real_ready workspace", async () => {
    const s = await sentCampaign("listed");
    let run = await begin();
    expect(await ids(run)).toContain(s.mailbox);
    await finish(run);

    const closed: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
      ["gate closed", () => admin("delete from public.c12_approvals where workspace_id = $1 and item = 'dmarc'", [ws]), () => approveAllC12(db, ws)],
      ["owner switch off", () => db.query(as(UUID_A), "select public.set_clock_real($1,false)", [ws]), () => db.query(as(UUID_A), "select public.set_clock_real($1,true)", [ws])],
      ["stop on", () => db.query(as(UUID_A), "select public.set_sending_paused($1,true)", [ws]), () => db.query(as(UUID_A), "select public.set_sending_paused($1,false)", [ws])],
      ["mailbox paused on bounces", () => admin("update public.mailboxes set health_status = 'paused_bounce', paused_at = now() where id = $1", [s.mailbox]), () => admin("update public.mailboxes set health_status = 'ok', paused_at = null where id = $1", [s.mailbox])],
      ["mailbox in error", () => admin("update public.mailboxes set status = 'error' where id = $1", [s.mailbox]), () => admin("update public.mailboxes set status = 'ok' where id = $1", [s.mailbox])],
      ["campaign paused", () => park(s), () => admin("update public.email_campaigns set status = 'active' where id = $1", [s.campaign])],
      ["campaign back to rehearsal", () => admin("update public.email_campaigns set send_mode = 'dry_run' where id = $1", [s.campaign]), () => admin("update public.email_campaigns set send_mode = 'real' where id = $1", [s.campaign])],
      ["no real mail sent in 30 days", () => admin("update public.email_messages set sent_at = now() - interval '31 days' where campaign_id = $1", [s.campaign]), () => admin("update public.email_messages set sent_at = now() where campaign_id = $1 and status = 'sent'", [s.campaign])],
    ];
    for (const [name, close, open] of closed) {
      await close();
      run = await begin();
      expect(await ids(run), name).not.toContain(s.mailbox);
      // and a mailbox that was not listed in this run gets nothing
      expect(code((await secret(run, s.mailbox)).error), name).toBe("42501");
      await finish(run);
      await open();
    }
    run = await begin();
    expect(await ids(run)).toContain(s.mailbox);
    await finish(run);
    await park(s);
  });

  test("at most 5 per tick, least recently read first (every mailbox gets its turn)", async () => {
    const seeded: Seeded[] = [];
    for (let i = 0; i < 6; i++) seeded.push(await sentCampaign(`five${i}`));
    let run = await begin();
    const first = await ids(run);
    expect(first).toHaveLength(5);
    await finish(run);
    run = await begin();
    const second = await ids(run);
    await finish(run);
    const missing = seeded.map((s) => s.mailbox).filter((m) => !first.includes(m));
    expect(missing).toHaveLength(1);
    expect(second).toContain(missing[0]);
    for (const s of seeded) await park(s);
  });
});

describe("secret, sent references and recording: only for a mailbox listed in this run", () => {
  test("scheduler_imap_secret hands the ciphertext of a listed mailbox only, while it stays readable", async () => {
    const s = await sentCampaign("secret");
    const run = await begin();
    expect(await ids(run)).toContain(s.mailbox);
    const ok = await secret(run, s.mailbox);
    expect(ok.error).toBeUndefined();
    expect(ok.rows![0]).toEqual({ r: { id: s.mailbox, workspace_id: ws, email: s.address, ciphertext: CIPHER } });
    // the stop pressed after the listing: refused at once
    await db.query(as(UUID_A), "select public.set_sending_paused($1,true)", [ws]);
    const r = await secret(run, s.mailbox);
    expect(code(r.error)).toBe("42501");
    expect(r.error?.message).toMatch(/mailbox not available/);
    await db.query(as(UUID_A), "select public.set_sending_paused($1,false)", [ws]);
    await finish(run);
    // a later run that did not list it: refused
    const other = await begin();
    await admin("update public.mailboxes set clock_replies_run = null where id = $1", [s.mailbox]);
    expect(code((await secret(other, s.mailbox)).error)).toBe("42501");
    await finish(other);
    await park(s);
  });

  test("scheduler_reply_sent_refs returns the real sent messages of that mailbox only", async () => {
    const s = await sentCampaign("refs");
    const run = await begin();
    await listed(run);
    const r = await refs(run, s.mailbox);
    expect(r.rows![0].r).toEqual([
      expect.objectContaining({ message_id: s.messages[0], prospect_id: s.prospects[0], to_address: s.emails[0], rfc_message_id: expect.stringMatching(/^<.+@.+>$/) }),
    ]);
    expect(JSON.stringify(r.rows)).not.toContain(CIPHER);
    await finish(run);
    await park(s);
  });

  test("scheduler_record_reply: a reply stops the prospect; refused for a mailbox not listed in this run or a bad rule label", async () => {
    const s = await sentCampaign("record");
    const step2 = (await admin<{ id: string }>(
      "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body, ai_drafted) values ($1,$2,$3,'sequence',2,'Following up','Hi Pat',false) returning id",
      [ws, s.campaign, s.prospects[0]],
    ))[0].id;
    let run = await begin();
    // not listed yet in this run
    expect(code((await record(clock, run, s, s.messages[0])).error)).toBe("42501");
    await listed(run);
    expect(code((await record(clock, run, s, s.messages[0], "reply", "interested")).error)).toBe("22023");
    const r = await record(clock, run, s, s.messages[0]);
    expect(r.error).toBeUndefined();
    expect(r.rows![0].r).toMatch(/^[0-9a-f-]{36}$/);
    // stored once: the same Message-ID again returns null
    expect((await record(clock, run, s, s.messages[0])).rows![0].r).toBeNull();
    expect((await admin<{ status: string; stop_reason: string }>("select status, stop_reason from public.email_prospects where id = $1", [s.prospects[0]]))[0]).toEqual({ status: "replied", stop_reason: "replied" });
    expect((await admin<{ status: string }>("select status from public.email_messages where id = $1", [step2]))[0].status).toBe("cancelled");
    await finish(run);
    // the next run has not listed it: refused
    run = await begin();
    await admin("update public.mailboxes set clock_replies_run = null where id = $1", [s.mailbox]);
    expect(code((await record(clock, run, s, s.messages[0], "reply", null, "<another@mail.example>")).error)).toBe("42501");
    await finish(run);
    await park(s);
  });

  test("rule labels: 'unsubscribe' suppresses the address and stops; 'out_of_office' only labels", async () => {
    const s = await sentCampaign("rules");
    const run = await begin();
    await listed(run);
    const ooo = (await record(clock, run, s, s.messages[0], "reply", "out_of_office", "<ooo@mail.example>")).rows![0].r;
    expect((await admin<{ classification: string; class_source: string }>("select classification, class_source from public.email_replies where id = $1", [ooo]))[0]).toEqual({ classification: "out_of_office", class_source: "ai" });
    expect(await admin("select 1 from public.suppressions where workspace_id = $1 and value = $2", [ws, s.emails[0]])).toHaveLength(0);
    const unsub = (await record(clock, run, s, s.messages[0], "reply", "unsubscribe", "<unsub@mail.example>")).rows![0].r;
    expect((await admin<{ classification: string }>("select classification from public.email_replies where id = $1", [unsub]))[0].classification).toBe("unsubscribe");
    expect(await admin<{ reason: string }>("select reason from public.suppressions where workspace_id = $1 and value = $2", [ws, s.emails[0]])).toEqual([{ reason: "asked_to_stop" }]);
    expect((await admin<{ status: string; stop_reason: string }>("select status, stop_reason from public.email_prospects where id = $1", [s.prospects[0]]))[0]).toEqual({ status: "stopped", stop_reason: "asked_to_stop" });
    // a bounce never carries a rule label
    expect(code((await record(clock, run, s, s.messages[0], "bounce", "unsubscribe", "<b@mail.example>")).error)).toBe("22023");
    await finish(run);
    await park(s);
  });

  test("scheduler_mailbox_failed for a reply mailbox: only a mailbox listed in this run, only the 3 codes", async () => {
    const s = await sentCampaign("imapfail");
    const run = await begin();
    const fail = (mb: string, c: string) => tryCommit(db, clock, "select public.scheduler_mailbox_failed($1,null,$3,$2)", [run, mb, c]);
    expect(code((await fail(s.mailbox, "auth_failed")).error)).toBe("42501"); // not listed yet
    await listed(run);
    expect(code((await fail(s.mailbox, "timeout")).error)).toBe("22023");
    expect((await fail(s.mailbox, "auth_failed")).error).toBeUndefined();
    expect((await admin<{ status: string; last_error: string }>("select status, last_error from public.mailboxes where id = $1", [s.mailbox]))[0]).toEqual({ status: "error", last_error: "auth_failed" });
    await finish(run);
    await park(s);
  });
});

describe("record_email_reply (the screen's path) is a wrapper with the same rules", () => {
  test("a sender records a reply; a stranger is refused", async () => {
    const s = await sentCampaign("wrapper");
    await createOwner(db, UUID_B).catch(() => undefined);
    const args = [s.prospects[0], s.mailbox, s.messages[0], s.emails[0], "<wrap@mail.example>"];
    const sql = "select public.record_email_reply($1,$2,$3,$4,'Re: hi','yes please',$5,now(),'reply',null) as r";
    expect(code((await db.try(as(UUID_B), sql, args)).error)).toBe("42501");
    const ok = await tryCommit<{ r: string }>(db, as(UUID_A), sql, args);
    expect(ok.rows![0].r).toMatch(/^[0-9a-f-]{36}$/);
    expect((await admin<{ status: string }>("select status from public.email_prospects where id = $1", [s.prospects[0]]))[0].status).toBe("replied");
    await park(s);
  });
});
