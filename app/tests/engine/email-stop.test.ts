import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { OutgoingEmail } from "@/lib/email/compose";
import { encryptSecret, mailboxAad } from "@/lib/email/crypto";
import { sendStep, sendTestToSelf, type EmailDeps, type Origins } from "@/lib/email/engine";
import type { ClaimResult } from "@/lib/email/types";
import type { TestClaim } from "@/lib/email/store";
import type { ImapTransport, MailCreds, SmtpTransport } from "@/lib/email/transport";
import { TestDb, as, UUID_A } from "../db/helpers";
import { approveAllC12 } from "../db/c12-seed";
import { createOwner, seedCampaign } from "../db/scheduler-seed";
import { SqlEmailStore } from "./email-sql-store";
import { FakeTransport } from "./fake-ai";

// E4 (0024) emergency stop, engine side: the switch is read again right before SMTP, so a message claimed just before
// someone pressed "Parar todos os envios" does not leave (it fails as retryable 'sending_paused'). Same for the test to
// self. Fake SMTP (spy), PGlite, fictional data.
const KEY = randomBytes(32);
const ORIGINS: Origins = { publicOrigin: "https://app.example.com", requestOrigin: "https://app.example.com" };
const HOLDER = "88888888-8888-4888-8888-888888888888";

class SpySmtp implements SmtpTransport {
  sent: OutgoingEmail[] = [];
  async verify() {}
  async send(_creds: MailCreds, mail: OutgoingEmail) {
    this.sent.push(mail);
    return { response: "250 OK" };
  }
}
const noImap: ImapTransport = { fetchSince: async () => [] };

/** Another tab presses stop between the claim and SMTP. */
class StopAfterClaim extends SqlEmailStore {
  stopNext = false;
  private async press(ws: string) {
    if (!this.stopNext) return;
    this.stopNext = false;
    await db.query(as(UUID_A), "select public.set_sending_paused($1,true)", [ws]);
  }
  async claimNext(campaignId: string, holder: string, messageId: string | null = null): Promise<ClaimResult> {
    const r = await super.claimNext(campaignId, holder, messageId);
    await this.press(ws);
    return r;
  }
  async claimTest(mailboxId: string, to: string): Promise<TestClaim> {
    const r = await super.claimTest(mailboxId, to);
    await this.press(ws);
    return r;
  }
}

let db: TestDb;
let ws: string;
let store: StopAfterClaim;
let smtp: SpySmtp;
let deps: EmailDeps;

beforeAll(async () => {
  db = await TestDb.create();
  ws = await createOwner(db);
  await approveAllC12(db, ws);
  store = new StopAfterClaim(db, UUID_A);
  smtp = new SpySmtp();
  deps = { store, smtp, imap: noImap, ai: new FakeTransport({}), key: KEY };
});
afterAll(async () => { await db.pg.close(); });

async function realCampaign(label: string) {
  const s = await seedCampaign(db, ws, label, { n: 2 });
  await db.admin("update public.email_campaigns set min_gap_minutes = 0, random_gap_minutes = 0 where id = $1", [s.campaign]);
  await db.admin("update public.mailboxes set secret_ciphertext = $2 where id = $1", [s.mailbox, encryptSecret("abcd efgh ijkl mnop", mailboxAad(ws, s.address), KEY)]);
  await db.query(as(UUID_A), "select public.set_mailbox_verified($1, true, null)", [s.mailbox]);
  await db.query(as(UUID_A), "select public.set_campaign_send_mode($1,'real')", [s.campaign]);
  return s;
}

describe("E4 stop re-checked right before SMTP", () => {
  test("a real message claimed just before stop is not sent; it fails as retryable and goes out after the owner resumes", async () => {
    const s = await realCampaign("stopsmtp");
    store.stopNext = true;
    const r = await sendStep(deps, s.campaign, HOLDER, ORIGINS);
    expect(r.outcome).toBe("sending_paused");
    expect(smtp.sent).toHaveLength(0);
    const m = (await db.admin<{ status: string; error: string }>("select status, error from public.email_messages where id = $1", [r.messageId]))[0];
    expect(m).toEqual({ status: "failed", error: "sending_paused" });
    // nothing else is claimed while stopped
    expect((await sendStep(deps, s.campaign, HOLDER, ORIGINS)).outcome).toBe("sending_paused");

    await db.query(as(UUID_A), "select public.set_sending_paused($1,false)", [ws]);
    expect((await db.query<{ r: string }>(as(UUID_A), "select public.retry_failed_email($1) as r", [r.messageId]))[0].r).toBe("approved");
    const ok = await sendStep(deps, s.campaign, HOLDER, ORIGINS);
    expect(ok.outcome).toBe("sent");
    expect(smtp.sent).toHaveLength(1);
  });

  test("the test to self: refused while stopped, and not sent when stop is pressed right after its claim", async () => {
    const s = await realCampaign("stoptest");
    const before = smtp.sent.length;
    await db.query(as(UUID_A), "select public.set_sending_paused($1,true)", [ws]);
    expect(await sendTestToSelf(deps, s.mailbox, "owner@neair.example", "NEAir HVAC", ORIGINS)).toMatchObject({ ok: false, error: "sending_paused" });
    await db.query(as(UUID_A), "select public.set_sending_paused($1,false)", [ws]);

    store.stopNext = true;
    expect(await sendTestToSelf(deps, s.mailbox, "owner@neair.example", "NEAir HVAC", ORIGINS)).toMatchObject({ ok: false, error: "sending_paused" });
    expect(smtp.sent.length).toBe(before);
    expect((await db.admin<{ result: string; error: string }>("select result, error from public.email_send_log where mode = 'test'"))).toEqual([{ result: "failed", error: "sending_paused" }]);
    await db.query(as(UUID_A), "select public.set_sending_paused($1,false)", [ws]);
    expect(await sendTestToSelf(deps, s.mailbox, "owner@neair.example", "NEAir HVAC", ORIGINS)).toMatchObject({ ok: true });
    expect(smtp.sent.length).toBe(before + 1);
  });
});
