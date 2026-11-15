import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { asksToStop, clockReplies } from "@/lib/email/clock-replies";
import { realClockEnabled } from "@/lib/email/config";
import { encryptSecret, mailboxAad } from "@/lib/email/crypto";
import type { Origins } from "@/lib/email/engine";
import type { Incoming } from "@/lib/email/replies";
import { incomingText } from "@/lib/email/text";
import { runTick } from "@/lib/email/scheduler";
import { SchedulerStore } from "@/lib/email/scheduler-store";
import type { ImapTransport, MailCreds, SmtpTransport } from "@/lib/email/transport";
import { TestDb, anonWithToken, as, setSchedulerToken, UUID_A } from "../db/helpers";
import { approveAllC12 } from "../db/c12-seed";
import { TOKEN, createOwner, seedCampaign, type Seeded } from "../db/scheduler-seed";

// F4 Task 12 (0026, E5): the clock reads replies, with rules only (no AI), and only behind the same locks as real
// sending: SCHEDULER_REAL_SEND=1 (+ the mailbox key) on the server, and in the database the C12 gate, the owner's switch,
// the stop off, a mailbox 'ok' + healthy on an active real campaign. The spy IMAP below WOULD return mail (it never
// refuses), so every "0 calls" is the locks' doing. PGlite, fictional data; the env var is never set.

const KEY = randomBytes(32);
const PASS = "abcd efgh ijkl mnop";
const ORIGINS: Origins = { publicOrigin: "https://app.example.com", requestOrigin: null };
const HOLDER = "88888888-8888-4888-8888-888888888888";

class SpySmtp implements SmtpTransport {
  calls = 0;
  async verify(): Promise<void> {
    this.calls++;
  }
  async send(): Promise<{ response: string }> {
    this.calls++;
    return { response: "250 OK" };
  }
}

/** An inbox per mailbox address. Counts every login. */
class SpyImap implements ImapTransport {
  logins: MailCreds[] = [];
  sinces: Date[] = [];
  inbox = new Map<string, Incoming[]>();
  fail: Error | null = null;
  /** Never answers until aborted (a server that trickles). */
  hang = false;
  aborted = false;
  /** Called after the read, before the result is handed back (a slow read). */
  after: (() => void) | null = null;
  get calls() {
    return this.logins.length;
  }
  async fetchSince(creds: MailCreds, since: Date, _max: number, signal?: AbortSignal): Promise<Incoming[]> {
    this.logins.push(creds);
    this.sinces.push(since);
    if (this.fail) throw this.fail;
    if (this.hang) {
      return new Promise((_, reject) => signal?.addEventListener("abort", () => {
        this.aborted = true;
        reject(new Error("closed"));
      }));
    }
    this.after?.();
    return this.inbox.get(creds.user) ?? [];
  }
}
/** The tick's clock: real time plus a jump the tests control. */
let offset = 0;
const clockNow = () => Date.now() + offset;

let db: TestDb;
let ws: string;
let smtp: SpySmtp;
let imap: SpyImap;

function clockClient(): SupabaseClient {
  const actor = anonWithToken(TOKEN);
  return {
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      const keys = Object.keys(args);
      const params = keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k]));
      const named = keys.map((k, i) => `${k} => $${i + 1}${args[k] !== null && typeof args[k] === "object" ? "::jsonb" : ""}`).join(", ");
      try {
        const rows = await db.query<{ r: unknown }>(actor, `select public.${fn}(${named}) as r`, params);
        return { data: rows[0]?.r ?? null, error: null };
      } catch (e) {
        return { data: null, error: { code: (e as { code?: string }).code, message: (e as Error).message } };
      }
    },
  } as unknown as SupabaseClient;
}

const storeFor = (env: Record<string, string | undefined>) => new SchedulerStore(clockClient(), realClockEnabled(env));
const ON = { SCHEDULER_REAL_SEND: "1" };
const OFF = {};
const tick = (store: SchedulerStore, withImap = true) => runTick({ store, origins: ORIGINS, smtp, key: KEY, imap: withImap ? imap : null, now: clockNow });
const admin = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.admin<T>(sql, params);
const replies = (campaign: string) => admin<{ id: string; is_bounce: boolean; classification: string | null }>("select id, is_bounce, classification from public.email_replies where campaign_id = $1", [campaign]);
const prospect = async (id: string) => (await admin<{ status: string; stop_reason: string | null }>("select status, stop_reason from public.email_prospects where id = $1", [id]))[0];

function incoming(over: Partial<Incoming>): Incoming {
  return { messageId: `<in-${randomBytes(6).toString("hex")}@mail.example>`, from: null, subject: "Re: Quick question", inReplyTo: null, references: [], text: "Sounds good, call me Tuesday.", date: new Date(), contentType: "text/plain", autoSubmitted: null, failedRecipients: null, report: null, ...over };
}

type Sent = Seeded & { rfc: string[] };
/** A real campaign, its mailbox verified with an encrypted password, every first step really sent (owner's click). */
async function sentCampaign(label: string, n = 1): Promise<Sent> {
  await approveAllC12(db, ws);
  const s = await seedCampaign(db, ws, label, { n });
  await admin("update public.email_campaigns set min_gap_minutes = 0, random_gap_minutes = 0 where id = $1", [s.campaign]);
  await admin("update public.mailboxes set secret_ciphertext = $2 where id = $1", [s.mailbox, encryptSecret(PASS, mailboxAad(ws, s.address), KEY)]);
  await db.query(as(UUID_A), "select public.set_mailbox_verified($1, true, null)", [s.mailbox]);
  await db.query(as(UUID_A), "select public.set_campaign_send_mode($1,'real')", [s.campaign]);
  await db.query(as(UUID_A), "select public.set_clock_real($1,true)", [ws]);
  for (let i = 0; i < n; i++) {
    const c = (await db.query<{ r: { outcome: string; message_id: string } }>(as(UUID_A), "select public.claim_next_email($1,$2,null) as r", [s.campaign, HOLDER]))[0].r;
    expect(c.outcome).toBe("claimed");
    await db.query(as(UUID_A), "select public.finish_email_send($1,$2,'sent',null)", [c.message_id, HOLDER]);
  }
  const rfc = (await admin<{ rfc_message_id: string }>("select rfc_message_id from public.email_messages where campaign_id = $1 order by to_address", [s.campaign])).map((r) => r.rfc_message_id);
  return { ...s, rfc };
}
/** A step 2 waiting for the prospect (a draft, not due). */
async function step2(s: Seeded, i = 0): Promise<string> {
  return (await admin<{ id: string }>(
    "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body, ai_drafted) values ($1,$2,$3,'sequence',2,'Following up','Hi Pat',false) returning id",
    [ws, s.campaign, s.prospects[i]],
  ))[0].id;
}
const park = (s: Seeded) => admin("update public.email_campaigns set status = 'paused' where id = $1", [s.campaign]);
const replyTo = (s: Sent, i = 0, over: Partial<Incoming> = {}) => imap.inbox.set(s.address, [...(imap.inbox.get(s.address) ?? []), incoming({ from: s.emails[i], inReplyTo: s.rfc[i], ...over })]);

beforeAll(async () => {
  db = await TestDb.create();
  ws = await createOwner(db);
});
afterAll(async () => {
  await db.pg.close();
});
beforeEach(async () => {
  smtp = new SpySmtp();
  imap = new SpyImap();
  offset = 0;
  await setSchedulerToken(db, TOKEN);
  await admin("update public.scheduler_state set lease_run = null, lease_until = null");
  await admin("update public.workspace_settings set sending_paused = false where workspace_id = $1", [ws]);
  await approveAllC12(db, ws);
});

describe("no IMAP while any lock is closed", () => {
  const states: [string, (s: Sent) => Promise<unknown>, boolean?][] = [
    ["env off (rehearsal store)", async () => undefined],
    ["gate closed", () => admin("delete from public.c12_approvals where workspace_id = $1 and item = 'warmup'", [ws])],
    ["owner switch off", () => db.query(as(UUID_A), "select public.set_clock_real($1,false)", [ws])],
    ["stop on", () => db.query(as(UUID_A), "select public.set_sending_paused($1,true)", [ws])],
    ["mailbox paused on bounces", (s) => admin("update public.mailboxes set health_status = 'paused_bounce', paused_at = now() where id = $1", [s.mailbox])],
    ["mailbox in error", (s) => admin("update public.mailboxes set status = 'error', last_error = 'auth_failed' where id = $1", [s.mailbox])],
    ["campaign paused", (s) => park(s)],
  ];
  test.each(states)("%s: zero IMAP logins, nothing recorded, the sequence goes on", async (name, close) => {
    const s = await sentCampaign(`closed-${name.replace(/[^a-z]/g, "")}`);
    const next = await step2(s);
    replyTo(s);
    await close(s);
    const r = await tick(storeFor(name.startsWith("env off") ? OFF : ON));
    expect(r.replies).toBe(0);
    expect(imap.calls).toBe(0);
    expect(smtp.calls).toBe(0);
    expect(await replies(s.campaign)).toHaveLength(0);
    expect(await prospect(s.prospects[0])).toMatchObject({ status: "active" });
    expect((await admin<{ status: string }>("select status from public.email_messages where id = $1", [next]))[0].status).toBe("draft");
    await park(s);
    await approveAllC12(db, ws);
    await db.query(as(UUID_A), "select public.set_clock_real($1,true)", [ws]);
  });

  test("no IMAP transport given (the route without the switch or without the key): zero logins even with every lock open", async () => {
    const s = await sentCampaign("noimap");
    replyTo(s);
    const r = await tick(storeFor(ON), false);
    expect(r.replies).toBe(0);
    expect(imap.calls).toBe(0);
    expect(await replies(s.campaign)).toHaveLength(0);
    await park(s);
  });

  test("a rehearsal store never asks the database for reply mailboxes (no RPC, no IMAP)", async () => {
    const s = await sentCampaign("norpc");
    replyTo(s);
    const store = storeFor(OFF);
    const { runId } = await store.beginRun();
    expect(await store.replyMailboxes()).toEqual([]);
    expect(await clockReplies(store, imap, Date.now, { key: KEY })).toMatchObject({ read: 0, recorded: 0 });
    await store.finishRun(runId, { campaigns: 0, sent: 0, failed: 0 }, null);
    expect(imap.calls).toBe(0);
    await park(s);
  });
});

describe("every lock open (test only): replies read by the clock, rules only", () => {
  test("a reply stops the sequence without anyone opening the screen", async () => {
    const s = await sentCampaign("reply");
    const next = await step2(s);
    replyTo(s);
    // mail that is ours or unrelated is never stored
    imap.inbox.get(s.address)!.push(incoming({ from: s.address, inReplyTo: s.rfc[0] }), incoming({ from: "someone@else.example" }));
    const r = await tick(storeFor(ON));
    expect(r).toMatchObject({ outcome: "ok", sent: 0, replies: 1 });
    expect(imap.logins).toEqual([{ user: s.address, pass: PASS }]); // decrypted in memory with the server key
    const rows = await replies(s.campaign);
    expect(rows).toEqual([expect.objectContaining({ is_bounce: false, classification: null })]); // AI labels stay on the screen
    expect(await prospect(s.prospects[0])).toEqual({ status: "replied", stop_reason: "replied" });
    expect((await admin<{ status: string; cancel_reason: string }>("select status, cancel_reason from public.email_messages where id = $1", [next]))[0]).toEqual({ status: "cancelled", cancel_reason: "replied" });
    const [hb] = await admin<{ outcome: string; error: string | null }>("select outcome, error from public.scheduler_runs where id = $1", [r.runId]);
    expect(hb).toEqual({ outcome: "ok", error: null });
    // the next tick reads it again (same 30-day window) and stores nothing twice
    const again = await tick(storeFor(ON));
    expect(again.replies).toBe(0);
    expect(await replies(s.campaign)).toHaveLength(1);
    await park(s);
  });

  test("an unsubscribe reply suppresses (rule, no AI)", async () => {
    const s = await sentCampaign("unsub");
    const next = await step2(s);
    replyTo(s, 0, { subject: "Re: Quick question", text: "Please remove me from your list.\n\nOn Mon, Juan wrote:\n> Hi Pat" });
    const r = await tick(storeFor(ON));
    expect(r.replies).toBe(1);
    expect((await replies(s.campaign))[0].classification).toBe("unsubscribe");
    expect(await admin<{ reason: string }>("select reason from public.suppressions where workspace_id = $1 and value = $2", [ws, s.emails[0]])).toEqual([{ reason: "asked_to_stop" }]);
    expect(await prospect(s.prospects[0])).toEqual({ status: "stopped", stop_reason: "asked_to_stop" });
    expect((await admin<{ status: string }>("select status from public.email_messages where id = $1", [next]))[0].status).toBe("cancelled");
    await park(s);
  });

  test("an out-of-office reply is labelled by its header and still stops the sequence (existing behaviour)", async () => {
    const s = await sentCampaign("ooo");
    replyTo(s, 0, { subject: "Automatic reply: Quick question", autoSubmitted: "auto-replied", text: "I am out of the office until Monday." });
    expect((await tick(storeFor(ON))).replies).toBe(1);
    expect((await replies(s.campaign))[0].classification).toBe("out_of_office");
    expect(await prospect(s.prospects[0])).toEqual({ status: "replied", stop_reason: "replied" });
    await park(s);
  });

  test("a hard bounce suppresses and counts toward E4: 3 bounces of 3 real sends pause the mailbox", async () => {
    const s = await sentCampaign("bounce", 3);
    for (let i = 0; i < 3; i++) {
      imap.inbox.set(s.address, [
        ...(imap.inbox.get(s.address) ?? []),
        incoming({
          from: "mailer-daemon@googlemail.com",
          subject: "Delivery Status Notification (Failure)",
          contentType: "multipart/report; report-type=delivery-status",
          references: [s.rfc[i]],
          report: `Final-Recipient: rfc822; ${s.emails[i]}\nAction: failed\nStatus: 5.1.1`,
          text: "Address not found",
        }),
      ]);
    }
    const r = await tick(storeFor(ON));
    expect(r.replies).toBe(3);
    expect((await replies(s.campaign)).every((x) => x.is_bounce)).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(await prospect(s.prospects[i])).toEqual({ status: "stopped", stop_reason: "bounced" });
      expect(await admin<{ reason: string }>("select reason from public.suppressions where workspace_id = $1 and value = $2", [ws, s.emails[i]])).toEqual([{ reason: "bounced" }]);
    }
    expect((await admin<{ health_status: string }>("select health_status from public.mailboxes where id = $1", [s.mailbox]))[0].health_status).toBe("paused_bounce");
    // a paused mailbox is not read again
    const again = await tick(storeFor(ON));
    expect(again.replies).toBe(0);
    expect(imap.calls).toBe(1);
    await park(s);
  });

  test("a refused password marks the mailbox through scheduler_mailbox_failed; the next tick logs in no more", async () => {
    const s = await sentCampaign("authfail");
    replyTo(s);
    imap.fail = Object.assign(new Error("Invalid credentials (Failure)"), { authenticationFailed: true });
    const r = await tick(storeFor(ON));
    expect(r).toMatchObject({ outcome: "error", replies: 0 });
    expect(imap.calls).toBe(1);
    expect((await admin<{ status: string; last_error: string }>("select status, last_error from public.mailboxes where id = $1", [s.mailbox]))[0]).toEqual({ status: "error", last_error: "auth_failed" });
    expect((await admin<{ error: string }>("select error from public.scheduler_runs where id = $1", [r.runId]))[0].error).toBe("auth_failed");
    const again = await tick(storeFor(ON));
    expect(again.replies).toBe(0);
    expect(imap.calls).toBe(1);
    await park(s);
  });

  test("a stored secret that cannot be opened: no login, the mailbox is marked", async () => {
    const s = await sentCampaign("badsecret");
    await admin("update public.mailboxes set secret_ciphertext = $2 where id = $1", [s.mailbox, encryptSecret(PASS, mailboxAad(ws, "other@neair.example"), KEY)]);
    replyTo(s);
    const r = await tick(storeFor(ON));
    expect(r.replies).toBe(0);
    expect(imap.calls).toBe(0);
    expect((await admin<{ status: string; last_error: string }>("select status, last_error from public.mailboxes where id = $1", [s.mailbox]))[0]).toEqual({ status: "error", last_error: "mailbox_secret" });
    await park(s);
  });
});

describe("hard limits and narrow rules (review fixes)", () => {
  test("an 'unsubscribe' that matches only by address stops the sequence as a reply but never suppresses", async () => {
    const s = await sentCampaign("addronly");
    imap.inbox.set(s.address, [incoming({ from: s.emails[0], subject: "hello", text: "Please unsubscribe me." })]);
    expect((await tick(storeFor(ON))).replies).toBe(1);
    expect((await replies(s.campaign))[0].classification).toBeNull();
    expect(await admin("select 1 from public.suppressions where workspace_id = $1 and value = $2", [ws, s.emails[0]])).toHaveLength(0);
    expect(await prospect(s.prospects[0])).toEqual({ status: "replied", stop_reason: "replied" });
    await park(s);
  });

  test("a thread-matched unsubscribe from a forged stranger's From suppresses the prospect, never the stranger", async () => {
    const s = await sentCampaign("forgedfrom");
    replyTo(s, 0, { from: "victim@other.example", text: "unsubscribe" });
    expect((await tick(storeFor(ON))).replies).toBe(1);
    const rows = await admin<{ value: string }>("select value from public.suppressions where workspace_id = $1 and value in ($2,'victim@other.example')", [ws, s.emails[0]]);
    expect(rows).toEqual([{ value: s.emails[0] }]);
    const [r] = await admin<{ class_source: string }>("select class_source from public.email_replies where campaign_id = $1", [s.campaign]);
    expect(r.class_source).toBe("rule");
    await park(s);
  });

  test("the IMAP search starts a day before the last read (a busy inbox does not hide older replies behind 50 new ones)", async () => {
    const s = await sentCampaign("since");
    await tick(storeFor(ON));
    const first = imap.sinces[0].getTime();
    expect(Math.abs(first - (Date.now() - 30 * 86_400_000))).toBeLessThan(60_000);
    const [{ at }] = await admin<{ at: Date }>("select clock_replies_at as at from public.mailboxes where id = $1", [s.mailbox]);
    await tick(storeFor(ON));
    expect(imap.sinces[1].getTime()).toBe(new Date(at).getTime() - 86_400_000);
    await park(s);
  });

  test("an IMAP read that hangs is cut at the tick's deadline and its connection closed; the mailbox is not blamed", async () => {
    const s = await sentCampaign("hang");
    imap.hang = true;
    const store = storeFor(ON);
    const { runId } = await store.beginRun();
    const t0 = Date.now();
    const r = await clockReplies(store, imap, Date.now, { key: KEY, deadline: Date.now() + 80 });
    await store.finishRun(runId, { campaigns: 0, sent: 0, failed: 0 }, r.error);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r).toMatchObject({ read: 0, recorded: 0, failed: 1, error: "imap_timeout" });
    expect(imap.aborted).toBe(true);
    expect((await admin<{ status: string }>("select status from public.mailboxes where id = $1", [s.mailbox]))[0].status).toBe("ok");
    await park(s);
  });

  test("past the deadline the clock stops recording and finishes its run; the next tick records the rest once", async () => {
    const s = await sentCampaign("deadline", 2);
    replyTo(s, 0);
    replyTo(s, 1);
    imap.after = () => {
      offset = 60_000; // the read took too long: the tick's 50 s are gone
    };
    const r = await tick(storeFor(ON));
    expect(r.replies).toBe(0);
    expect(await replies(s.campaign)).toHaveLength(0);
    expect((await admin<{ outcome: string }>("select outcome from public.scheduler_runs where id = $1", [r.runId]))[0].outcome).not.toBe("running");
    imap.after = null;
    offset = 0;
    expect((await tick(storeFor(ON))).replies).toBe(2);
    expect((await tick(storeFor(ON))).replies).toBe(0);
    await park(s);
  });
});

describe("rules only on the clock", () => {
  test("asksToStop reads the person's own words, not the quoted e-mail", () => {
    const base = incoming({});
    const says = (text: string, subject = "Re: Quick question") => asksToStop({ ...base, subject, text });
    // real requests
    for (const t of [
      "Please unsubscribe me.",
      "Take me off your list",
      "Please remove me from your mailing list.",
      "remove me from the email list thanks",
      "opt me out",
      "I'd like to opt out of these emails",
      "Stop emailing me",
      "please stop sending me these",
      "Don't email me again.",
      "No more emails please",
    ]) expect(says(t), t).toBe(true);
    expect(says("", "Unsubscribe")).toBe(true);
    // normal replies
    for (const t of [
      "Yes, call me Tuesday.",
      "Can you stop by tomorrow at 10?",
      "Please take me off the cc and add Bob.",
      "Stop sending to my old address, use new@builder.example from now on.",
      "Is there an opt-out on the warranty?",
      "Please don't remove me from your list, we may need you in spring.",
      "Never unsubscribe me, this is useful.",
      "Remove me as the contact, Bob handles HVAC.",
    ]) expect(says(t), t).toBe(false);
  });

  test("asksToStop never reads our own e-mail or footer, however the client quoted it", () => {
    const base = incoming({});
    const footer = "--\nJuan Sanches\nNew England Air HVAC Corp\n1 Main St, Millbury, MA 01527\n\nIf you'd rather not hear from us, unsubscribe here: https://app.example.com/u/abcdEFGH1234";
    const says = (text: string) => asksToStop({ ...base, text });
    expect(says(`Sure.\n\nOn Mon, Juan wrote:\n> reply STOP to unsubscribe`)).toBe(false);
    expect(says("Sure.\n> unsubscribe")).toBe(false);
    // Gmail header wrapped on two lines, no ">" (some clients)
    expect(says(`Sounds good.\n\nOn Mon, Nov 9, 2026 at 10:00 AM Juan Sanches <\nsales@neair.example> wrote:\nHi Pat\n${footer}`)).toBe(false);
    // Portuguese and Spanish clients
    expect(says(`Pode ligar.\n\nEm seg., 9 de nov. de 2026 às 10:00, Juan Sanches <sales@neair.example> escreveu:\nHi Pat\n${footer}`)).toBe(false);
    expect(says(`Claro.\n\nEl lun, 9 nov 2026 a las 10:00, Juan Sanches (<sales@neair.example>) escribió:\nHi Pat\n${footer}`)).toBe(false);
    // Outlook header block
    expect(says(`OK\n\nFrom: Juan Sanches <sales@neair.example>\nSent: Monday\nSubject: Quick question\n\nHi Pat\n${footer}`)).toBe(false);
    // our footer leaked with no header at all
    expect(says(`Thanks, talk soon.\n\n${footer}`)).toBe(false);
    expect(says("Thanks!\nIf you'd rather not hear from us, unsubscribe here: https://app.example.com/u/abcdEFGH1234")).toBe(false);
    // an HTML-only reply (blockquote, no ">")
    const html = `<div>Great, call me.</div><div class="gmail_quote"><div>On Mon, Juan wrote:</div><blockquote class="gmail_quote"><div>Hi Pat</div><div>If you'd rather not hear from us, unsubscribe here: <a href="https://app.example.com/u/abcdEFGH1234">link</a></div></blockquote></div>`;
    expect(says(incomingText({ text: null, html }))).toBe(false);
    expect(incomingText({ text: null, html })).toBe("Great, call me.");
  });

  test("clock-replies.ts never imports the AI and never classifies with it", () => {
    const text = readFileSync(path.resolve(__dirname, "../../src/lib/email/clock-replies.ts"), "utf8");
    expect(text).toMatch(/^import "server-only";/m);
    expect(text).not.toMatch(/@\/lib\/ai\/|classifyReply|classifyPending|draftReply|console\./);
  });
});
