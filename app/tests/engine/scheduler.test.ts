import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { sendStep, type Origins } from "@/lib/email/engine";
import { NoSendSmtp, runTick, TICK_MAX_SENDS } from "@/lib/email/scheduler";
import { SchedulerStore } from "@/lib/email/scheduler-store";
import type { SmtpTransport } from "@/lib/email/transport";
import { NOT_TODAY, TestDb, anonWithToken, as, setSchedulerToken, UUID_A } from "../db/helpers";
import { TOKEN, createOwner, seedCampaign } from "../db/scheduler-seed";
import { SqlEmailStore } from "./email-sql-store";

// E1: the clock runs the same engine as a person's click, with no user session, for rehearsal campaigns only.
// The store is the real SchedulerStore; its Supabase client is replaced by one that runs each rpc() as the anon
// role with the token header (what PostgREST does), so grants, the token check and the definer functions apply.

const ORIGINS: Origins = { publicOrigin: "https://app.example.com", requestOrigin: null };

/** The throwing transport, with a counter: it must never be called. */
class SpySmtp implements SmtpTransport {
  calls = 0;
  private readonly inner = new NoSendSmtp();
  async send(): Promise<{ response: string }> {
    this.calls++;
    return this.inner.send();
  }
  async verify(): Promise<void> {
    this.calls++;
    return this.inner.verify();
  }
}

let db: TestDb;
let ws: string;
let smtp: SpySmtp;

function clockClient(token = TOKEN): SupabaseClient {
  const actor = anonWithToken(token);
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
const newStore = () => new SchedulerStore(clockClient());
const tick = (store = newStore(), extra: Partial<Parameters<typeof runTick>[0]> = {}) => runTick({ store, origins: ORIGINS, smtp, ...extra });
const admin = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.admin<T>(sql, params);

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
});

describe("E1 done-when", () => {
  test("an approved e-mail in an ensaio campaign is processed by runTick as anon with no user session", async () => {
    const s = await seedCampaign(db, ws, "donewhen");
    const r = await tick();
    expect(r).toMatchObject({ outcome: "ok", campaigns: 1, sent: 1, failed: 0 });

    const [m] = await admin<{ status: string; send_mode: string; claimed_by: string | null; claim_holder: string; sent_at: Date | null; to_address: string; from_address: string }>(
      "select status, send_mode, claimed_by, claim_holder, sent_at, to_address, from_address from public.email_messages where id = $1",
      [s.messages[0]],
    );
    expect(m).toMatchObject({ status: "dry_run", send_mode: "dry_run", claimed_by: null, claim_holder: r.runId, to_address: s.emails[0], from_address: s.address });
    expect(m.sent_at).toBeTruthy();
    const log = await admin<{ claimed_by: string | null; holder: string; mode: string; result: string }>("select claimed_by, holder, mode, result from public.email_send_log where message_id = $1", [s.messages[0]]);
    expect(log).toEqual([{ claimed_by: null, holder: r.runId, mode: "dry_run", result: "dry_run" }]);
    const [hb] = await admin<{ outcome: string; campaigns: number; sent: number; failed: number; error: string | null; finished_at: Date | null }>(
      "select outcome, campaigns, sent, failed, error, finished_at from public.scheduler_runs where id = $1",
      [r.runId],
    );
    expect(hb).toMatchObject({ outcome: "ok", campaigns: 1, sent: 1, failed: 0, error: null });
    expect(hb.finished_at).not.toBeNull();
    expect(smtp.calls).toBe(0); // the throwing transport was never touched
    expect((await admin<{ lease_run: string | null }>("select lease_run from public.scheduler_state"))[0].lease_run).toBeNull();
  });

  test("the default transport cannot send at all", async () => {
    await expect(new NoSendSmtp().send()).rejects.toThrow("scheduler_cannot_send");
    await expect(new NoSendSmtp().verify()).rejects.toThrow("scheduler_cannot_send");
  });

  test("a wrong token does nothing and writes nothing", async () => {
    const s = await seedCampaign(db, ws, "wrongtoken");
    const before = (await admin<{ n: number }>("select count(*)::int as n from public.scheduler_runs"))[0].n;
    await expect(tick(new SchedulerStore(clockClient("0".repeat(64))))).rejects.toMatchObject({ name: "SchedulerAuthError" });
    expect((await admin<{ n: number }>("select count(*)::int as n from public.scheduler_runs"))[0].n).toBe(before);
    expect((await admin<{ status: string }>("select status from public.email_messages where id = $1", [s.messages[0]]))[0].status).toBe("approved");
    await admin("update public.email_campaigns set status = 'paused' where id = $1", [s.campaign]); // out of the way of later tests
  });
});

describe("what is and is not sent", () => {
  test("a paused campaign, a suppressed address and an unapproved draft are not sent", async () => {
    const paused = await seedCampaign(db, ws, "p-paused", { status: "paused" });
    const unapproved = await seedCampaign(db, ws, "p-unapproved", { approve: false });
    const suppressed = await seedCampaign(db, ws, "p-suppressed");
    await db.query(as(UUID_A), "insert into public.suppressions (workspace_id, kind, value, reason) values ($1,'address',$2,'manual')", [ws, suppressed.emails[0]]);
    const r = await tick();
    expect(r).toMatchObject({ outcome: "ok", sent: 0, failed: 0 });
    const status = async (id: string) => (await admin<{ status: string }>("select status from public.email_messages where id = $1", [id]))[0].status;
    expect(await status(paused.messages[0])).toBe("approved");
    expect(await status(unapproved.messages[0])).toBe("draft");
    expect(await status(suppressed.messages[0])).toBe("cancelled"); // R3 still applies
    expect(await admin("select 1 from public.email_send_log where campaign_id = any($1)", [[paused.campaign, unapproved.campaign, suppressed.campaign]])).toHaveLength(0);
    expect(smtp.calls).toBe(0);
    await admin("update public.email_campaigns set status = 'paused' where id = any($1)", [[unapproved.campaign, suppressed.campaign]]);
  });

  test("a real-mode campaign is never touched, even if it has an approved due message", async () => {
    const real = await seedCampaign(db, ws, "r-real");
    await admin("update public.email_campaigns set send_mode = 'real' where id = $1", [real.campaign]);
    const r = await tick();
    expect(r).toMatchObject({ outcome: "ok", campaigns: 0, sent: 0 });
    expect((await admin<{ status: string }>("select status from public.email_messages where id = $1", [real.messages[0]]))[0].status).toBe("approved");
    expect(smtp.calls).toBe(0);
    await admin("update public.email_campaigns set status = 'paused' where id = $1", [real.campaign]);
  });

  test("at most one send per campaign per tick, and the rules (gap) still apply on the next tick", async () => {
    const s = await seedCampaign(db, ws, "gap", { n: 3 });
    const r1 = await tick();
    expect(r1).toMatchObject({ campaigns: 1, sent: 1 });
    const r2 = await tick(); // same mailbox: the 9 min + up to 5 min gap has not passed
    expect(r2).toMatchObject({ outcome: "ok", campaigns: 1, sent: 0 });
    expect((await admin("select 1 from public.email_send_log where campaign_id = $1", [s.campaign]))).toHaveLength(1);
    await admin("update public.email_campaigns set status = 'paused' where id = $1", [s.campaign]);
  });

  test("at most TICK_MAX_SENDS sends in one tick, and no new item once the budget is spent", async () => {
    const many: string[] = [];
    for (let i = 0; i < TICK_MAX_SENDS + 2; i++) many.push((await seedCampaign(db, ws, `many${i}`)).campaign);
    const r = await tick();
    expect(r.sent).toBe(TICK_MAX_SENDS);
    // budget: a clock that jumps past the budget after the first item stops the loop
    let t = 0;
    const r2 = await tick(newStore(), { budgetMs: 1000, now: () => (t += 600) });
    expect(r2.sent).toBeLessThanOrEqual(2);
    await admin("update public.email_campaigns set status = 'paused' where id = any($1)", [many]);
  });
});

describe("overlap and races", () => {
  test("a tick that starts while another is open is 'busy', recorded, and sends nothing; no double send", async () => {
    const s = await seedCampaign(db, ws, "overlap");
    const first = newStore();
    const open = await first.beginRun(); // tick A is in progress
    const busy = await tick();
    expect(busy).toMatchObject({ outcome: "busy", campaigns: 0, sent: 0, failed: 0 });
    expect((await admin<{ outcome: string }>("select outcome from public.scheduler_runs where id = $1", [busy.runId]))[0].outcome).toBe("busy");
    await first.finishRun(open.runId, { campaigns: 0, sent: 0, failed: 0 }, null);
    const done = await tick();
    expect(done.sent).toBe(1);
    const again = await tick();
    expect(again.sent).toBe(0);
    expect(await admin("select 1 from public.email_send_log where campaign_id = $1", [s.campaign])).toHaveLength(1);
    expect(await admin("select 1 from public.email_messages where campaign_id = $1 and status = 'dry_run'", [s.campaign])).toHaveLength(1);
    await admin("update public.email_campaigns set status = 'paused' where id = $1", [s.campaign]);
  });

  test("a tick racing a person's send yields exactly one claim (the row lock and the gap decide, not the app)", async () => {
    const s = await seedCampaign(db, ws, "race");
    const user = new SqlEmailStore(db, UUID_A);
    const holder = randomUUID();
    // the person's claim lands first and has not reported back yet
    const mine = await user.claimNext(s.campaign, holder);
    expect(mine.outcome).toBe("claimed");
    const r = await tick();
    expect(r).toMatchObject({ outcome: "ok", sent: 0, failed: 0 });
    expect(await admin("select 1 from public.email_send_log where campaign_id = $1", [s.campaign])).toHaveLength(1);
    await user.finishSend(mine.message_id!, holder, "dry_run", null);
    // and the other way round: a person's step after the clock's claim finds nothing due
    const s2 = await seedCampaign(db, ws, "race2");
    const r2 = await tick();
    expect(r2.sent).toBe(1);
    const personal = await sendStep({ store: user, smtp }, s2.campaign, randomUUID(), ORIGINS);
    expect(["gap", "nothing_due"]).toContain(personal.outcome); // the gap rule answers first on the same mailbox
    expect(await admin("select 1 from public.email_send_log where campaign_id = $1", [s2.campaign])).toHaveLength(1);
    await admin("update public.email_campaigns set status = 'paused' where id = any($1)", [[s.campaign, s2.campaign]]);
  });
});

describe("heartbeat on success and on error; nothing sensitive in it", () => {
  test("a failure of one item is counted, kept as a short code, and the run still finishes", async () => {
    const s = await seedCampaign(db, ws, "itemfail");
    class Broken extends SchedulerStore {
      override async getMessage(): Promise<never> {
        throw new Error(`could not read ${s.emails[0]}`); // a raw message with an address: must never be stored
      }
    }
    const r = await tick(new Broken(clockClient()));
    expect(r).toMatchObject({ outcome: "error", campaigns: 1, sent: 0, failed: 1 });
    const [hb] = await admin<{ outcome: string; failed: number; error: string; finished_at: Date | null }>("select outcome, failed, error, finished_at from public.scheduler_runs where id = $1", [r.runId]);
    expect(hb).toMatchObject({ outcome: "error", failed: 1, error: "step_error" });
    expect(hb.finished_at).not.toBeNull();
    expect(JSON.stringify(await admin("select * from public.scheduler_runs"))).not.toContain(s.emails[0]);
    // the claimed message is left 'sending'; the existing rule marks it interrupted and never resends it (R9)
    expect((await admin<{ status: string }>("select status from public.email_messages where id = $1", [s.messages[0]]))[0].status).toBe("sending");
    await admin("update public.scheduler_state set lease_run = null, lease_until = null");
    await admin("update public.email_campaigns set status = 'paused' where id = $1", [s.campaign]);
  });

  test("a failure of the clock itself is recorded and rethrown", async () => {
    class NoWork extends SchedulerStore {
      override async dueWork(): Promise<never> {
        throw new Error("db said no to juan@x.example");
      }
    }
    await expect(tick(new NoWork(clockClient()))).rejects.toThrow();
    const [hb] = await admin<{ outcome: string; error: string }>("select outcome, error from public.scheduler_runs order by started_at desc limit 1");
    expect(hb).toEqual({ outcome: "error", error: "tick_error" });
    expect((await admin<{ lease_run: string | null }>("select lease_run from public.scheduler_state"))[0].lease_run).toBeNull();
  });

  test("the scheduler store (switch off) refuses every mailbox call and refuses a claim whose holder is not the run", async () => {
    const st = newStore();
    await expect(st.getMailbox(randomUUID())).rejects.toThrow("no_mailbox_access");
    await expect(st.getMailboxSecret(randomUUID())).rejects.toThrow("no_mailbox_access");
    await expect(st.setMailboxVerified(randomUUID(), false, "auth_failed")).rejects.toThrow("no_mailbox_access");
    await st.beginRun();
    await expect(st.claimNext(randomUUID(), randomUUID())).rejects.toThrow("holder_is_not_the_run");
  });
});

describe("E2 gates on the clock and on a person's click", () => {
  test("outside the window the tick sends nothing and counts no failure; sendStep answers outside_window", async () => {
    const s = await seedCampaign(db, ws, "etwowin");
    await admin(`update public.email_campaigns set send_days = ${NOT_TODAY} where id = $1`, [s.campaign]);
    expect(await tick()).toMatchObject({ outcome: "ok", sent: 0, failed: 0 });
    expect(await sendStep({ store: new SqlEmailStore(db, UUID_A), smtp }, s.campaign, randomUUID(), ORIGINS)).toMatchObject({ outcome: "outside_window" });
    expect(await admin("select 1 from public.email_send_log where campaign_id = $1", [s.campaign])).toHaveLength(0);
    expect(smtp.calls).toBe(0);
    await admin("update public.email_campaigns set status = 'paused' where id = $1", [s.campaign]);
  });
  test("over the campaign limit the tick counts nothing; sendStep answers campaign_limit with the next local midnight", async () => {
    const s = await seedCampaign(db, ws, "etwolim", { n: 2 });
    await admin("update public.email_campaigns set daily_limit = 1, min_gap_minutes = 0, random_gap_minutes = 0 where id = $1", [s.campaign]);
    expect(await tick()).toMatchObject({ outcome: "ok", sent: 1, failed: 0 });
    expect(await tick()).toMatchObject({ outcome: "ok", sent: 0, failed: 0 });
    const r = await sendStep({ store: new SqlEmailStore(db, UUID_A), smtp }, s.campaign, randomUUID(), ORIGINS);
    const [{ e }] = await admin<{ e: Date }>("select public.local_day_end('America/New_York', now()) as e");
    expect(r.outcome).toBe("campaign_limit");
    expect(new Date(r.waitUntil!).toISOString()).toBe(new Date(e).toISOString());
    await admin("update public.email_campaigns set status = 'paused' where id = $1", [s.campaign]);
  });
});
