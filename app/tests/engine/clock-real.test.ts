import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { OutgoingEmail } from "@/lib/email/compose";
import { realClockEnabled } from "@/lib/email/config";
import { encryptSecret, mailboxAad } from "@/lib/email/crypto";
import type { Origins } from "@/lib/email/engine";
import { runTick } from "@/lib/email/scheduler";
import { SchedulerStore } from "@/lib/email/scheduler-store";
import type { ClaimResult } from "@/lib/email/types";
import type { MailCreds, SmtpTransport } from "@/lib/email/transport";
import { TestDb, anonWithToken, as, setSchedulerToken, UUID_A } from "../db/helpers";
import { approveAllC12 } from "../db/c12-seed";
import { TOKEN, addCampaignMailbox, createOwner, seedCampaign, type Seeded } from "../db/scheduler-seed";

// F4 Task 11 (0025, D4): the clock sends REAL mail only when BOTH locks are open: the workspace's C12 gate (with the
// emergency stop off) in the database, and SCHEDULER_REAL_SEND=1 on the server. The spy transport below WOULD deliver
// (it never throws), so every "0 calls" here is the locks' doing, not a transport that cannot send. PGlite, fictional data;
// the env var is never set: realClockEnabled reads a plain object in these tests.

const KEY = randomBytes(32);
const PASS = "abcd efgh ijkl mnop";
const ORIGINS: Origins = { publicOrigin: "https://app.example.com", requestOrigin: null };

class SpySmtp implements SmtpTransport {
  sends: { creds: MailCreds; mail: OutgoingEmail }[] = [];
  verifies = 0;
  /** When set, every send is attempted (counted) and then fails with this error, as Gmail would. */
  fail: Error | null = null;
  get calls() {
    return this.sends.length + this.verifies;
  }
  async verify(): Promise<void> {
    this.verifies++;
  }
  async send(creds: MailCreds, mail: OutgoingEmail): Promise<{ response: string }> {
    this.sends.push({ creds, mail });
    if (this.fail) throw this.fail;
    return { response: "250 OK" };
  }
}

let db: TestDb;
let ws: string;
let smtp: SpySmtp;

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

/** What the route does: one read of the switch decides the store's mode (the transport is the spy in every case). */
const storeFor = (env: Record<string, string | undefined>) => new SchedulerStore(clockClient(), realClockEnabled(env));
const ON = { SCHEDULER_REAL_SEND: "1" };
const OFF = {};
const tick = (store: SchedulerStore) => runTick({ store, origins: ORIGINS, smtp, key: KEY });
const admin = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.admin<T>(sql, params);
const status = async (id: string) => (await admin<{ status: string }>("select status from public.email_messages where id = $1", [id]))[0].status;
const gateOpen = () => approveAllC12(db, ws);
const gateClosed = () => admin("delete from public.c12_approvals where workspace_id = $1 and item = 'dkim'", [ws]);

async function verifiedMailbox(id: string, address: string) {
  await admin("update public.mailboxes set secret_ciphertext = $2 where id = $1", [id, encryptSecret(PASS, mailboxAad(ws, address), KEY)]);
  await db.query(as(UUID_A), "select public.set_mailbox_verified($1, true, null)", [id]);
}

/** A real-mode campaign (set through the gate, as a person would), one approved due message, a verified mailbox. */
async function realCampaign(label: string): Promise<Seeded> {
  await gateOpen();
  const s = await seedCampaign(db, ws, label);
  await verifiedMailbox(s.mailbox, s.address);
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
  smtp = new SpySmtp();
  await setSchedulerToken(db, TOKEN);
  await admin("update public.scheduler_state set lease_run = null, lease_until = null");
  await admin("update public.workspace_settings set sending_paused = false where workspace_id = $1", [ws]);
});

describe("the switch", () => {
  test("realClockEnabled is on only for the exact string \"1\"; this test process has it unset", () => {
    expect(realClockEnabled({})).toBe(false);
    for (const v of ["0", "true", "yes", " 1", "1 ", "", "on"]) expect(realClockEnabled({ SCHEDULER_REAL_SEND: v }), v).toBe(false);
    expect(realClockEnabled({ SCHEDULER_REAL_SEND: "1" })).toBe(true);
    expect(process.env.SCHEDULER_REAL_SEND).toBeUndefined();
    expect(realClockEnabled()).toBe(false);
  });
});

describe("no SMTP while any lock is closed: gate closed, env off, sending_paused, or the campaign in rehearsal", () => {
  test("env off, gate open: the real campaign is not listed, not claimed, not touched", async () => {
    const s = await realCampaign("envoff");
    const r = await tick(storeFor(OFF));
    expect(r).toMatchObject({ outcome: "ok", campaigns: 0, sent: 0, failed: 0 });
    expect(smtp.calls).toBe(0);
    expect(await status(s.messages[0])).toBe("approved");
    expect(await admin("select 1 from public.email_send_log where campaign_id = $1", [s.campaign])).toHaveLength(0);
    await park(s);
  });

  test("env on, gate closed: due work does not list the real campaign and its claim answers not_active", async () => {
    const s = await realCampaign("gateclosed");
    await gateClosed();
    const store = storeFor(ON);
    const { runId } = await store.beginRun();
    expect(await store.dueWork(runId)).not.toContain(s.campaign);
    expect((await store.claimNext(s.campaign, runId)).outcome).toBe("not_active");
    await store.finishRun(runId, { campaigns: 0, sent: 0, failed: 0 }, null);
    const r = await tick(storeFor(ON));
    expect(r).toMatchObject({ sent: 0, failed: 0 });
    expect(smtp.calls).toBe(0);
    expect(await status(s.messages[0])).toBe("approved");
    await gateOpen();
    await park(s);
  });

  test("env on, gate open, stop on: nothing listed, nothing claimed", async () => {
    const s = await realCampaign("stopon");
    await db.query(as(UUID_A), "select public.set_sending_paused($1,true)", [ws]);
    const r = await tick(storeFor(ON));
    expect(r).toMatchObject({ sent: 0, failed: 0 });
    expect(smtp.calls).toBe(0);
    expect(await status(s.messages[0])).toBe("approved");
    await park(s);
  });

  test("env on, gate open, stop pressed right after the clock's claim: the clock reads it again before SMTP", async () => {
    const s = await realCampaign("stopafter");
    class StopAfterClaim extends SchedulerStore {
      async claimNext(campaignId: string, holder: string, messageId: string | null = null): Promise<ClaimResult> {
        const r = await super.claimNext(campaignId, holder, messageId);
        await db.query(as(UUID_A), "select public.set_sending_paused($1,true)", [ws]);
        return r;
      }
    }
    const r = await tick(new StopAfterClaim(clockClient(), realClockEnabled(ON)));
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(smtp.calls).toBe(0);
    expect((await admin<{ status: string; error: string }>("select status, error from public.email_messages where id = $1", [s.messages[0]]))[0]).toEqual({ status: "failed", error: "sending_paused" });
    await park(s);
  });

  test("env on, gate open, the owner's DB switch off: nothing listed, nothing claimed (the token alone is not enough)", async () => {
    const s = await realCampaign("ownerswitch");
    await db.query(as(UUID_A), "select public.set_clock_real($1,false)", [ws]);
    const r = await tick(storeFor(ON));
    expect(r).toMatchObject({ sent: 0, failed: 0 });
    expect(smtp.calls).toBe(0);
    expect(await status(s.messages[0])).toBe("approved");
    await park(s);
  });

  test("env on, gate open, stop pressed after the mailbox was read: the engine's own check before SMTP stops it", async () => {
    const s = await realCampaign("stopsecret");
    class StopAfterMailbox extends SchedulerStore {
      async getMailbox(mailboxId: string) {
        const m = await super.getMailbox(mailboxId);
        await db.query(as(UUID_A), "select public.set_sending_paused($1,true)", [ws]);
        return m;
      }
    }
    const r = await tick(new StopAfterMailbox(clockClient(), realClockEnabled(ON)));
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(smtp.calls).toBe(0);
    expect((await admin<{ status: string; error: string }>("select status, error from public.email_messages where id = $1", [s.messages[0]]))[0]).toEqual({ status: "failed", error: "sending_paused" });
    await park(s);
  });

  test("env on, the C12 gate revoked right after the clock's claim: the message cannot be built, nothing is sent", async () => {
    const s = await realCampaign("gaterevoked");
    class RevokeAfterClaim extends SchedulerStore {
      async claimNext(campaignId: string, holder: string, messageId: string | null = null): Promise<ClaimResult> {
        const r = await super.claimNext(campaignId, holder, messageId);
        await gateClosed();
        return r;
      }
    }
    const r = await tick(new RevokeAfterClaim(clockClient(), realClockEnabled(ON)));
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(smtp.calls).toBe(0);
    expect((await admin<{ status: string; error: string }>("select status, error from public.email_messages where id = $1", [s.messages[0]]))[0]).toEqual({ status: "failed", error: "compose:address" });
    await gateOpen();
    await park(s);
  });

  test("env on, gate open, the mailbox paused on bounces: nothing claimed", async () => {
    const s = await realCampaign("mbpaused");
    await admin("update public.mailboxes set health_status = 'paused_bounce', paused_at = now() where id = $1", [s.mailbox]);
    const r = await tick(storeFor(ON));
    expect(r).toMatchObject({ sent: 0, failed: 0 });
    expect(smtp.calls).toBe(0);
    expect(await status(s.messages[0])).toBe("approved");
    await park(s);
  });

  test("env on, gate open, the lead marked do_not_call: its message is cancelled, never sent", async () => {
    const s = await realCampaign("leadblock");
    // the prospect's research candidate becomes a lead (as in tests/db/lead-gate.test.ts), then the lead is marked do_not_call
    const lead = (await admin<{ id: string }>("insert into public.leads (workspace_id, origin_kind) values ($1,'import') returning id", [ws]))[0].id;
    await admin("update public.research_candidates r set lead_id = $2 from public.email_prospects p where p.id = $1 and r.id = p.candidate_id", [s.prospects[0], lead]);
    await admin("update public.leads set do_not_call = true where id = $1", [lead]);
    const r = await tick(storeFor(ON));
    expect(r).toMatchObject({ sent: 0, failed: 0 });
    expect(smtp.calls).toBe(0);
    expect(await status(s.messages[0])).toBe("cancelled");
    await park(s);
  });

  test("env on, gate open, the campaign in rehearsal: dry_run through the whole path, no SMTP", async () => {
    await gateOpen();
    const s = await seedCampaign(db, ws, "rehearsal");
    await verifiedMailbox(s.mailbox, s.address);
    const r = await tick(storeFor(ON));
    expect(r).toMatchObject({ outcome: "ok", sent: 1, failed: 0 });
    expect(smtp.calls).toBe(0);
    expect(await status(s.messages[0])).toBe("dry_run");
    await park(s);
  });
});

describe("both locks open", () => {
  test("gate open and switch on (test only): one real e-mail leaves through the message's own mailbox with the footer and List-Unsubscribe", async () => {
    const s = await realCampaign("fullopen");
    const second = await addCampaignMailbox(db, ws, s.campaign, "fullopen-b");
    await verifiedMailbox(second.mailbox, second.address);
    const r = await tick(storeFor(ON));
    expect(r).toMatchObject({ outcome: "ok", campaigns: 1, sent: 1, failed: 0 });
    expect(smtp.sends).toHaveLength(1);
    expect(smtp.verifies).toBe(0);

    const [m] = await admin<{ status: string; send_mode: string; mailbox_id: string; from_address: string; to_address: string; claimed_by: string | null; rfc_message_id: string }>(
      "select status, send_mode, mailbox_id, from_address, to_address, claimed_by, rfc_message_id from public.email_messages where id = $1",
      [s.messages[0]],
    );
    expect(m).toMatchObject({ status: "sent", send_mode: "real", claimed_by: null, to_address: s.emails[0] });
    const own = m.mailbox_id === s.mailbox ? s.address : second.address;
    expect(m.from_address).toBe(own);

    const { creds, mail } = smtp.sends[0];
    expect(creds).toEqual({ user: own, pass: PASS }); // decrypted in memory with the server key, for the stamped mailbox
    expect(mail.from.address).toBe(own);
    expect(mail.to).toBe(s.emails[0]);
    expect(mail.messageId).toBe(m.rfc_message_id);
    expect(mail.text).toContain("New England Air HVAC Corp");
    expect(mail.text).toContain("1 Main St, Millbury, MA 01527");
    expect(mail.text).toContain("https://app.example.com/u/");
    expect(mail.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/app\.example\.com\//);
    expect(mail.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    const log = await admin<{ mode: string; result: string; holder: string }>("select mode, result, holder from public.email_send_log where message_id = $1", [s.messages[0]]);
    expect(log).toEqual([{ mode: "real", result: "sent", holder: r.runId }]);
    const [hb] = await admin<{ sent: number; outcome: string }>("select sent, outcome from public.scheduler_runs where id = $1", [r.runId]);
    expect(hb).toEqual({ sent: 1, outcome: "ok" });
    // nothing else is due: the next tick sends nothing
    const again = await tick(storeFor(ON));
    expect(again.sent).toBe(0);
    expect(smtp.sends).toHaveLength(1);
    await park(s);
  });
});

describe("a broken mailbox on the clock", () => {
  test("auth_failed: the message fails, the mailbox is marked for a re-test, and the next tick tries no AUTH again", async () => {
    const s = await realCampaign("authfail");
    await admin("update public.email_campaigns set min_gap_minutes = 0, random_gap_minutes = 0 where id = $1", [s.campaign]);
    smtp.fail = Object.assign(new Error("Invalid login: 535 5.7.8"), { code: "EAUTH", responseCode: 535 });
    const r = await tick(storeFor(ON));
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(smtp.sends).toHaveLength(1);
    expect((await admin<{ status: string; error: string }>("select status, error from public.email_messages where id = $1", [s.messages[0]]))[0]).toEqual({ status: "failed", error: "auth_failed" });
    expect((await admin<{ status: string; last_error: string }>("select status, last_error from public.mailboxes where id = $1", [s.mailbox]))[0]).toEqual({ status: "error", last_error: "auth_failed" });
    // a person retries the message; the clock still does not touch the broken mailbox
    expect((await db.query<{ r: string }>(as(UUID_A), "select public.retry_failed_email($1) as r", [s.messages[0]]))[0].r).toBe("approved");
    const again = await tick(storeFor(ON));
    expect(again).toMatchObject({ sent: 0, failed: 0 });
    expect(smtp.sends).toHaveLength(1);
    expect(await status(s.messages[0])).toBe("approved");
    await park(s);
  });
});
