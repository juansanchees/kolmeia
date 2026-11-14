import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, anon as anonActor, as, UUID_A, UUID_B, anonWithToken, setSchedulerToken, ageEmailClaims, NOT_TODAY } from "./helpers";
import { createOwner, seedCampaign, TOKEN, type Seeded } from "./scheduler-seed";

// Migration 0006 (E2 "Portões novos"): window, time zone, campaign limit, 9 + 5 min gap, one person per company [R2] [R7].
let db: TestDb;
let ws: string;
beforeAll(async () => { db = await TestDb.create(); ws = await createOwner(db); });
afterAll(async () => { await db.pg.close(); });
const iso = (d: unknown) => new Date(d as string).toISOString();

describe("0006 settings and helpers", () => {
  test("E2 columns: defaults, checks, readable and not writable by clients", async () => {
    const [c] = await db.query<Record<string, unknown>>(as(UUID_A),
      "insert into public.email_campaigns (workspace_id, name) values ($1,'Defaults') returning id, timezone, window_start, window_end, send_days, daily_limit, min_gap_minutes, random_gap_minutes", [ws]);
    expect(c).toMatchObject({ timezone: "America/New_York", window_start: "09:00:00", window_end: "18:00:00", send_days: [1, 2, 3, 4, 5], daily_limit: 30, min_gap_minutes: 9, random_gap_minutes: 5 });
    const bad = ["timezone = 'Mars/Base'", "timezone = 'EST'", "timezone = '+05'", "timezone = ''", "window_start = '18:00', window_end = '09:00'",
      "window_start = '09:00', window_end = '09:00'", "send_days = '{}'", "send_days = '{0}'", "send_days = '{8}'", "send_days = '{1,NULL}'",
      "daily_limit = 0", "daily_limit = 501", "min_gap_minutes = -1", "min_gap_minutes = 121", "random_gap_minutes = -1", "random_gap_minutes = 61"];
    for (const s of bad) await expect(db.admin(`update public.email_campaigns set ${s} where id = $1`, [c.id]), s).rejects.toThrow(/check constraint/);
    await db.admin("update public.email_campaigns set timezone = 'Asia/Tokyo', window_start = '00:00', window_end = '24:00', send_days = '{6,7}', daily_limit = 500, min_gap_minutes = 0, random_gap_minutes = 60 where id = $1", [c.id]);
    await db.admin("update public.email_campaigns set timezone = 'UTC' where id = $1", [c.id]);
    for (const s of ["timezone = 'UTC'", "window_start = '08:00'", "window_end = '17:00'", "send_days = '{1}'", "daily_limit = 10", "min_gap_minutes = 1", "random_gap_minutes = 1"]) {
      expect((await db.try(as(UUID_A), `update public.email_campaigns set ${s} where id = $1`, [c.id])).error?.message, s).toMatch(/permission denied/);
    }
    expect((await db.try(as(UUID_A), "insert into public.email_campaigns (workspace_id, name, daily_limit) values ($1,'x',5)", [ws])).error?.message).toMatch(/permission denied/);
  });

  test("local day bounds survive DST (23 h and 25 h days)", async () => {
    const [r] = await db.admin(`select
      public.local_day_start('America/New_York','2026-03-08T12:00:00Z') as s1, public.local_day_end('America/New_York','2026-03-08T12:00:00Z') as e1,
      public.local_day_start('America/New_York','2026-11-01T12:00:00Z') as s2, public.local_day_end('America/New_York','2026-11-01T12:00:00Z') as e2,
      public.local_day_start('Asia/Tokyo','2026-11-13T20:00:00Z') as s3`);
    expect([iso(r.s1), iso(r.e1), iso(r.s2), iso(r.e2), iso(r.s3)]).toEqual([
      "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z", "2026-11-13T15:00:00.000Z"]);
  });

  test("in_send_window: weekday, start inclusive, end exclusive, zone and DST", async () => {
    const w = async (tz: string, at: string, start = "09:00", end = "18:00", days = "{1,2,3,4,5}") =>
      (await db.admin<{ ok: boolean }>("select public.in_send_window($1,$2::time,$3::time,$4::smallint[],$5::timestamptz) as ok", [tz, start, end, days, at]))[0].ok;
    const NY = "America/New_York";
    expect(await w(NY, "2026-11-16T14:00:00Z")).toBe(true);   // Mon 09:00 EST
    expect(await w(NY, "2026-11-16T13:59:59Z")).toBe(false);
    expect(await w(NY, "2026-11-16T22:59:59Z")).toBe(true);
    expect(await w(NY, "2026-11-16T23:00:00Z")).toBe(false);  // 18:00 is outside
    expect(await w(NY, "2026-11-14T15:00:00Z")).toBe(false);  // Saturday
    expect(await w(NY, "2026-03-09T13:30:00Z")).toBe(true);   // Mon 09:30 EDT
    expect(await w(NY, "2026-03-06T13:30:00Z")).toBe(false);  // Fri 08:30 EST
    expect(await w("America/Los_Angeles", "2026-11-16T14:30:00Z")).toBe(false);
    expect(await w("Europe/London", "2026-11-16T14:30:00Z")).toBe(true);
    expect(await w("Asia/Tokyo", "2026-11-16T14:30:00Z")).toBe(false);
    expect(await w("UTC", "2026-11-14T23:59:59Z", "00:00", "24:00", "{1,2,3,4,5,6,7}")).toBe(true);
  });

  test("company_key: research company, then business domain, then the company name", async () => {
    const k = async (cand: string | null, email: string | null, name: string) =>
      (await db.admin<{ k: string }>("select public.company_key($1::uuid,$2,$3) as k", [cand, email, name]))[0].k;
    const id = "0b5e5e5e-0000-4000-8000-000000000001";
    expect(await k(id, "a@acme.example", "Acme")).toBe(id);
    expect(await k(null, "Pat@Acme.Example", "Acme")).toBe("acme.example");
    expect(await k(null, "pat@gmail.com", "  Acme Builders ")).toBe("acme builders");
    expect(await k(null, "x@ProtonMail.com", "Beta")).toBe("beta");
    expect(await k(null, null, "Gamma")).toBe("gamma");
  });
});

type Claim = { outcome: string; message_id?: string; wait_until?: string };
const HOLDER = "22222222-2222-4222-8222-222222222222";
const claim = async (camp: string, user = UUID_A, message: string | null = null) =>
  (await db.query<{ r: Claim }>(as(user), "select public.claim_next_email($1,$2,$3) as r", [camp, HOLDER, message]))[0].r;
const finish = (msg: string, user = UUID_A) => db.query(as(user), "select public.finish_email_send($1,$2,'dry_run',null)", [msg, HOLDER]);
const set = (camp: string, sql: string) => db.admin(`update public.email_campaigns set ${sql} where id = $1`, [camp]);
async function clockClaim(camp: string): Promise<Claim> {
  await setSchedulerToken(db, TOKEN);
  const clock = anonWithToken(TOKEN);
  const run = (await db.query<{ r: { run_id: string } }>(clock, "select public.scheduler_begin_run() as r"))[0].r.run_id;
  const r = (await db.query<{ r: Claim }>(clock, "select public.scheduler_claim_next_email($1,$2) as r", [run, camp]))[0].r;
  await db.query(clock, "select public.scheduler_finish_run($1,'{}'::jsonb,null)", [run]);
  return r;
}
/** The prospect of `sent` replies; a person writes and approves an answer. Returns the answer's id. */
async function answerReply(s: Seeded, sent: string): Promise<string> {
  const p = (await db.admin<{ id: string; email: string }>("select p.id, p.email from public.email_messages m join public.email_prospects p on p.id = m.prospect_id where m.id = $1", [sent]))[0];
  const reply = (await db.query<{ r: string }>(as(UUID_A), "select public.record_email_reply($1,$2,$3,$4,'Re: Quick question','Sounds good',$5,now(),'reply',null) as r", [p.id, s.mailbox, sent, p.email, `<r-${sent}@x.example>`]))[0].r;
  const a = (await db.query<{ id: string }>(as(UUID_A), "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, reply_to_id, subject, body) values ($1,$2,$3,'reply',$4,'Re: Quick question','Hi, sure.') returning id", [ws, s.campaign, p.id, reply]))[0].id;
  await db.query(as(UUID_A), "select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')", [a]);
  return a;
}

describe("E2 gate 3: Dentro do horário", () => {
  test("outside the window nothing is claimed on the user path, the clock path and in real mode; inside it is", async () => {
    const s = await seedCampaign(db, ws, "win");
    await set(s.campaign, `send_days = ${NOT_TODAY}`);
    expect(await claim(s.campaign)).toEqual({ outcome: "outside_window", wait_until: expect.any(String) });
    expect(await clockClaim(s.campaign)).toEqual({ outcome: "outside_window", wait_until: expect.any(String) });
    await set(s.campaign, "send_mode = 'real'");   // unverified mailbox: the window answers first
    expect(await claim(s.campaign)).toEqual({ outcome: "outside_window", wait_until: expect.any(String) });
    await set(s.campaign, "send_mode = 'dry_run', send_days = '{1,2,3,4,5,6,7}'");
    expect(await db.admin("select 1 from public.email_send_log where campaign_id = $1", [s.campaign])).toHaveLength(0);
    expect(await clockClaim(s.campaign)).toMatchObject({ outcome: "claimed", message_id: s.messages[0] });
  });

  test("the window is read in the campaign's own time zone", async () => {
    // UTC+14 and UTC-11 are never on the same calendar day
    const k = await seedCampaign(db, ws, "tzkir");
    const p = await seedCampaign(db, ws, "tzpago");
    const today = "array[extract(isodow from now() at time zone 'Pacific/Kiritimati')]::smallint[]";
    await set(k.campaign, `timezone = 'Pacific/Kiritimati', send_days = ${today}`);
    await set(p.campaign, `timezone = 'Pacific/Pago_Pago', send_days = ${today}`);
    expect(await claim(k.campaign)).toMatchObject({ outcome: "claimed", message_id: k.messages[0] });
    expect(await claim(p.campaign)).toEqual({ outcome: "outside_window", wait_until: expect.any(String) });
  });

  test("an answer to a reply is exempt from the window (sequence steps still wait)", async () => {
    const s = await seedCampaign(db, ws, "winreply", { n: 2 });
    await set(s.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    const first = (await claim(s.campaign)).message_id!;
    await finish(first);
    const answer = await answerReply(s, first);
    await set(s.campaign, `send_days = ${NOT_TODAY}`);
    expect(await claim(s.campaign)).toMatchObject({ outcome: "claimed", message_id: answer });
    await finish(answer);
    expect(await claim(s.campaign)).toEqual({ outcome: "outside_window", wait_until: expect.any(String) });
  });
});

const dayEnd = async (tz: string) => iso((await db.admin<{ e: Date }>("select public.local_day_end($1, now()) as e", [tz]))[0].e);
const mailboxLimit = (mb: string, n: number) => db.query(as(UUID_A), "update public.mailboxes set daily_limit = $2 where id = $1", [mb, n]);

describe("E2 gate 4: Limite do dia", () => {
  test("the mailbox limit counts from local midnight of the campaign's zone, not the last 24 h", async () => {
    const s = await seedCampaign(db, ws, "mbday", { n: 2 });
    await set(s.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    await mailboxLimit(s.mailbox, 1);
    await finish((await claim(s.campaign)).message_id!);
    const lim = await claim(s.campaign);
    expect(lim.outcome).toBe("daily_limit");
    expect(iso(lim.wait_until)).toBe(await dayEnd("America/New_York"));
    const [{ secs }] = await db.admin<{ secs: number }>("select ceil(extract(epoch from now() - public.local_day_start('America/New_York', now())))::int + 60 as secs");
    await ageEmailClaims(db, secs);   // the claim is now 1 min before local midnight: inside the last 24 h, but yesterday
    expect((await claim(s.campaign)).outcome).toBe("claimed");
  });

  test("a mailbox shared by campaigns in two zones counts from each claiming campaign's own midnight", async () => {
    const ny = await seedCampaign(db, ws, "shny", { n: 2 });
    const tk = await seedCampaign(db, ws, "shtk", { n: 2 });
    await set(ny.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    await set(tk.campaign, `mailbox_id = '${ny.mailbox}', timezone = 'Asia/Tokyo', min_gap_minutes = 0, random_gap_minutes = 0`);
    await mailboxLimit(ny.mailbox, 1);
    await finish((await claim(ny.campaign)).message_id!);
    const [r] = await db.admin<{ secs: number; ny_later: boolean }>(`select ceil(extract(epoch from now() - greatest(a, b)))::int + 60 as secs, a > b as ny_later
      from (select public.local_day_start('America/New_York', now()) a, public.local_day_start('Asia/Tokyo', now()) b) t`);
    await ageEmailClaims(db, r.secs);   // 1 min before the later midnight: "today" in one zone, "yesterday" in the other
    const [later, earlier] = r.ny_later ? [ny.campaign, tk.campaign] : [tk.campaign, ny.campaign];
    expect((await claim(earlier)).outcome).toBe("daily_limit");
    expect((await claim(later)).outcome).toBe("claimed");
  });

  test("campaign_limit stops the campaign at its own limit; the lower limit wins; replies are exempt", async () => {
    const s = await seedCampaign(db, ws, "cplim", { n: 3 });
    await set(s.campaign, "daily_limit = 1, min_gap_minutes = 0, random_gap_minutes = 0");
    const first = (await claim(s.campaign)).message_id!;
    await finish(first);
    const c = await claim(s.campaign);
    expect(c.outcome).toBe("campaign_limit");
    expect(iso(c.wait_until)).toBe(await dayEnd("America/New_York"));
    expect(await clockClaim(s.campaign)).toMatchObject({ outcome: "campaign_limit" });
    await set(s.campaign, "daily_limit = 5");
    await mailboxLimit(s.mailbox, 1);
    expect((await claim(s.campaign)).outcome).toBe("daily_limit");
    await mailboxLimit(s.mailbox, 30);
    await set(s.campaign, "daily_limit = 1");
    const answer = await answerReply(s, first);
    expect(await claim(s.campaign)).toMatchObject({ outcome: "claimed", message_id: answer });
  });

  test("campaign_claims_since: a row exactly at the boundary instant is not counted, one just after is", async () => {
    const s = await seedCampaign(db, ws, "bound", { n: 1 });
    await set(s.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    await finish((await claim(s.campaign)).message_id!);
    const n = async (delta: string) => (await db.admin<{ n: number }>(
      `select public.campaign_claims_since($1, 'dry_run', (select claimed_at from public.email_send_log where campaign_id = $1) ${delta}) as n`, [s.campaign]))[0].n;
    expect(await n("")).toBe(0);                          // since == claimed_at: strict >
    expect(await n("- interval '1 microsecond'")).toBe(1);
    expect(await n("+ interval '1 microsecond'")).toBe(0);
  });
});

describe("E2 gate 5: Intervalo", () => {
  test("the gap is 9 min + up to 5 min drawn per claim (540-840 s), stored on the message and the log", async () => {
    const s = await seedCampaign(db, ws, "gapa", { n: 2 });
    await set(s.campaign, "min_gap_minutes = 9, random_gap_minutes = 5");
    const c1 = await claim(s.campaign);
    await finish(c1.message_id!);
    const [g] = await db.admin<{ next_gap_seconds: number; gap_seconds: number }>("select m.next_gap_seconds, l.gap_seconds from public.email_messages m join public.email_send_log l on l.message_id = m.id where m.id = $1", [c1.message_id]);
    expect(g.next_gap_seconds).toBeGreaterThanOrEqual(540);
    expect(g.next_gap_seconds).toBeLessThanOrEqual(840);
    expect(g.gap_seconds).toBe(g.next_gap_seconds);
    const w = await claim(s.campaign);
    expect(w.outcome).toBe("gap");
    expect(new Date(w.wait_until!).getTime() - Date.now()).toBeGreaterThan(500_000);
    await ageEmailClaims(db, g.next_gap_seconds - 30);
    expect((await claim(s.campaign)).outcome).toBe("gap");
    await ageEmailClaims(db, 31);
    expect((await claim(s.campaign)).outcome).toBe("claimed");
  });

  test("0 + 0 means no gap; 120 + 60 is accepted (up to 10800 s)", async () => {
    const s = await seedCampaign(db, ws, "gapb", { n: 3 });
    await set(s.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    await finish((await claim(s.campaign)).message_id!);
    await set(s.campaign, "min_gap_minutes = 120, random_gap_minutes = 60");
    const c2 = await claim(s.campaign);
    expect(c2.outcome).toBe("claimed");
    const [g] = await db.admin<{ next_gap_seconds: number }>("select next_gap_seconds from public.email_messages where id = $1", [c2.message_id]);
    expect(g.next_gap_seconds).toBeGreaterThanOrEqual(7200);
    expect(g.next_gap_seconds).toBeLessThanOrEqual(10800);
  });
});

async function addProspect(camp: string, company: string, email: string, candidate: string | null = null, workspace = ws, user = UUID_A) {
  const prospect = (await db.admin<{ id: string }>("insert into public.email_prospects (workspace_id, campaign_id, candidate_id, company_name, email, email_source) values ($1,$2,$3,$4,$5,'manual') returning id", [workspace, camp, candidate, company, email]))[0].id;
  const message = (await db.query<{ id: string }>(as(user), "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body) values ($1,$2,$3,'sequence',1,'Hello there','Hi, short note.') returning id", [workspace, camp, prospect]))[0].id;
  await db.query(as(user), "select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')", [message]);
  return { prospect, message };
}
async function addStep(camp: string, prospect: string, step: 2 | 3): Promise<string> {
  const id = (await db.query<{ id: string }>(as(UUID_A), "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body) values ($1,$2,$3,'sequence',$4,'Following up','Short follow-up.') returning id", [ws, camp, prospect, step]))[0].id;
  await db.query(as(UUID_A), "select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')", [id]);
  await db.admin("update public.email_messages set due_at = now() - interval '1 minute' where id = $1", [id]);
  return id;
}
async function drain(camp: string, n: number, user = UUID_A): Promise<string[]> {
  const got: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = await claim(camp, user);
    got.push(c.message_id ?? c.outcome);
    if (c.message_id) await finish(c.message_id, user);
  }
  return got;
}
const statusOf = async (id: string) => (await db.admin<{ status: string }>("select status from public.email_messages where id = $1", [id]))[0].status;

describe("E2 gate 6: Uma pessoa por empresa [R7]", () => {
  test("R7 one person per company per local day; a blocked prospect is skipped and the queue moves on", async () => {
    const s = await seedCampaign(db, ws, "coa");
    await set(s.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    const x1 = await addProspect(s.campaign, "Acme", "x1@acme.example");
    const x2 = await addProspect(s.campaign, "Acme Inc", "x2@acme.example");
    const y = await addProspect(s.campaign, "Beta", "y@beta.example");
    expect(await drain(s.campaign, 4)).toEqual([s.messages[0], x1.message, y.message, "nothing_due"]);
    expect(await statusOf(x2.message)).toBe("approved");   // waits for tomorrow, not cancelled
    await ageEmailClaims(db, 2 * 86_400);
    expect(await drain(s.campaign, 1)).toEqual([x2.message]);
  });

  test("free-mail addresses fall back to the trimmed, lowercased company name", async () => {
    const s = await seedCampaign(db, ws, "cob");
    await set(s.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    const a = await addProspect(s.campaign, "Acme Builders", "a@gmail.com");
    const b = await addProspect(s.campaign, "Beta Homes", "b@gmail.com");
    await addProspect(s.campaign, "  ACME builders ", "c@yahoo.com");
    expect(await drain(s.campaign, 4)).toEqual([s.messages[0], a.message, b.message, "nothing_due"]);
  });

  test("the research company counts across campaigns of the workspace; another workspace does not count", async () => {
    const s1 = await seedCampaign(db, ws, "coc1");
    const s2 = await seedCampaign(db, ws, "coc2");
    for (const s of [s1, s2]) await set(s.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    const cand = (await db.admin<{ c: string }>("select candidate_id as c from public.email_prospects where id = $1", [s1.prospects[0]]))[0].c;
    const twin = await addProspect(s2.campaign, "Other name", "boss@elsewhere.example", cand);
    const shared = await addProspect(s1.campaign, "Shared", "z@shared.example");
    expect(await drain(s1.campaign, 2)).toEqual([s1.messages[0], shared.message]);
    expect(await drain(s2.campaign, 2)).toEqual([s2.messages[0], "nothing_due"]);
    expect(await statusOf(twin.message)).toBe("approved");
    const wsB = await createOwner(db, UUID_B);
    const b = await seedCampaign(db, wsB, "cocb", { userId: UUID_B });
    await set(b.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    const other = await addProspect(b.campaign, "Shared", "w@shared.example", null, wsB, UUID_B);
    expect(await drain(b.campaign, 2, UUID_B)).toEqual([b.messages[0], other.message]);
  });

  test("a follow-up of the same person may go the same day; another person of a company mailed today waits", async () => {
    const s = await seedCampaign(db, ws, "cod");
    await set(s.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    const a = await addProspect(s.campaign, "Delta", "a@delta.example");
    const b = await addProspect(s.campaign, "Delta", "b@delta.example");
    expect(await drain(s.campaign, 3)).toEqual([s.messages[0], a.message, "nothing_due"]);
    await ageEmailClaims(db, 2 * 86_400);
    expect(await drain(s.campaign, 1)).toEqual([b.message]);         // today: only b of Delta
    const a2 = await addStep(s.campaign, a.prospect, 2);
    const b2 = await addStep(s.campaign, b.prospect, 2);
    expect(await drain(s.campaign, 2)).toEqual([b2, "nothing_due"]);
    expect(await statusOf(a2)).toBe("approved");
  });

  test("a company key that is NULL never matches another NULL key (no usable key means no block)", async () => {
    const [r] = await db.admin<{ k1: string | null; k2: string | null; same: boolean | null }>(`select
      public.company_key(null, null, null) as k1, public.company_key(null, 'x@gmail.com', null) as k2,
      (public.company_key(null, null, null) = public.company_key(null, 'x@gmail.com', null)) as same`);
    expect([r.k1, r.k2, r.same]).toEqual([null, null, null]);   // `=` on NULL is not true, so the claim's not-exists lets both through
  });
});

// ---------------------------------------------------------------- E2 fix wave
describe("fix wave 1: the next real sending moment", () => {
  const nwo = async (tz: string, after: string, start = "09:00", end = "18:00", days = "{1,2,3,4,5}") =>
    iso((await db.admin<{ t: Date }>("select public.next_window_open($1,$2::time,$3::time,$4::smallint[],$5::timestamptz) as t", [tz, start, end, days, after]))[0].t);
  const NY = "America/New_York";

  test("next_window_open: Friday evening goes to Monday morning; inside the window it is unchanged", async () => {
    expect(await nwo(NY, "2026-11-14T00:00:00Z")).toBe("2026-11-16T14:00:00.000Z");   // Fri 19:00 EST -> Mon 09:00 EST
    expect(await nwo(NY, "2026-11-14T15:00:00Z")).toBe("2026-11-16T14:00:00.000Z");   // Saturday noon
    expect(await nwo(NY, "2026-11-16T15:00:00Z")).toBe("2026-11-16T15:00:00.000Z");   // Mon 10:00: inside, unchanged
    expect(await nwo(NY, "2026-11-16T14:00:00Z")).toBe("2026-11-16T14:00:00.000Z");   // start is inclusive
    expect(await nwo(NY, "2026-11-16T13:59:59Z")).toBe("2026-11-16T14:00:00.000Z");
    expect(await nwo(NY, "2026-11-16T23:00:00Z")).toBe("2026-11-17T14:00:00.000Z");   // 18:00 is outside: Tuesday 09:00
    expect(await nwo("Asia/Tokyo", "2026-11-13T20:00:00Z")).toBe("2026-11-16T00:00:00.000Z");   // Sat 05:00 JST -> Mon 09:00 JST
  });

  test("next_window_open: window_end 24:00", async () => {
    expect(await nwo(NY, "2026-11-14T04:59:59Z", "09:00", "24:00")).toBe("2026-11-14T04:59:59.000Z");   // Fri 23:59:59 EST, inside
    expect(await nwo(NY, "2026-11-14T05:00:00Z", "09:00", "24:00")).toBe("2026-11-16T14:00:00.000Z");   // Sat 00:00 -> Mon 09:00
    expect(await nwo(NY, "2026-11-14T15:00:00Z", "00:00", "24:00")).toBe("2026-11-16T05:00:00.000Z");   // Sat -> Mon 00:00 EST
  });

  test("next_window_open: DST-change weekends", async () => {
    expect(await nwo(NY, "2026-03-07T00:00:00Z")).toBe("2026-03-09T13:00:00.000Z");   // Fri 19:00 EST -> Mon 09:00 EDT
    expect(await nwo(NY, "2026-10-31T00:00:00Z")).toBe("2026-11-02T14:00:00.000Z");   // Fri 20:00 EDT -> Mon 09:00 EST
    expect(await nwo(NY, "2026-03-08T00:00:00Z", "09:00", "18:00", "{7}")).toBe("2026-03-08T13:00:00.000Z");   // Sat 19:00 EST -> Sun 09:00 EDT (spring-forward day)
    expect(await nwo(NY, "2026-11-01T07:00:00Z", "09:00", "18:00", "{7}")).toBe("2026-11-01T14:00:00.000Z");   // fall-back day, 02:00 EST -> 09:00 EST
  });

  const todayOnly = "array[extract(isodow from now() at time zone 'America/New_York')]::smallint[]";
  const sameWeekdayNextWeek = async () => iso((await db.admin<{ e: Date }>("select ((date_trunc('day', now() at time zone 'America/New_York') + interval '7 days') at time zone 'America/New_York') as e"))[0].e);

  test("outside_window says when the window opens", async () => {
    const s = await seedCampaign(db, ws, "nwo1");
    await set(s.campaign, `window_start = '09:00', window_end = '18:00', send_days = ${NOT_TODAY}`);
    const r = await claim(s.campaign);
    expect(r.outcome).toBe("outside_window");
    expect(r.wait_until).toBeTruthy();
    const [x] = await db.admin<{ open: boolean; before: boolean; future: boolean; hhmm: string }>(`select
      public.in_send_window('America/New_York','09:00','18:00',(select send_days from public.email_campaigns where id = $1), $2::timestamptz) as open,
      public.in_send_window('America/New_York','09:00','18:00',(select send_days from public.email_campaigns where id = $1), $2::timestamptz - interval '1 second') as before,
      $2::timestamptz > now() as future, to_char($2::timestamptz at time zone 'America/New_York','HH24:MI') as hhmm`, [s.campaign, r.wait_until]);
    expect(x).toEqual({ open: true, before: false, future: true, hhmm: "09:00" });
    expect((await clockClaim(s.campaign)).wait_until).toBe(r.wait_until);
  });

  test("daily_limit and campaign_limit say when sending really resumes (the next allowed window after local midnight)", async () => {
    const s = await seedCampaign(db, ws, "nwo2", { n: 2 });
    await set(s.campaign, `send_days = ${todayOnly}, min_gap_minutes = 0, random_gap_minutes = 0`);
    await mailboxLimit(s.mailbox, 1);
    await finish((await claim(s.campaign)).message_id!);
    const d = await claim(s.campaign);
    expect(d.outcome).toBe("daily_limit");
    expect(iso(d.wait_until)).toBe(await sameWeekdayNextWeek());   // today only: next Monday-or-whatever 00:00, not tomorrow
    const c = await seedCampaign(db, ws, "nwo3", { n: 2 });
    await set(c.campaign, `send_days = ${todayOnly}, daily_limit = 1, min_gap_minutes = 0, random_gap_minutes = 0`);
    await finish((await claim(c.campaign)).message_id!);
    const l = await claim(c.campaign);
    expect(l.outcome).toBe("campaign_limit");
    expect(iso(l.wait_until)).toBe(await sameWeekdayNextWeek());
  });
});

describe("fix wave 2: more free-mail providers", () => {
  test("company_key falls back to the company name for every free-mail domain", async () => {
    const k = async (email: string) => (await db.admin<{ k: string }>("select public.company_key(null::uuid,$1,'Acme Co') as k", [email]))[0].k;
    for (const d of ["comcast.net", "verizon.net", "att.net", "sbcglobal.net", "bellsouth.net", "cox.net", "charter.net", "msn.com", "ymail.com", "mail.com", "gmx.com"]) {
      expect(await k(`x@${d}`), d).toBe("acme co");
    }
    expect(await k("x@comcastic.net")).toBe("comcastic.net");
  });

  test("two prospects on comcast.net with different company names and no candidate are different companies", async () => {
    const s = await seedCampaign(db, ws, "comc");
    await set(s.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    const a = await addProspect(s.campaign, "Alpha Heating", "a@comcast.net");
    const b = await addProspect(s.campaign, "Bravo Cooling", "b@comcast.net");
    const got = await drain(s.campaign, 3);
    expect(got).toEqual([s.messages[0], a.message, b.message]);
  });
});

describe("fix wave 3: the company rule reads the append-only log", () => {
  const finishAs = (msg: string, result: "dry_run" | "sent" | "failed", user = UUID_A) =>
    db.query(as(user), "select public.finish_email_send($1,$2,$3,null)", [msg, HOLDER, result]);
  const retry = (msg: string) => db.query(as(UUID_A), "select public.retry_failed_email($1)", [msg]);

  test("a failed claim of person A does not block person B of the same company", async () => {
    const s = await seedCampaign(db, ws, "cof");
    await set(s.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    const a = await addProspect(s.campaign, "Foxtrot", "a@foxtrot.example");
    const b = await addProspect(s.campaign, "Foxtrot", "b@foxtrot.example");
    await finish((await claim(s.campaign)).message_id!);           // the seeded prospect
    expect((await claim(s.campaign)).message_id).toBe(a.message);
    await finishAs(a.message, "failed");
    expect((await claim(s.campaign)).message_id).toBe(b.message);
  });

  test("an interrupted claim (unknown result) does not block either", async () => {
    const s = await seedCampaign(db, ws, "cofi");
    await set(s.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    const a = await addProspect(s.campaign, "Fox Two", "a@foxtwo.example");
    const b = await addProspect(s.campaign, "Fox Two", "b@foxtwo.example");
    await finish((await claim(s.campaign)).message_id!);
    expect((await claim(s.campaign)).message_id).toBe(a.message);
    await db.admin("update public.email_messages set claim_expires_at = now() - interval '1 minute' where id = $1", [a.message]);
    expect((await claim(s.campaign)).message_id).toBe(b.message);   // the stale claim becomes failed/unknown first
    expect(await statusOf(a.message)).toBe("failed");
  });

  test("a retry on another person's message does not erase the day's mark of the company", async () => {
    const s = await seedCampaign(db, ws, "cog");
    await set(s.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    const a = await addProspect(s.campaign, "Golf", "a@golf.example");
    const b = await addProspect(s.campaign, "Golf", "b@golf.example");
    await finish((await claim(s.campaign)).message_id!);
    expect((await claim(s.campaign)).message_id).toBe(a.message);
    await finishAs(a.message, "dry_run");
    const a2 = await addStep(s.campaign, a.prospect, 2);
    expect((await claim(s.campaign)).message_id).toBe(a2);          // the same person may go on
    await finishAs(a2, "failed");
    await retry(a2);
    expect(await drain(s.campaign, 2)).toEqual([a2, "nothing_due"]); // B of Golf still waits for tomorrow
    expect(await statusOf(b.message)).toBe("approved");
  });

  test("rehearsal and real sends of one company do not block each other", async () => {
    const dry = await seedCampaign(db, ws, "cohd", { n: 1 });
    const real = await seedCampaign(db, ws, "cohr", { n: 1 });
    for (const x of [dry, real]) await set(x.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    await db.query(as(UUID_A), "select public.set_mailbox_verified($1, true, null)", [real.mailbox]);
    await set(real.campaign, "send_mode = 'real'");
    const h1 = await addProspect(dry.campaign, "Hotel", "a@hotel.example");
    const h2 = await addProspect(real.campaign, "Hotel", "b@hotel.example");
    await finish((await claim(dry.campaign)).message_id!);          // seeded prospect of the rehearsal campaign
    expect((await claim(dry.campaign)).message_id).toBe(h1.message);
    const r = await claim(real.campaign);                           // real: seeded prospect first
    expect(r.outcome).toBe("claimed");
    await finishAs(r.message_id!, "sent");
    const r2 = await claim(real.campaign);
    expect(r2.message_id).toBe(h2.message);                         // not blocked by the rehearsal of Hotel
    await finishAs(h2.message, "sent");
    const i1 = await addProspect(real.campaign, "India", "a@india.example");
    const i2 = await addProspect(dry.campaign, "India", "b@india.example");
    expect((await claim(real.campaign)).message_id).toBe(i1.message);
    await finishAs(i1.message, "sent");
    expect((await claim(dry.campaign)).message_id).toBe(i2.message); // not blocked by the real send to India
  });
});

describe("fix wave 4: a held-back reply keeps the held-back outcome", () => {
  test("window closed, reply due but not acceptable: outside_window, not nothing_due", async () => {
    const s = await seedCampaign(db, ws, "held1", { n: 1 });
    await set(s.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    const first = (await claim(s.campaign)).message_id!;
    await finish(first);
    await answerReply(s, first);
    await db.admin("update public.email_prospects set status = 'stopped' where id = $1", [s.prospects[0]]);   // the reply branch does not accept it
    await set(s.campaign, `send_days = ${NOT_TODAY}`);
    const r = await claim(s.campaign);
    expect(r.outcome).toBe("outside_window");
    expect(r.wait_until).toBeTruthy();
  });

  test("campaign limit reached, reply due but not acceptable: campaign_limit, not nothing_due", async () => {
    const s = await seedCampaign(db, ws, "held2", { n: 2 });
    await set(s.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    const first = (await claim(s.campaign)).message_id!;
    await finish(first);
    await answerReply(s, first);
    await db.admin("update public.email_prospects set status = 'stopped' where id = $1", [s.prospects[0]]);
    await set(s.campaign, "daily_limit = 1");
    const r = await claim(s.campaign);
    expect(r.outcome).toBe("campaign_limit");
    expect(r.wait_until).toBeTruthy();
  });
});

describe("fix wave 5: the hard cap of 50 per sending address stays rolling", () => {
  test("two campaigns in distant zones on one mailbox cannot exceed 50 in 24 h", async () => {
    const k = await seedCampaign(db, ws, "rolk", { n: 2 });
    const p = await seedCampaign(db, ws, "rolp", { n: 2 });
    await set(k.campaign, "timezone = 'Pacific/Kiritimati', min_gap_minutes = 0, random_gap_minutes = 0");
    await set(p.campaign, `mailbox_id = '${k.mailbox}', timezone = 'Pacific/Pago_Pago', min_gap_minutes = 0, random_gap_minutes = 0`);
    await mailboxLimit(k.mailbox, 50);
    await db.admin(`insert into public.email_send_log (workspace_id, mailbox_address, mode, to_address, claimed_at, result, finished_at)
      select $1, $2, 'dry_run', 'old' || g || '@x.example',
             least(public.local_day_start('Pacific/Kiritimati', now()), public.local_day_start('Pacific/Pago_Pago', now())) - interval '30 seconds', 'dry_run', now()
        from generate_series(1, 48) g`, [ws, k.address]);
    await db.admin("insert into public.email_send_log (workspace_id, mailbox_address, mode, to_address, claimed_at, result, finished_at) values ($1,$2,'dry_run','recent@x.example', now() - interval '1 second', 'dry_run', now())", [ws, k.address]);
    expect((await claim(k.campaign)).outcome).toBe("claimed");     // the 50th in 24 h
    const r = await claim(p.campaign);
    expect(r.outcome).toBe("daily_limit");
    const [x] = await db.admin<{ cal: number; exp: Date }>(`select
      public.address_claims_since($1, 'dry_run', public.local_day_start('Pacific/Pago_Pago', now())) as cal,
      (select min(claimed_at) + interval '24 hours' from public.email_send_log where mailbox_address = $1) as exp`, [k.address]);
    expect(x.cal).toBeLessThan(50);                                  // the calendar-day count alone would have let it through
    expect(iso(r.wait_until)).toBe(iso(x.exp));                      // the oldest of the 50 leaves the 24 h window
  });
});

describe("fix wave 6: hygiene of the 0006 helpers and constraints", () => {
  const HELPERS: Record<string, string> = {
    is_iana_timezone: "public.is_iana_timezone('UTC')",
    local_day_start: "public.local_day_start('UTC', now())",
    local_day_end: "public.local_day_end('UTC', now())",
    in_send_window: "public.in_send_window('UTC','09:00','18:00','{1}'::smallint[], now())",
    company_key: "public.company_key(null, 'a@b.example', 'x')",
    campaign_claims_since: "public.campaign_claims_since('00000000-0000-4000-8000-000000000000', 'dry_run', now())",
    next_window_open: "public.next_window_open('UTC','09:00','18:00','{1}'::smallint[], now())",
  };
  test("EXECUTE on each 0006 helper is denied to anon and authenticated (except is_iana_timezone for authenticated)", async () => {
    for (const [name, call] of Object.entries(HELPERS)) {
      expect((await db.try(anonActor, `select ${call}`)).error?.message, `anon ${name}`).toMatch(/permission denied for function/);
      const r = await db.try(as(UUID_A), `select ${call}`);
      if (name === "is_iana_timezone") expect(r.error, "authenticated is_iana_timezone").toBeUndefined();
      else expect(r.error?.message, `authenticated ${name}`).toMatch(/permission denied for function/);
    }
  });

  test("next_gap_seconds = 10801 is rejected by both constraints", async () => {
    const s = await seedCampaign(db, ws, "gapc");
    await expect(db.admin("update public.email_messages set next_gap_seconds = 10801 where id = $1", [s.messages[0]])).rejects.toThrow(/email_messages_gap/);
    await expect(db.admin("insert into public.email_send_log (workspace_id, mailbox_address, mode, to_address, gap_seconds) values ($1,'a@b.example','dry_run','c@d.example',10801)", [ws])).rejects.toThrow(/email_send_log_gap/);
    await db.admin("update public.email_messages set next_gap_seconds = 10800 where id = $1", [s.messages[0]]);
  });
});
