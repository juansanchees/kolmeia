import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, anon, anonWithToken, as, ageEmailClaims, setSchedulerToken, UUID_A, UUID_B, UUID_C } from "./helpers";
import { addCampaignMailbox, CIPHER, createOwner, seedCampaign, TOKEN, type Seeded } from "./scheduler-seed";
import { approveAllC12 } from "./c12-seed";

// Migration 0007 (E3 "Rodízio de caixas"): several mailboxes per campaign, one fixed mailbox per person.
let db: TestDb;
let ws: string;
let wsB: string;
beforeAll(async () => {
  db = await TestDb.create();
  ws = await createOwner(db);
  wsB = await createOwner(db, UUID_B);
  await approveAllC12(db, ws); // 0018 C12: these tests cover older rules; the gate has its own file (c12-gate.test.ts)
  await approveAllC12(db, wsB, UUID_B);
  await db.addUser(UUID_C);
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'closer')", [ws, UUID_C]);
});
afterAll(async () => { await db.pg.close(); });
const iso = (d: unknown) => new Date(d as string).toISOString();
type Claim = { outcome: string; message_id?: string; wait_until?: string };
const HOLDER = "33333333-3333-4333-8333-333333333333";
const claim = async (camp: string) => (await db.query<{ r: Claim }>(as(UUID_A), "select public.claim_next_email($1,$2) as r", [camp, HOLDER]))[0].r;
const finish = (msg: string, result = "dry_run") => db.query(as(UUID_A), "select public.finish_email_send($1,$2,$3,null)", [msg, HOLDER, result]);
const set = (camp: string, sql: string) => db.admin(`update public.email_campaigns set ${sql} where id = $1`, [camp]);
const noGap = (camp: string) => set(camp, "min_gap_minutes = 0, random_gap_minutes = 0");
const listOf = async (camp: string) => (await db.admin<{ mailbox_id: string }>("select mailbox_id from public.campaign_mailboxes where campaign_id = $1 order by seq", [camp])).map((r) => r.mailbox_id);
const firstOf = async (camp: string) => (await db.admin<{ mailbox_id: string | null }>("select mailbox_id from public.email_campaigns where id = $1", [camp]))[0].mailbox_id;
const stickyOf = async (p: string) => (await db.admin<{ mailbox_id: string | null }>("select mailbox_id from public.email_prospects where id = $1", [p]))[0].mailbox_id;
const fromOf = async (msg: string) => (await db.admin<{ from_address: string }>("select from_address from public.email_messages where id = $1", [msg]))[0].from_address;
const prospectOf = async (msg: string) => (await db.admin<{ prospect_id: string }>("select prospect_id from public.email_messages where id = $1", [msg]))[0].prospect_id;
const statusOf = async (id: string) => (await db.admin<{ status: string }>("select status from public.email_messages where id = $1", [id]))[0].status;
/** Claims and finishes one e-mail; `from` is the address it left from. */
async function send(camp: string): Promise<{ outcome: string; id?: string; from?: string }> {
  const c = await claim(camp);
  if (!c.message_id) return { outcome: c.outcome };
  await finish(c.message_id);
  return { outcome: c.outcome, id: c.message_id, from: await fromOf(c.message_id) };
}

describe("0007 campaign_mailboxes and the sticky column", () => {
  test("RLS forced; senders read; senders attach and detach; a closer cannot; another workspace's mailbox is refused (g)", async () => {
    const s = await seedCampaign(db, ws, "t1");
    expect((await db.admin("select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.campaign_mailboxes'::regclass"))[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(await listOf(s.campaign)).toEqual([s.mailbox]);
    expect(await db.query(as(UUID_C), "select mailbox_id from public.campaign_mailboxes where campaign_id = $1", [s.campaign])).toHaveLength(0);
    expect(await db.query(as(UUID_B), "select mailbox_id from public.campaign_mailboxes where campaign_id = $1", [s.campaign])).toHaveLength(0);
    const b = await addCampaignMailbox(db, ws, s.campaign, "t1b");
    expect(await listOf(s.campaign)).toEqual([s.mailbox, b.mailbox]);
    const other = await seedCampaign(db, wsB, "t1x", { userId: UUID_B });
    const c = (await db.query<{ id: string }>(as(UUID_A), "select public.save_mailbox($1,'sales-t1c@neair.example',$2) as id", [ws, CIPHER]))[0].id;
    const ins = "insert into public.campaign_mailboxes (campaign_id, mailbox_id) values ($1,$2)";
    expect((await db.try(as(UUID_A), ins, [s.campaign, other.mailbox])).error?.message).toMatch(/not in this workspace|row-level security/);
    expect((await db.try(as(UUID_B), ins, [s.campaign, other.mailbox])).error?.message).toMatch(/not allowed|row-level security/);
    expect((await db.try(as(UUID_C), ins, [s.campaign, c])).error?.message).toMatch(/not allowed|row-level security/);
    expect((await db.try(as(UUID_A), "insert into public.campaign_mailboxes (campaign_id, mailbox_id, workspace_id) values ($1,$2,$3)", [s.campaign, c, ws])).error?.message).toMatch(/permission denied/);
    expect((await db.try(as(UUID_A), "update public.campaign_mailboxes set mailbox_id = $2 where campaign_id = $1", [s.campaign, c])).error?.message).toMatch(/permission denied/);
    expect(await db.query(as(UUID_C), "delete from public.campaign_mailboxes where campaign_id = $1 returning mailbox_id", [s.campaign])).toHaveLength(0);
    expect(await db.query(as(UUID_A), "delete from public.campaign_mailboxes where campaign_id = $1 and mailbox_id = $2 returning mailbox_id", [s.campaign, b.mailbox])).toHaveLength(1);
    expect((await db.try(anon, "select 1 from public.campaign_mailboxes")).error?.message).toMatch(/permission denied/);
  });

  test("at most 10 mailboxes per campaign", async () => {
    const s = await seedCampaign(db, ws, "t2");
    for (let i = 1; i < 10; i++) await addCampaignMailbox(db, ws, s.campaign, `t2m${i}`);
    expect(await listOf(s.campaign)).toHaveLength(10);
    await expect(addCampaignMailbox(db, ws, s.campaign, "t2m10")).rejects.toThrow(/at most 10 mailboxes/);
    await db.query(as(UUID_A), "delete from public.campaign_mailboxes where campaign_id = $1 and mailbox_id = $2", [s.campaign, (await listOf(s.campaign))[9]]);
    await addCampaignMailbox(db, ws, s.campaign, "t2m11");
  });

  test("the compatibility column email_campaigns.mailbox_id follows the list, and a write to it changes the list", async () => {
    const s = await seedCampaign(db, ws, "t3");
    const b = await addCampaignMailbox(db, ws, s.campaign, "t3b");
    const c = await addCampaignMailbox(db, ws, s.campaign, "t3c");
    expect(await firstOf(s.campaign)).toBe(s.mailbox);                        // adding never moves the first
    await db.query(as(UUID_A), "delete from public.campaign_mailboxes where campaign_id = $1 and mailbox_id = $2", [s.campaign, s.mailbox]);
    expect(await firstOf(s.campaign)).toBe(b.mailbox);                        // the earliest remaining
    await db.query(as(UUID_A), "update public.email_campaigns set mailbox_id = $2 where id = $1", [s.campaign, s.mailbox]);
    expect([await listOf(s.campaign), await firstOf(s.campaign)]).toEqual([[c.mailbox, s.mailbox], s.mailbox]);   // old first out, new in
    await db.query(as(UUID_A), "delete from public.mailboxes where id = $1", [s.mailbox]);
    expect([await listOf(s.campaign), await firstOf(s.campaign)]).toEqual([[c.mailbox], c.mailbox]);
    await db.query(as(UUID_A), "delete from public.campaign_mailboxes where campaign_id = $1", [s.campaign]);
    expect(await firstOf(s.campaign)).toBeNull();
  });

  test("email_prospects.mailbox_id: readable by senders, not writable by clients, set null when the mailbox is deleted", async () => {
    const s = await seedCampaign(db, ws, "t4");
    expect(await db.query(as(UUID_A), "select mailbox_id from public.email_prospects where id = $1", [s.prospects[0]])).toEqual([{ mailbox_id: null }]);
    expect((await db.try(as(UUID_A), "update public.email_prospects set mailbox_id = $2 where id = $1", [s.prospects[0], s.mailbox])).error?.message).toMatch(/permission denied/);
    await db.admin("update public.email_prospects set mailbox_id = $2 where id = $1", [s.prospects[0], s.mailbox]);
    await db.query(as(UUID_A), "delete from public.mailboxes where id = $1", [s.mailbox]);
    expect(await stickyOf(s.prospects[0])).toBeNull();
  });

  test("backfill_prospect_mailboxes: the mailbox of the latest claim (message, else send-log address); unclaimed stays null", async () => {
    const s = await seedCampaign(db, ws, "t5", { n: 2 });
    const c = await claim(s.campaign);
    await finish(c.message_id!);
    await db.admin("update public.email_prospects set mailbox_id = null where campaign_id = $1", [s.campaign]);
    await db.admin("select public.backfill_prospect_mailboxes()");
    const sent = await prospectOf(c.message_id!);
    expect([await stickyOf(sent), await stickyOf(s.prospects.find((p) => p !== sent)!)]).toEqual([s.mailbox, null]);
    await db.admin("update public.email_prospects set mailbox_id = null where id = $1", [sent]);
    await db.admin("update public.email_messages set mailbox_id = null where id = $1", [c.message_id]);
    await db.admin("select public.backfill_prospect_mailboxes()");
    expect(await stickyOf(sent)).toBe(s.mailbox);
  });

  test("compatibility path: a campaign created with mailbox_id gets exactly one list row", async () => {
    const s = await seedCampaign(db, ws, "t6");
    expect(await listOf(s.campaign)).toEqual([s.mailbox]);
    expect(await db.admin("select 1 from public.campaign_mailboxes where campaign_id = $1", [s.campaign])).toHaveLength(1);
  });

  test("compatibility path: the cap of 10 also holds when the 11th arrives through email_campaigns.mailbox_id", async () => {
    const s = await seedCampaign(db, ws, "t7");
    for (let i = 1; i < 10; i++) await addCampaignMailbox(db, ws, s.campaign, `t7m${i}`);
    const extra = (await db.query<{ id: string }>(as(UUID_A), "select public.save_mailbox($1,'sales-t7x@neair.example',$2) as id", [ws, CIPHER]))[0].id;
    const r = await db.try(as(UUID_A), "update public.email_campaigns set mailbox_id = $2 where id = $1", [s.campaign, extra]);
    expect(r.error?.message).toMatch(/at most 10 mailboxes/);
    expect(await listOf(s.campaign)).toHaveLength(10);
  });

  test("EXECUTE on the 0007 helpers is denied to anon and authenticated", async () => {
    for (const fn of ["guard_campaign_mailbox()", "sync_campaign_mailboxes()", "backfill_prospect_mailboxes()"]) {
      const [g] = await db.admin(`select has_function_privilege('anon', 'public.${fn}', 'execute') as a, has_function_privilege('authenticated', 'public.${fn}', 'execute') as u`);
      expect(g, fn).toEqual({ a: false, u: false });
    }
  });
});

async function addStep(s: Seeded, prospect: string, step: 2 | 3): Promise<string> {
  const id = (await db.query<{ id: string }>(as(UUID_A), "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body) values ($1,$2,$3,'sequence',$4,'Following up','Short follow-up.') returning id", [ws, s.campaign, prospect, step]))[0].id;
  await db.query(as(UUID_A), "select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')", [id]);
  await db.admin("update public.email_messages set due_at = now() - interval '1 minute' where id = $1", [id]);
  return id;
}
const gapEnd = async (address: string) => iso((await db.admin<{ w: Date }>("select max(claimed_at) + interval '540 seconds' as w from public.email_send_log where mailbox_address = $1", [address]))[0].w);

describe("E3 rodízio", () => {
  test("the claim reads the campaign's mailbox list once, under the row locks", async () => {
    const def = (await db.admin<{ d: string }>("select pg_get_functiondef('public.claim_next_email_core(uuid,uuid,uuid,uuid,text)'::regprocedure) as d"))[0].d;
    expect(def.match(/campaign_mailboxes/g)?.length).toBe(1);
    expect(def).toMatch(/campaign_mailboxes[\s\S]*for update of mb/);
  });
  test("(b) new prospects alternate by least sent today; ties go to the mailbox whose last claim is oldest", async () => {
    const s = await seedCampaign(db, ws, "r2b", { n: 4 });
    const b = await addCampaignMailbox(db, ws, s.campaign, "r2bb");
    await noGap(s.campaign);
    const got: (string | undefined)[] = [];
    for (let i = 0; i < 4; i++) got.push((await send(s.campaign)).from);
    expect(new Set(got)).toEqual(new Set([s.address, b.address]));
    expect([got[1] !== got[0], got[2], got[3]]).toEqual([true, got[0], got[1]]);
  });

  test("(a) step 2 leaves through the mailbox of step 1 even when another mailbox is freer", async () => {
    const s = await seedCampaign(db, ws, "r2a", { n: 3 });
    const b = await addCampaignMailbox(db, ws, s.campaign, "r2ab");
    await noGap(s.campaign);
    const first = await send(s.campaign);
    await send(s.campaign);
    expect((await send(s.campaign)).from).toBe(first.from);                   // first's mailbox: 2 today, the other: 1
    const p = await prospectOf(first.id!);
    const mine = first.from === s.address ? s.mailbox : b.mailbox;
    expect(await stickyOf(p)).toBe(mine);
    const step2 = await addStep(s, p, 2);
    expect(await send(s.campaign)).toMatchObject({ id: step2, from: first.from });
    expect(await stickyOf(p)).toBe(mine);
  });

  test("(c) a mailbox in its gap or at its limit is skipped; when all are blocked the earliest wait wins", async () => {
    const s = await seedCampaign(db, ws, "r2c", { n: 3 });
    await set(s.campaign, "min_gap_minutes = 9, random_gap_minutes = 0");
    expect((await send(s.campaign)).from).toBe(s.address);                    // only A attached
    const b = await addCampaignMailbox(db, ws, s.campaign, "r2cb");
    expect((await send(s.campaign)).from).toBe(b.address);                    // A in its gap
    const both = await claim(s.campaign);
    expect(both.outcome).toBe("gap");
    expect(iso(both.wait_until)).toBe(await gapEnd(s.address));               // A frees first
    await ageEmailClaims(db, 600);
    await db.query(as(UUID_A), "update public.mailboxes set daily_limit = 1 where id = $1", [s.mailbox]);
    expect((await send(s.campaign)).from).toBe(b.address);                    // A at its limit; B (1 today) is used
    const g = await claim(s.campaign);
    expect([g.outcome, iso(g.wait_until)]).toEqual(["gap", await gapEnd(b.address)]);   // B's gap beats A's next day
  });

  test("(f) the campaign limit counts the claims of all its mailboxes", async () => {
    const s = await seedCampaign(db, ws, "r2f", { n: 3 });
    const b = await addCampaignMailbox(db, ws, s.campaign, "r2fb");
    await set(s.campaign, "daily_limit = 2, min_gap_minutes = 0, random_gap_minutes = 0");
    expect(new Set([(await send(s.campaign)).from, (await send(s.campaign)).from])).toEqual(new Set([s.address, b.address]));
    expect((await claim(s.campaign)).outcome).toBe("campaign_limit");
  });

  test("two campaigns sharing a mailbox: the address count is shared, so the other campaign's new prospect goes to its other mailbox", async () => {
    const x = await seedCampaign(db, ws, "r2x", { n: 2 });
    const y = await seedCampaign(db, ws, "r2y", { n: 2 });
    await db.query(as(UUID_A), "insert into public.campaign_mailboxes (campaign_id, mailbox_id) values ($1,$2)", [y.campaign, x.mailbox]);
    for (const c of [x, y]) await noGap(c.campaign);
    await send(x.campaign);
    await send(x.campaign);
    expect((await send(y.campaign)).from).toBe(y.address);                    // x's address has 2 today
    await db.query(as(UUID_A), "update public.mailboxes set daily_limit = 2 where id = $1", [x.mailbox]);
    await db.query(as(UUID_A), "delete from public.campaign_mailboxes where campaign_id = $1 and mailbox_id = $2", [y.campaign, y.mailbox]);
    expect((await claim(y.campaign)).outcome).toBe("daily_limit");            // the shared address is full for y too
  });

  test("(e) one mailbox: every claim goes through it, the prospect is stamped with it, blocked outcomes are unchanged", async () => {
    const s = await seedCampaign(db, ws, "r2e", { n: 2 });
    await set(s.campaign, "min_gap_minutes = 9, random_gap_minutes = 0");
    const c1 = await send(s.campaign);
    expect(c1.from).toBe(s.address);
    expect(await stickyOf(await prospectOf(c1.id!))).toBe(s.mailbox);
    const g = await claim(s.campaign);
    expect([g.outcome, iso(g.wait_until)]).toEqual(["gap", await gapEnd(s.address)]);
    expect([await listOf(s.campaign), await firstOf(s.campaign)]).toEqual([[s.mailbox], s.mailbox]);
  });
});

/** The prospect of `sent` replies (received on `mailbox`); a person writes and approves an answer. Returns its id. */
async function answerReply(s: Seeded, sent: string, mailbox: string): Promise<string> {
  const p = (await db.admin<{ id: string; email: string }>("select p.id, p.email from public.email_messages m join public.email_prospects p on p.id = m.prospect_id where m.id = $1", [sent]))[0];
  const reply = (await db.query<{ r: string }>(as(UUID_A), "select public.record_email_reply($1,$2,$3,$4,'Re: Quick question','Sounds good',$5,now(),'reply',null) as r", [p.id, mailbox, sent, p.email, `<r-${sent}@x.example>`]))[0].r;
  const a = (await db.query<{ id: string }>(as(UUID_A), "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, reply_to_id, subject, body) values ($1,$2,$3,'reply',$4,'Re: Quick question','Hi, sure.') returning id", [ws, s.campaign, p.id, reply]))[0].id;
  await db.query(as(UUID_A), "select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')", [a]);
  return a;
}

describe("E3 a person never changes mailbox", () => {
  test("(d) removed from the campaign: the stuck follow-up waits, new prospects use the others, re-adding resumes it", async () => {
    const s = await seedCampaign(db, ws, "r3d", { n: 2 });
    const b = await addCampaignMailbox(db, ws, s.campaign, "r3db");
    await noGap(s.campaign);
    const first = await send(s.campaign);
    const p = await prospectOf(first.id!);
    const stuck = first.from === s.address ? s.mailbox : b.mailbox;
    await db.query(as(UUID_A), "delete from public.campaign_mailboxes where campaign_id = $1 and mailbox_id = $2", [s.campaign, stuck]);
    const step2 = await addStep(s, p, 2);
    expect((await send(s.campaign)).from).not.toBe(first.from);              // the new prospect, through the other one
    expect((await claim(s.campaign)).outcome).toBe("nothing_due");            // step 2 is not moved
    expect(await statusOf(step2)).toBe("approved");
    await db.query(as(UUID_A), "insert into public.campaign_mailboxes (campaign_id, mailbox_id) values ($1,$2)", [s.campaign, stuck]);
    expect(await send(s.campaign)).toMatchObject({ id: step2, from: first.from });
  });

  test("a deleted mailbox: its people wait (follow-ups and answers), new people go to the others", async () => {
    const s = await seedCampaign(db, ws, "r3x", { n: 2 });
    const b = await addCampaignMailbox(db, ws, s.campaign, "r3xb");
    await noGap(s.campaign);
    const first = await send(s.campaign);
    const p = await prospectOf(first.id!);
    const [gone, keep] = first.from === s.address ? [s.mailbox, b] : [b.mailbox, { mailbox: s.mailbox, address: s.address }];
    const step2 = await addStep(s, p, 2);
    await db.query(as(UUID_A), "delete from public.mailboxes where id = $1", [gone]);
    expect(await stickyOf(p)).toBeNull();
    expect((await send(s.campaign)).from).toBe(keep.address);
    expect((await claim(s.campaign)).outcome).toBe("nothing_due");
    expect(await statusOf(step2)).toBe("approved");
    const answer = await answerReply(s, first.id!, keep.mailbox);
    expect((await claim(s.campaign)).outcome).toBe("nothing_due");
    expect(await statusOf(answer)).toBe("approved");
  });

  test("only stuck messages are due and their mailbox is in its gap: the answer is that gap, not nothing_due", async () => {
    const s = await seedCampaign(db, ws, "r3g", { n: 1 });
    await addCampaignMailbox(db, ws, s.campaign, "r3gb");
    await set(s.campaign, "min_gap_minutes = 9, random_gap_minutes = 0");
    const first = await send(s.campaign);
    const step2 = await addStep(s, await prospectOf(first.id!), 2);
    const r = await claim(s.campaign);
    expect([r.outcome, iso(r.wait_until)]).toEqual(["gap", await gapEnd(first.from!)]);
    expect(await statusOf(step2)).toBe("approved");
  });
});

describe("E3 real mode and the clock", () => {
  test("real mode with one verified and one unverified mailbox: the switch is allowed, only the verified one sends, rehearsal stickers are cleared", async () => {
    const s = await seedCampaign(db, ws, "r4r", { n: 2 });                    // A (first) stays unverified
    const b = await addCampaignMailbox(db, ws, s.campaign, "r4rb");
    await noGap(s.campaign);
    const reh = await send(s.campaign);
    expect((await db.try(as(UUID_A), "select public.set_campaign_send_mode($1,'real')", [s.campaign])).error?.message).toMatch(/verified mailbox/);
    await db.query(as(UUID_A), "select public.set_mailbox_verified($1, true, null)", [b.mailbox]);
    await db.query(as(UUID_A), "select public.set_campaign_send_mode($1,'real')", [s.campaign]);
    expect(await stickyOf(await prospectOf(reh.id!))).toBeNull();
    for (let i = 0; i < 2; i++) {
      const c = await claim(s.campaign);
      expect(await fromOf(c.message_id!)).toBe(b.address);
      await finish(c.message_id!, "sent");
    }
    await db.query(as(UUID_A), "select public.set_mailbox_verified($1, false, 'x')", [b.mailbox]);
    expect((await claim(s.campaign)).outcome).toBe("mailbox_not_verified");
  });

  test("real mode: a person whose sticky mailbox is not ok waits (not claimed, not moved); a new person goes through the other verified mailbox", async () => {
    const s = await seedCampaign(db, ws, "r4w", { n: 2 });
    const b = await addCampaignMailbox(db, ws, s.campaign, "r4wb");
    await noGap(s.campaign);
    for (const m of [s.mailbox, b.mailbox]) await db.query(as(UUID_A), "select public.set_mailbox_verified($1, true, null)", [m]);
    await db.query(as(UUID_A), "select public.set_campaign_send_mode($1,'real')", [s.campaign]);
    const c1 = await claim(s.campaign);
    await finish(c1.message_id!, "sent");
    const p = await prospectOf(c1.message_id!);
    const from1 = await fromOf(c1.message_id!);
    const [stuck, other] = from1 === s.address ? [s.mailbox, b] : [b.mailbox, { mailbox: s.mailbox, address: s.address }];
    expect(await stickyOf(p)).toBe(stuck);
    const step2 = await addStep(s, p, 2);
    await db.query(as(UUID_A), "select public.set_mailbox_verified($1, false, 'x')", [stuck]);
    const c2 = await claim(s.campaign);                                       // the new person, through the verified mailbox
    expect(await fromOf(c2.message_id!)).toBe(other.address);
    await finish(c2.message_id!, "sent");
    expect((await claim(s.campaign)).outcome).toBe("nothing_due");            // step 2 waits
    expect(await statusOf(step2)).toBe("approved");
    expect(await stickyOf(p)).toBe(stuck);
  });

  test("going real again never clears the mailbox of a person who already has a real send", async () => {
    const s = await seedCampaign(db, ws, "r4k", { n: 2 });
    const b = await addCampaignMailbox(db, ws, s.campaign, "r4kb");
    await noGap(s.campaign);
    for (const m of [s.mailbox, b.mailbox]) await db.query(as(UUID_A), "select public.set_mailbox_verified($1, true, null)", [m]);
    await db.query(as(UUID_A), "select public.set_campaign_send_mode($1,'real')", [s.campaign]);
    const c = await claim(s.campaign);
    await finish(c.message_id!, "sent");
    const p = await prospectOf(c.message_id!);
    const stuck = await stickyOf(p);
    expect([s.mailbox, b.mailbox]).toContain(stuck);
    await db.query(as(UUID_A), "select public.set_campaign_send_mode($1,'dry_run')", [s.campaign]);
    await db.query(as(UUID_A), "select public.set_campaign_send_mode($1,'real')", [s.campaign]);
    expect(await stickyOf(p)).toBe(stuck);
  });

  test("the clock lists a campaign by its mailbox list and hands the claimed message's mailbox to the engine", async () => {
    await db.admin("update public.email_campaigns set status = 'paused' where status = 'active'");   // earlier campaigns out of the 20-slot list
    const s = await seedCampaign(db, ws, "r4c");
    const b = await addCampaignMailbox(db, ws, s.campaign, "r4cb");
    const empty = await seedCampaign(db, ws, "r4e");
    await db.query(as(UUID_A), "delete from public.campaign_mailboxes where campaign_id = $1", [empty.campaign]);
    await setSchedulerToken(db, TOKEN);
    const clock = anonWithToken(TOKEN);
    const run = (await db.query<{ r: { run_id: string } }>(clock, "select public.scheduler_begin_run() as r"))[0].r.run_id;
    const due = (await db.query<{ r: { campaign_ids: string[] } }>(clock, "select public.scheduler_due_work($1) as r", [run]))[0].r.campaign_ids;
    expect([due.includes(s.campaign), due.includes(empty.campaign)]).toEqual([true, false]);
    const c = (await db.query<{ r: Claim }>(clock, "select public.scheduler_claim_next_email($1,$2) as r", [run, s.campaign]))[0].r;
    const m = (await db.query<{ r: { mailbox_id: string } }>(clock, "select public.scheduler_message($1,$2) as r", [run, c.message_id]))[0].r;
    expect([s.mailbox, b.mailbox]).toContain(m.mailbox_id);
    await db.query(clock, "select public.scheduler_finish_email_send($1,$2,'dry_run',null)", [run, c.message_id]);
    await db.query(clock, "select public.scheduler_finish_run($1,'{}'::jsonb,null)", [run]);
  });
});
