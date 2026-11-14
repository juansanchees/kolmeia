import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { OutgoingEmail } from "@/lib/email/compose";
import { encryptSecret, mailboxAad } from "@/lib/email/crypto";
import { sendStep, type Origins, type SendDeps } from "@/lib/email/engine";
import type { MailCreds, SmtpTransport } from "@/lib/email/transport";
import { TestDb, as, UUID_A } from "../db/helpers";
import { addCampaignMailbox, createOwner, seedCampaign, type Seeded } from "../db/scheduler-seed";
import { SqlEmailStore } from "./email-sql-store";

// E3 on the send path: credentials and From come from the mailbox stamped on the claimed message (two real mailboxes, fake SMTP).
const KEY = randomBytes(32);
const PASS = "abcd efgh ijkl mnop";
const ORIGINS: Origins = { publicOrigin: "https://app.example.com", requestOrigin: "https://app.example.com" };
const HOLDER = "88888888-8888-4888-8888-888888888888";
class FakeSmtp implements SmtpTransport {
  sent: { creds: MailCreds; mail: OutgoingEmail }[] = [];
  fail: Error | null = null;
  async verify() {}
  async send(creds: MailCreds, mail: OutgoingEmail) {
    if (this.fail) throw this.fail;
    this.sent.push({ creds, mail });
    return { response: "250 OK" };
  }
}
let db: TestDb;
let ws: string;
let s: Seeded;
let b: { mailbox: string; address: string };
let smtp: FakeSmtp;
let deps: SendDeps;
const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(as(UUID_A), sql, params);
/** The next sequence step of a prospect, approved and due now. */
async function nextStep(prospect: string): Promise<string> {
  const [{ n }] = await q<{ n: number }>("select coalesce(max(step), 0) + 1 as n from public.email_messages where prospect_id = $1 and kind = 'sequence'", [prospect]);
  const id = (await q<{ id: string }>("insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body) values ($1,$2,$3,'sequence',$4,'Following up','Short follow-up.') returning id", [ws, s.campaign, prospect, n]))[0].id;
  await q("select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')", [id]);
  await db.admin("update public.email_messages set due_at = now() - interval '1 minute' where id = $1", [id]);
  return id;
}

beforeAll(async () => {
  db = await TestDb.create();
  ws = await createOwner(db);
  s = await seedCampaign(db, ws, "eng", { n: 2 });
  b = await addCampaignMailbox(db, ws, s.campaign, "engb");
  for (const [mb, address] of [[s.mailbox, s.address], [b.mailbox, b.address]]) {
    await db.admin("update public.mailboxes set secret_ciphertext = $2 where id = $1", [mb, encryptSecret(PASS, mailboxAad(ws, address), KEY)]);
    await q("select public.set_mailbox_verified($1, true, null)", [mb]);
  }
  await db.admin("update public.email_campaigns set min_gap_minutes = 0, random_gap_minutes = 0 where id = $1", [s.campaign]);
  await q("select public.set_campaign_send_mode($1,'real')", [s.campaign]);
  smtp = new FakeSmtp();
  deps = { store: new SqlEmailStore(db, UUID_A), smtp, key: KEY };
});
afterAll(async () => { await db.pg.close(); });

describe("E3 sendStep and the mailbox of the claim", () => {
  test("each real e-mail uses the credentials and From of its claimed mailbox; step 2 keeps the mailbox of step 1", async () => {
    const r1 = await sendStep(deps, s.campaign, HOLDER, ORIGINS);
    const r2 = await sendStep(deps, s.campaign, HOLDER, ORIGINS);
    expect([r1.outcome, r2.outcome]).toEqual(["sent", "sent"]);
    expect(new Set(smtp.sent.map((x) => x.creds.user))).toEqual(new Set([s.address, b.address]));
    for (const x of smtp.sent) expect(x).toMatchObject({ creds: { pass: PASS }, mail: { from: { address: x.creds.user } } });
    const [{ prospect_id }] = await q<{ prospect_id: string }>("select prospect_id from public.email_messages where id = $1", [r1.messageId]);
    const step2 = await nextStep(prospect_id);
    expect(await sendStep(deps, s.campaign, HOLDER, ORIGINS)).toEqual({ outcome: "sent", messageId: step2 });
    expect(smtp.sent[2].creds.user).toBe(smtp.sent[0].creds.user);
  });

  test("a refused password marks the mailbox of that message, not the campaign's first mailbox", async () => {
    const [{ id }] = await q<{ id: string }>("select id from public.email_prospects where campaign_id = $1 and mailbox_id = $2", [s.campaign, b.mailbox]);
    await nextStep(id);
    smtp.fail = Object.assign(new Error("Invalid login"), { code: "EAUTH" });
    expect(await sendStep(deps, s.campaign, HOLDER, ORIGINS)).toMatchObject({ outcome: "failed", error: "auth_failed", stop: true });
    smtp.fail = null;
    const st = await q<{ id: string; status: string }>("select id, status from public.mailboxes where id in ($1,$2)", [s.mailbox, b.mailbox]);
    expect(Object.fromEntries(st.map((r) => [r.id, r.status]))).toEqual({ [s.mailbox]: "ok", [b.mailbox]: "error" });
  });
  test("fails closed: a claim without a recorded mailbox, or one that cannot be loaded, sends nothing and never falls back to another mailbox", async () => {
    const f = await seedCampaign(db, ws, "fc", { n: 2 });                     // own campaign: one mailbox, two people (a failed step blocks its person)
    await db.admin("update public.mailboxes set secret_ciphertext = $2 where id = $1", [f.mailbox, encryptSecret(PASS, mailboxAad(ws, f.address), KEY)]);
    await q("select public.set_mailbox_verified($1, true, null)", [f.mailbox]);
    await db.admin("update public.email_campaigns set min_gap_minutes = 0, random_gap_minutes = 0 where id = $1", [f.campaign]);
    await q("select public.set_campaign_send_mode($1,'real')", [f.campaign]);
    const base = deps.store;
    const before = smtp.sent.length;
    const noMailboxOnMessage = Object.assign(Object.create(base), { getMessage: async (id: string) => ({ ...(await base.getMessage(id))!, mailbox_id: null }) });
    const mailboxNotLoadable = Object.assign(Object.create(base), { getMailbox: async () => null });
    for (const store of [noMailboxOnMessage, mailboxNotLoadable]) {
      const r = await sendStep({ ...deps, store }, f.campaign, HOLDER, ORIGINS);
      expect(r).toMatchObject({ outcome: "failed", error: "mailbox_gone" });
      expect(r.stop).toBeUndefined();
    }
    expect(smtp.sent.length).toBe(before);
    const [{ status }] = await q<{ status: string }>("select status from public.mailboxes where id = $1", [f.mailbox]);
    expect(status).toBe("ok");
  });

  test("fails closed with from_mismatch: the composed From differs from the loaded mailbox address, nothing is sent and the mailbox status is untouched", async () => {
    const f = await seedCampaign(db, ws, "fm", { n: 1 });
    await db.admin("update public.mailboxes set secret_ciphertext = $2 where id = $1", [f.mailbox, encryptSecret(PASS, mailboxAad(ws, f.address), KEY)]);
    await q("select public.set_mailbox_verified($1, true, null)", [f.mailbox]);
    await db.admin("update public.email_campaigns set min_gap_minutes = 0, random_gap_minutes = 0 where id = $1", [f.campaign]);
    await q("select public.set_campaign_send_mode($1,'real')", [f.campaign]);
    const base = deps.store;
    const other = Object.assign(Object.create(base), { getMailbox: async (id: string) => ({ ...(await base.getMailbox(id))!, email: "someone.else@example.com" }) });
    const before = smtp.sent.length;
    const r = await sendStep({ ...deps, store: other }, f.campaign, HOLDER, ORIGINS);
    expect(r).toMatchObject({ outcome: "failed", error: "from_mismatch" });
    expect(r.stop).toBeUndefined();
    expect(smtp.sent.length).toBe(before);
    const [{ status }] = await q<{ status: string }>("select status from public.mailboxes where id = $1", [f.mailbox]);
    expect(status).toBe("ok");
    const [{ st, error }] = await q<{ st: string; error: string }>("select status as st, error from public.email_messages where id = $1", [r.messageId]);
    expect({ st, error }).toEqual({ st: "failed", error: "from_mismatch" });
  });
});
