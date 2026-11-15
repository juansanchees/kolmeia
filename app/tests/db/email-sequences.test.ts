import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TEMPLATE_VECTORS } from "../fixtures/template-vectors";
import { TestDb, anonWithToken, as, openGates, setSchedulerToken, tryCommit, UUID_A, UUID_B, UUID_C } from "./helpers";
import { CIPHER, TOKEN, createOwner } from "./scheduler-seed";
import { randomUUID as gen } from "node:crypto";

// Migration 0023 part 1 (F4 Task 4): versioned e-mail sequences, ONE SQL renderer (pinned to the TS preview by
// tests/fixtures/template-vectors.ts) and the 3-example preview. Fictional data only.
const SDR = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
let db: TestDb;
let ws: string;
beforeAll(async () => {
  db = await TestDb.create();
  ws = await createOwner(db);
  await createOwner(db, UUID_B); // another workspace
  await db.addUser(UUID_C);
  await db.addUser(SDR);
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'closer'), ($1,$3,'sdr')", [ws, UUID_C, SDR]);
});
afterAll(async () => { await db.pg.close(); });

type Step = { step: number; subject: string; body: string };
type Preview = { digest: string; examples: { prospect_id: string; company: string; to: string; steps: Step[] }[] };
const code = (e: unknown) => (e as { code?: string } | undefined)?.code;

const STEPS: Step[] = [
  { step: 1, subject: "Quick question, {{first_name}}", body: "Hi {{first_name}}, who handles HVAC for {{company}} in {{city}}?" },
  { step: 2, subject: "Following up", body: "Hi {{first_name}}, any HVAC work coming up?" },
];

async function newLead(company: string, email: string, contact: string | null, city: string | null): Promise<string> {
  const id = (await db.admin<{ id: string }>("insert into public.leads (workspace_id, origin_kind) values ($1,'import') returning id", [ws]))[0].id;
  const fields: [string, string | null][] = [["name", company], ["email", email], ["contact_name", contact], ["city", city]];
  for (const [field, value] of fields) {
    if (value !== null) await db.admin("insert into public.lead_fields (workspace_id, lead_id, field, value, source) values ($1,$2,$3,$4,'import')", [ws, id, field, value]);
  }
  return id;
}
async function newCampaign(label: string): Promise<string> {
  const mb = (await db.query<{ id: string }>(as(UUID_A), "select public.save_mailbox($1,$2,$3) as id", [ws, `sales-${label}@neair.example`, CIPHER]))[0].id;
  const id = (await db.query<{ id: string }>(as(UUID_A), "insert into public.email_campaigns (workspace_id, name, mailbox_id) values ($1,$2,$3) returning id", [ws, label, mb]))[0].id;
  await openGates(db, id);
  return id;
}
const save = (camp: string, steps: unknown, user = UUID_A, delays: [number | null, number | null] = [3, 7]) =>
  db.try<{ id: string }>(as(user), "select public.save_sequence_draft($1,$2::jsonb,'direct',$3,$4,'claude-sonnet','seq-v1',false) as id", [camp, JSON.stringify(steps), delays[0], delays[1]]);
async function saved(camp: string, steps: unknown = STEPS, delays: [number | null, number | null] = [3, 7]): Promise<string> {
  const r = await db.query<{ id: string }>(as(UUID_A), "select public.save_sequence_draft($1,$2::jsonb,'direct',$3,$4,'claude-sonnet','seq-v1',false) as id", [camp, JSON.stringify(steps), delays[0], delays[1]]);
  return r[0].id;
}
const preview = async (seq: string, user = UUID_A) => (await db.query<{ r: Preview }>(as(user), "select public.preview_sequence($1) as r", [seq]))[0].r;

describe("0023 the one renderer (D2)", () => {
  test.each(TEMPLATE_VECTORS)("the SQL renderer matches every template vector: $text / $contact_name", async (v) => {
    const r = await db.query<{ out: string }>(as(UUID_A),
      "select public.render_email_template($1, jsonb_build_object('contact_name',$2::text,'company',$3::text,'city',$4::text)) as out",
      [v.text, v.contact_name, v.company, v.city]);
    expect(r[0].out).toBe(v.out);
  });

  test("an unknown or broken placeholder is an error (22023)", async () => {
    for (const text of ["Hi {{name}}", "Hi {{ company }}", "Hi {{company}", "Hi company}}", "{{{city}}{", "{{First_name}}"]) {
      const r = await db.try(as(UUID_A), "select public.render_email_template($1, '{}'::jsonb)", [text]);
      expect(code(r.error), text).toBe("22023");
    }
    // a value is never checked or expanded again: only the template text is
    const ok = await db.query<{ out: string }>(as(UUID_A), "select public.render_email_template('{{company}}', jsonb_build_object('company','}} {{x}}')) as out");
    expect(ok[0].out).toBe("}} {{x}}");
  });
});

describe("0023 versioned sequences", () => {
  test("a step with a link, a fake Re: or an unknown placeholder is refused", async () => {
    const camp = await newCampaign("seq-rules");
    const bad: unknown[] = [
      [{ step: 1, subject: "Hi", body: "See www.acme.example for more" }],
      [{ step: 1, subject: "Hi", body: "See https://acme.example" }],
      [{ step: 1, subject: "Visit HTTP://acme.example", body: "Hi" }],
      [{ step: 1, subject: "Re: our talk", body: "Hi" }],
      [{ step: 1, subject: "[Fwd] our talk", body: "Hi" }],
      [{ step: 1, subject: "Hi {{name}}", body: "Hi" }],
      [{ step: 1, subject: "Hi", body: "Hi {{ first_name }}" }],
      [{ step: 1, subject: "  ", body: "Hi" }],
      [{ step: 1, subject: "Hi", body: " " }],
      [{ step: 1, subject: "Hi", body: "\n\t \u00a0\u3000" }],
      [{ step: 1, subject: "\u00a0", body: "Hi" }],
      [{ step: 1, subject: "x".repeat(151), body: "Hi" }],
      [{ step: 1, subject: "Hi", body: "x".repeat(2001) }],
      [{ step: 1, subject: "Two\nlines", body: "Hi" }],
      [],
      [...STEPS, { step: 3, subject: "c", body: "c" }, { step: 4, subject: "d", body: "d" }],
      [{ step: 2, subject: "Hi", body: "Hi" }],
      { step: 1, subject: "Hi", body: "Hi" },
    ];
    for (const steps of bad) {
      const r = await save(camp, steps);
      expect(code(r.error), JSON.stringify(steps).slice(0, 80)).toBe("22023");
    }
    // tone, delays and model are checked up front (22023), not left to the table constraints
    for (const [tone, d2, d3, model] of [["pushy", 3, 7, null], ["direct", 0, 7, null], ["direct", 3, 61, null], ["direct", 7, 7, null], ["direct", null, 2, null], ["direct", 3, 7, "m".repeat(61)]] as const) {
      const r = await db.try(as(UUID_A), "select public.save_sequence_draft($1,$2::jsonb,$3,$4,$5,$6,null,false)", [camp, JSON.stringify(STEPS), tone, d2, d3, model]);
      expect(code(r.error), `${tone} ${d2} ${d3}`).toBe("22023");
    }
    expect(await db.admin("select 1 from public.email_sequences where campaign_id = $1", [camp])).toHaveLength(0);
    // the limits themselves are fine
    expect((await save(camp, [{ step: 1, subject: "x".repeat(150), body: "y".repeat(2000) }])).error).toBeUndefined();
  });

  test("a new draft supersedes the approved version and cancels unsent messages of the old text", async () => {
    const camp = await newCampaign("seq-supersede");
    await db.query(as(UUID_A), "select public.add_leads_to_campaign($1,$2::uuid[])", [camp, [
      await newLead("Sup One", "pat@sup1.example", "Pat Doe", "Worcester"),
      await newLead("Sup Two", "sam@sup2.example", "Sam Roe", null),
      await newLead("Sup Three", "lee@sup3.example", "Lee Poe", null),
    ]]);
    const [pa, pb, pc] = (await db.admin<{ id: string }>("select id from public.email_prospects where campaign_id = $1 order by email", [camp])).map((r) => r.id);
    const v1 = await saved(camp);
    expect(await db.admin("select version, status, tone, human_edited, ai_model from public.email_sequences where id = $1", [v1]))
      .toEqual([{ version: 1, status: "draft", tone: "direct", human_edited: false, ai_model: "claude-sonnet" }]);
    await db.admin("update public.email_sequences set status = 'approved', approved_by = $2, approved_at = now() where id = $1", [v1, UUID_A]);

    // an approved message (pa), a sent one (pb) and a rejected one (pc), all step 1
    const msg = async (p: string) => (await db.query<{ id: string }>(as(UUID_A),
      "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body, ai_drafted) values ($1,$2,$3,'sequence',1,'Quick question','Hi, who handles HVAC?',true) returning id",
      [ws, camp, p]))[0].id;
    const [ma, mb, mc] = [await msg(pa), await msg(pb), await msg(pc)];
    await db.query(as(UUID_A), "select public.set_email_approval(array[$1,$2]::uuid[], public.test_versions(array[$1,$2]::uuid[]), 'approve')", [ma, mb]);
    await db.query(as(UUID_A), "select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'reject')", [mc]);
    await db.admin("update public.email_messages set status = 'sent', to_address = approved_to, sent_at = now() where id = $1", [mb]);

    const v2 = await saved(camp, [{ step: 1, subject: "New subject", body: "Hi {{first_name}}" }, ...STEPS.slice(1), { step: 3, subject: "Last one", body: "Closing the loop." }], [4, 9]);
    const seqs = await db.admin<{ id: string; version: number; status: string }>("select id, version, status from public.email_sequences where campaign_id = $1 order by version", [camp]);
    expect(seqs).toEqual([{ id: v1, version: 1, status: "superseded" }, { id: v2, version: 2, status: "draft" }]);
    const m = await db.admin<{ id: string; status: string; approved_by: string | null; approved_at: string | null; approved_to: string | null; approved_digest: string | null }>(
      "select id, status, approved_by, approved_at, approved_to, approved_digest from public.email_messages where id = any($1::uuid[])", [[ma, mb, mc]]);
    const by = Object.fromEntries(m.map((r) => [r.id, r]));
    expect(by[ma]).toMatchObject({ status: "cancelled", approved_by: null, approved_at: null, approved_to: null, approved_digest: null });
    expect(by[mb].status).toBe("sent");
    expect(by[mc].status).toBe("cancelled");
    expect(await db.admin("select user_id from public.email_approvals where message_id = $1 and action = 'unapprove'", [ma])).toEqual([{ user_id: UUID_A }]);
    expect(await db.admin("select 1 from public.email_approvals where message_id = $1 and action = 'unapprove'", [mc])).toHaveLength(0);
    // the old text can never be approved again, one by one
    const again = await db.query<{ r: { done: number; skipped: number } }>(as(UUID_A),
      "select public.set_email_approval(array[$1,$2]::uuid[], public.test_versions(array[$1,$2]::uuid[]), 'approve') as r", [ma, mc]);
    expect(again[0].r).toMatchObject({ done: 0, skipped: 2 });
    expect((await db.admin<{ status: string }>("select status from public.email_messages where id = any($1::uuid[])", [[ma, mc]])).map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
    expect(await db.admin("select step2_delay_days, step3_delay_days from public.email_campaigns where id = $1", [camp]))
      .toEqual([{ step2_delay_days: 4, step3_delay_days: 9 }]);

    // a third save supersedes a draft that was never approved too: only the newest version can be approved
    const v3 = await saved(camp, STEPS.slice(0, 1), [null, null]);
    expect(await db.admin("select version, status from public.email_sequences where campaign_id = $1 order by version", [camp]))
      .toEqual([{ version: 1, status: "superseded" }, { version: 2, status: "superseded" }, { version: 3, status: "draft" }]);
    expect(await db.admin("select step2_delay_days, step3_delay_days from public.email_campaigns where id = $1", [camp]))
      .toEqual([{ step2_delay_days: 4, step3_delay_days: 9 }]);
    expect(v3).not.toBe(v2);
  });

  test("the preview shows the same 3 real leads every time and their rendered steps", async () => {
    const camp = await newCampaign("seq-preview");
    const leads = [
      await newLead("Prev One", "pat@prev1.example", "Pat Doe", "Worcester"),
      await newLead("Prev Link", "x@prevlink.example", "Max Poe", "www.prev-evil.example"), // a value that adds a link
      await newLead("Prev Two", "info@prev2.example", "Dr. Sam Roe", null),
      await newLead("Prev Three", "lee@prev3.example", null, "  Boston "),
      await newLead("Prev Four", "kim@prev4.example", "Kim Loe", "Salem"),
    ];
    await db.query(as(UUID_A), "select public.add_leads_to_campaign($1,$2::uuid[])", [camp, leads]);
    // a fixed order (created_at, id), the way leads arrive over time
    for (const [i, lead] of leads.entries()) {
      await db.admin("update public.email_prospects set created_at = now() - make_interval(mins => $2) where lead_id = $1", [lead, 10 - i]);
    }
    const seq = await saved(camp);
    const a = await preview(seq);
    const b = await preview(seq);
    expect(b).toEqual(a);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.examples.map((e) => [e.company, e.to])).toEqual([
      ["Prev One", "pat@prev1.example"], ["Prev Two", "info@prev2.example"], ["Prev Three", "lee@prev3.example"],
    ]);
    expect(a.examples[0].steps).toEqual([
      { step: 1, subject: "Quick question, Pat", body: "Hi Pat, who handles HVAC for Prev One in Worcester?" },
      { step: 2, subject: "Following up", body: "Hi Pat, any HVAC work coming up?" },
    ]);
    expect(a.examples[1].steps[0]).toEqual({ step: 1, subject: "Quick question, there", body: "Hi there, who handles HVAC for Prev Two in your area?" });
    expect(a.examples[2].steps[0].body).toBe("Hi there, who handles HVAC for Prev Three in Boston?");
    // the digest covers what the screen showed (rendered examples), the tone and the delays
    const expected = await db.admin<{ d: string }>(
      "select encode(sha256(convert_to(jsonb_build_object('examples', $2::jsonb, 'tone', s.tone, 'step2', s.step2_delay_days, 'step3', s.step3_delay_days)::text, 'UTF8')), 'hex') as d from public.email_sequences s where s.id = $1",
      [seq, JSON.stringify(a.examples)]);
    expect(a.digest).toBe(expected[0].d);
    // a contact name changed after the preview changes the rendered text, so the digest differs
    await db.query(as(UUID_A), "update public.email_prospects set contact_name = 'Bob Roe' where id = $1", [a.examples[0].prospect_id]);
    const renamed = await preview(seq);
    expect(renamed.examples[0].steps[0].subject).toBe("Quick question, Bob");
    expect(renamed.digest).not.toBe(a.digest);
    const other = await saved(camp, [{ step: 1, subject: "Other", body: "Hi {{first_name}} in {{city}}" }]);
    expect((await preview(other)).digest).not.toBe(a.digest);
    await db.admin("update public.email_prospects set status = 'skipped' where lead_id = $1", [leads[0]]);
    const after = await preview(other);
    expect(after.examples.map((e) => e.company)).toEqual(["Prev Two", "Prev Three", "Prev Four"]);
  });

  test("a lead whose rendered body would pass 2000 characters is skipped in the preview", async () => {
    const camp = await newCampaign("seq-long");
    const short = await newLead("Short Co", "a@short.example", "Ann Lee", null);
    const long = await newLead("L".repeat(200), "b@long.example", "Bea Lee", null);
    await db.query(as(UUID_A), "select public.add_leads_to_campaign($1,$2::uuid[])", [camp, [short, long]]);
    const body = "x".repeat(1900) + " {{company}}"; // 1912 as saved; 1906 + 200 = 2106 for the long company
    const seq = await saved(camp, [{ step: 1, subject: "Hi", body }]);
    const p = await preview(seq);
    expect(p.examples.map((e) => e.company)).toEqual(["Short Co"]);
  });

  test("clients cannot write sequences; a closer and another workspace cannot preview", async () => {
    const camp = await newCampaign("seq-rls");
    const seq = await saved(camp);
    expect(await db.admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.email_sequences'::regclass"))
      .toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    for (const sql of [
      "insert into public.email_sequences (workspace_id, campaign_id, version, status, tone, steps) values ($1,$2,9,'approved','direct','[]')",
      "update public.email_sequences set status = 'approved' where campaign_id = $2 and workspace_id = $1",
      "delete from public.email_sequences where campaign_id = $2 and workspace_id = $1",
    ]) {
      for (const user of [UUID_A, SDR]) expect((await db.try(as(user), sql, [ws, camp])).error?.message, sql).toMatch(/permission denied/);
    }
    // owner and sdr read and preview; the sdr can save a draft
    expect(await db.query(as(SDR), "select id from public.email_sequences where id = $1", [seq])).toHaveLength(1);
    expect((await preview(seq, SDR)).digest).toMatch(/^[0-9a-f]{64}$/);
    expect((await save(camp, STEPS, SDR)).error).toBeUndefined();
    // the closer and another workspace's owner see nothing and can do nothing
    for (const user of [UUID_C, UUID_B]) {
      expect(await db.query(as(user), "select id from public.email_sequences where id = $1", [seq])).toHaveLength(0);
      expect(code((await db.try(as(user), "select public.preview_sequence($1)", [seq])).error)).toBe("42501");
      expect(code((await save(camp, STEPS, user)).error)).toBe("42501");
    }
    expect(code((await db.try(as(UUID_A), "select public.preview_sequence(gen_random_uuid())")).error)).toBe("42501");
    // the agent link on the campaign is not client-writable either
    expect((await db.try(as(UUID_A), "update public.email_campaigns set agent_id = null where id = $1", [camp])).error?.message).toMatch(/permission denied/);
  });
});

// ---------------------------------------------------------------- 0023 part 2 (F4 Task 5): J1 approval, queue, Ligar/Pausar
type Msg = { id: string; prospect_id: string; step: number; status: string; subject: string; body: string; approved_by: string | null;
  approved_at: string | null; approved_to: string | null; approved_digest: string | null; ai_drafted: boolean; prompt_version: string | null;
  due_at: string | null; cancel_reason: string | null };
const messagesOf = (camp: string) => db.admin<Msg>(
  "select id, prospect_id, step, status, subject, body, approved_by, approved_at, approved_to, approved_digest, ai_drafted, prompt_version, due_at, cancel_reason from public.email_messages where campaign_id = $1 order by prospect_id, step", [camp]);
const approve = (seq: string, digest: string, user = UUID_A) =>
  tryCommit<{ n: number }>(db, as(user), "select public.approve_email_sequence($1,$2) as n", [seq, digest]);
async function emailAgent(label: string): Promise<{ agent: string; camp: string }> {
  const agent = (await db.query<{ id: string }>(as(UUID_A), "insert into public.agents (workspace_id, type, name) values ($1,'email',$2) returning id", [ws, label]))[0].id;
  const camp = await newCampaign(label);
  await db.admin("update public.email_campaigns set agent_id = $2 where id = $1", [camp, agent]);
  return { agent, camp };
}
const prospectOf = async (lead: string) => (await db.admin<{ id: string }>("select id from public.email_prospects where lead_id = $1", [lead]))[0].id;

describe("0023 part 2: owner approves once (J1), the queue, Ligar/Pausar", () => {
  test("the approval is tied to the digest the screen showed; an sdr cannot approve", async () => {
    const camp = await newCampaign("j1-digest");
    await db.query(as(UUID_A), "select public.add_leads_to_campaign($1,$2::uuid[])", [camp, [
      await newLead("Dig One", "pat@dig1.example", "Pat Doe", "Worcester"),
      await newLead("Dig Two", "sam@dig2.example", "Sam Roe", null),
    ]]);
    const seq = await saved(camp);
    const shown = await preview(seq);
    // D3: only the owner; the sdr, the closer and another workspace are refused
    for (const user of [SDR, UUID_C, UUID_B]) expect(code((await approve(seq, shown.digest, user)).error), user).toBe("42501");
    expect((await approve(seq, shown.digest, SDR)).error?.message).toMatch(/J1: only the owner approves/);
    // a digest the screen never showed, or text that changed after the preview: review again (40001), nothing queued
    expect(code((await approve(seq, "0".repeat(64))).error)).toBe("40001");
    await db.query(as(UUID_A), "update public.email_prospects set contact_name = 'Bob Roe' where id = $1", [shown.examples[0].prospect_id]);
    const stale = await approve(seq, shown.digest);
    expect(code(stale.error)).toBe("40001");
    expect(stale.error?.message).toMatch(/sequence changed; review again/);
    expect(await messagesOf(camp)).toHaveLength(0);
    expect(await db.admin("select status from public.email_sequences where id = $1", [seq])).toEqual([{ status: "draft" }]);

    const again = await preview(seq);
    const r = await approve(seq, again.digest);
    expect(r.error).toBeUndefined();
    expect(r.rows?.[0].n).toBe(4); // 2 leads x 2 steps
    const s = (await db.admin<{ status: string; approved_by: string; approved_at: string | null; approved_digest: string; example_prospect_ids: string[] }>(
      "select status, approved_by, approved_at, approved_digest, example_prospect_ids from public.email_sequences where id = $1", [seq]))[0];
    expect(s).toMatchObject({ status: "approved", approved_by: UUID_A, approved_digest: again.digest });
    expect(s.approved_at).not.toBeNull();
    expect(s.example_prospect_ids).toEqual(again.examples.map((e) => e.prospect_id));
    // two tabs: the second click finds the version no longer a draft
    expect(code((await approve(seq, again.digest)).error)).toBe("55000");
    // only a draft that is the newest version: an older (superseded) one is refused even with its own digest
    const v2 = await saved(camp, [{ step: 1, subject: "Other", body: "Hi {{first_name}}" }]);
    const v2shown = await preview(v2);
    const v3 = await saved(camp, [{ step: 1, subject: "Third", body: "Hi {{first_name}}" }]);
    expect(code((await approve(v2, v2shown.digest)).error)).toBe("55000");
    expect(code((await approve(seq, again.digest)).error)).toBe("55000");
    // a sequence with no lead to show cannot be approved (J1 needs at least one example)
    const empty = await newCampaign("j1-empty");
    const lone = await saved(empty);
    expect(code((await approve(lone, (await preview(lone)).digest)).error)).toBe("22023");
    expect(code((await approve(gen(), "x")).error)).toBe("42501");
    expect(v3).toBeTruthy();
  });

  test("approving queues one approved message per step per lead with the R1 stamp and sends nothing", async () => {
    const camp = await newCampaign("j1-queue");
    const [ok, noCity, linky, blocked] = [
      await newLead("Que One", "pat@que1.example", "Pat Doe", "Worcester"),
      await newLead("Que Two", "sam@que2.example", null, null),
      await newLead("Que Link", "max@quelink.example", "Max Poe", "www.que-evil.example"),
      await newLead("Que Block", "kim@queblock.example", "Kim Loe", "Salem"),
    ];
    await db.query(as(UUID_A), "select public.add_leads_to_campaign($1,$2::uuid[])", [camp, [ok, noCity, linky, blocked]]);
    // C2: a lead that became do_not_call while its prospect still looks active is never queued
    await db.pg.exec("alter table public.leads disable trigger stop_email_on_lead_block");
    await db.admin("update public.leads set do_not_call = true where id = $1", [blocked]);
    await db.pg.exec("alter table public.leads enable trigger stop_email_on_lead_block");
    // a prospect without an address is never queued
    await db.admin("insert into public.email_prospects (workspace_id, campaign_id, company_name) values ($1,$2,'Que NoMail')", [ws, camp]);
    const seq = await saved(camp);
    const r = await approve(seq, (await preview(seq)).digest);
    expect(r.rows?.[0].n).toBe(4);

    const msgs = await messagesOf(camp);
    const [pOk, pNoCity] = [await prospectOf(ok), await prospectOf(noCity)];
    expect(new Set(msgs.map((m) => m.prospect_id))).toEqual(new Set([pOk, pNoCity]));
    for (const m of msgs) {
      const to = m.prospect_id === pOk ? "pat@que1.example" : "sam@que2.example";
      expect(m).toMatchObject({ status: "approved", approved_by: UUID_A, approved_to: to, ai_drafted: true, prompt_version: "seq-v1" });
      expect(m.approved_at).not.toBeNull();
      const d = await db.admin<{ d: string }>("select public.message_digest($1,$2) as d", [m.subject, m.body]);
      expect(m.approved_digest).toBe(d[0].d);
      // step 1 is due now; later steps wait for step 1 to go out
      if (m.step === 1) expect(new Date(m.due_at as string).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      else expect(m.due_at).toBeNull();
    }
    const first = msgs.find((m) => m.prospect_id === pOk && m.step === 1);
    expect(first).toMatchObject({ subject: "Quick question, Pat", body: "Hi Pat, who handles HVAC for Que One in Worcester?" });
    expect(msgs.find((m) => m.prospect_id === pNoCity && m.step === 1)?.body).toBe("Hi there, who handles HVAC for Que Two in your area?");
    expect(await db.admin("select user_id, action, approved_to from public.email_approvals where message_id = $1", [first?.id]))
      .toEqual([{ user_id: UUID_A, action: "approve", approved_to: "pat@que1.example" }]);
    // nothing left: no claim, no send log, the campaign is still a draft
    expect(msgs.filter((m) => ["sending", "sent", "dry_run"].includes(m.status))).toHaveLength(0);
    expect(await db.admin("select 1 from public.email_send_log where campaign_id = $1", [camp])).toHaveLength(0);
    expect(await db.admin("select status, send_mode from public.email_campaigns where id = $1", [camp])).toEqual([{ status: "draft", send_mode: "dry_run" }]);
  });

  test("an edit after approval sends nothing from the old text; follow-ups of the approved version need no new approval", async () => {
    const camp = await newCampaign("j1-edit");
    const [la, lb] = [await newLead("Edit One", "pat@edit1.example", "Pat Doe", null), await newLead("Edit Two", "sam@edit2.example", "Sam Roe", null)];
    await db.query(as(UUID_A), "select public.add_leads_to_campaign($1,$2::uuid[])", [camp, [la, lb]]);
    const [pa, pb] = [await prospectOf(la), await prospectOf(lb)];
    const v1 = await saved(camp);
    await approve(v1, (await preview(v1)).digest);
    await db.admin("update public.email_campaigns set status = 'active' where id = $1", [camp]);
    // A's step 1 goes out in rehearsal; its follow-up becomes due by itself, with the stamp it already had
    const holder = gen();
    const c = (await db.query<{ r: { outcome: string; message_id: string } }>(as(UUID_A), "select public.claim_next_email($1,$2) as r", [camp, holder]))[0].r;
    expect(c.outcome).toBe("claimed");
    const claimedProspect = (await db.admin<{ prospect_id: string }>("select prospect_id from public.email_messages where id = $1", [c.message_id]))[0].prospect_id;
    await db.query(as(UUID_A), "select public.finish_email_send($1,$2,'dry_run',null)", [c.message_id, holder]);
    const [sentP, otherP] = claimedProspect === pa ? [pa, pb] : [pb, pa];
    let msgs = await messagesOf(camp);
    const follow = msgs.find((m) => m.prospect_id === sentP && m.step === 2) as Msg;
    expect(follow).toMatchObject({ status: "approved", approved_by: UUID_A });
    expect(follow.due_at).not.toBeNull();
    expect(await db.admin("select count(*)::int as n from public.email_approvals where message_id = $1", [follow.id])).toEqual([{ n: 1 }]);
    // a step cancelled for a stop reason (not an edit) must never come back
    const otherStep2 = msgs.find((m) => m.prospect_id === otherP && m.step === 2) as Msg;
    await db.admin("update public.email_messages set status = 'cancelled', cancel_reason = 'lead_status' where id = $1", [otherStep2.id]);

    // the edit: nothing approved is left from the old text, nothing can be claimed
    const v2Steps: Step[] = [{ step: 1, subject: "New hello {{first_name}}", body: "New text for {{company}}." }, { step: 2, subject: "New follow-up", body: "Still there, {{first_name}}?" }];
    const v2 = await saved(camp, v2Steps);
    msgs = await messagesOf(camp);
    expect(msgs.filter((m) => m.status === "approved")).toHaveLength(0);
    const nothing = (await db.query<{ r: { outcome: string } }>(as(UUID_A), "select public.claim_next_email($1,$2) as r", [camp, gen()]))[0].r;
    expect(nothing.outcome).not.toBe("claimed");

    // approving v2 re-writes the same rows from the new text; what went out and the stop-reason row stay as they are
    const n = (await approve(v2, (await preview(v2)).digest)).rows?.[0].n;
    expect(n).toBe(2); // sent prospect's step 2 + other prospect's step 1
    msgs = await messagesOf(camp);
    const by = (p: string, step: number) => msgs.find((m) => m.prospect_id === p && m.step === step) as Msg;
    expect(by(sentP, 1).status).toBe("dry_run");
    expect(by(sentP, 1).subject).toBe("Quick question, " + (sentP === pa ? "Pat" : "Sam"));
    expect(by(sentP, 2)).toMatchObject({ id: follow.id, status: "approved", subject: "New follow-up", cancel_reason: null });
    expect(by(sentP, 2).due_at).not.toBeNull(); // from step 1's sent_at
    const due = await db.admin<{ ok: boolean }>(
      "select m.due_at = public.add_business_days(f.sent_at, c.step2_delay_days) as ok from public.email_messages m join public.email_messages f on f.prospect_id = m.prospect_id and f.step = 1 join public.email_campaigns c on c.id = m.campaign_id where m.id = $1",
      [follow.id]);
    expect(due).toEqual([{ ok: true }]);
    expect(by(otherP, 1)).toMatchObject({ status: "approved", subject: `New hello ${otherP === pa ? "Pat" : "Sam"}` });
    expect(by(otherP, 2)).toMatchObject({ id: otherStep2.id, status: "cancelled", cancel_reason: "lead_status" });
    expect(msgs).toHaveLength(4);
  });

  test("F4 UI review: an old version fails after a newer save; the sdr cannot approve; a late lead is queued approved (D6)", async () => {
    const camp = await newCampaign("ui-review");
    await db.query(as(UUID_A), "select public.add_leads_to_campaign($1,$2::uuid[])", [camp, [await newLead("Ui One", "pat@ui1.example", "Pat Doe", "Worcester")]]);
    const v1 = await saved(camp);
    const shown = await preview(v1);
    expect(code((await approve(v1, shown.digest, SDR)).error)).toBe("42501");
    const v2 = await saved(camp, [{ step: 1, subject: "Newer", body: "Hi {{first_name}}" }]);
    // the screen still shows v1 with its own digest: the database refuses it (the action maps both to "changed")
    expect(["55000", "40001"]).toContain(code((await approve(v1, shown.digest)).error));
    expect((await approve(v2, (await preview(v2)).digest)).error).toBeUndefined();
    // D6: this is why the lead page must say "enters the approved sequence"
    const late = await newLead("Ui Two", "ann@ui2.example", "Ann Lee", "Salem");
    await db.query(as(SDR), "select public.add_leads_to_campaign($1,$2::uuid[])", [camp, [late]]);
    const mine = (await messagesOf(camp)).filter((m) => m.prospect_id !== shown.examples[0].prospect_id);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((m) => m.status === "approved")).toBe(true);
  });

  test("a lead added after approval is queued from the approved version", async () => {
    const camp = await newCampaign("j1-late");
    const first = await newLead("Late One", "pat@late1.example", "Pat Doe", "Worcester");
    await db.query(as(UUID_A), "select public.add_leads_to_campaign($1,$2::uuid[])", [camp, [first]]);
    const seq = await saved(camp);
    await approve(seq, (await preview(seq)).digest);
    const before = await messagesOf(camp);
    const approvalsBefore = await db.admin("select id from public.email_approvals where workspace_id = $1", [ws]);
    // D6: the sdr adds a lead; it goes out with the approved text, stamped by the owner who approved it
    const late = await newLead("Late Two", "ann@late2.example", "Ann Lee", "Salem");
    const added = (await db.query<{ r: { added: number } }>(as(SDR), "select public.add_leads_to_campaign($1,$2::uuid[]) as r", [camp, [late]]))[0].r;
    expect(added).toMatchObject({ added: 1 });
    const pLate = await prospectOf(late);
    const msgs = await messagesOf(camp);
    const mine = msgs.filter((m) => m.prospect_id === pLate);
    expect(mine.map((m) => [m.step, m.status, m.approved_by, m.approved_to])).toEqual([[1, "approved", UUID_A, "ann@late2.example"], [2, "approved", UUID_A, "ann@late2.example"]]);
    expect(mine[0].body).toBe("Hi Ann, who handles HVAC for Late Two in Salem?");
    // the earlier lead's messages are untouched (no second stamp)
    expect(msgs.filter((m) => m.prospect_id !== pLate)).toEqual(before);
    expect((await db.admin("select id from public.email_approvals where workspace_id = $1", [ws])).length).toBe(approvalsBefore.length + 2);
    // a campaign with no approved version queues nothing
    const other = await newCampaign("j1-late-none");
    await saved(other);
    const r = (await db.query<{ r: { added: number } }>(as(UUID_A), "select public.add_leads_to_campaign($1,$2::uuid[]) as r", [other, [await newLead("None Co", "x@none.example", null, null)]]))[0].r;
    expect(r).toMatchObject({ added: 1 });
    expect(await messagesOf(other)).toHaveLength(0);
  });

  test("Ligar needs an approved sequence, a mailbox and the sender profile; Pausar stops the clock picking the campaign", async () => {
    const { agent, camp } = await emailAgent("j1-run");
    const run = (on: boolean, user = UUID_A) => tryCommit(db, as(user), "select public.set_email_agent_running($1,$2)", [agent, on]);
    const state = async () => (await db.admin<{ a: string; c: string }>(
      "select a.status as a, c.status as c from public.agents a join public.email_campaigns c on c.agent_id = a.id where a.id = $1", [agent]))[0];
    await db.query(as(UUID_A), "select public.add_leads_to_campaign($1,$2::uuid[])", [camp, [await newLead("Run One", "pat@run1.example", "Pat Doe", null)]]);
    // the client leaves draft only once a sequence exists
    expect(code((await db.try(as(UUID_A), "update public.agents set status = 'paused' where id = $1", [agent])).error)).toBe("23514");
    const seq = await saved(camp);
    expect((await tryCommit(db, as(SDR), "update public.agents set status = 'paused' where id = $1", [agent])).error).toBeUndefined();
    // no approved version yet
    expect(code((await run(true)).error)).toBe("55000");
    await approve(seq, (await preview(seq)).digest);
    // no mailbox
    const links = await db.admin<{ mailbox_id: string }>("select mailbox_id from public.campaign_mailboxes where campaign_id = $1", [camp]);
    await db.admin("delete from public.campaign_mailboxes where campaign_id = $1", [camp]);
    expect(code((await run(true)).error)).toBe("55000");
    await db.query(as(UUID_A), "insert into public.campaign_mailboxes (campaign_id, mailbox_id) values ($1,$2)", [camp, links[0].mailbox_id]);
    // no complete sender profile
    await db.admin("update public.sender_profiles set postal_address = 'x' where workspace_id = $1", [ws]);
    expect(code((await run(true)).error)).toBe("55000");
    await db.admin("update public.sender_profiles set postal_address = '1 Main St, Millbury, MA 01527' where workspace_id = $1", [ws]);
    // the closer and another workspace cannot; a client cannot set running/paused by hand
    for (const user of [UUID_C, UUID_B]) expect(code((await run(true, user)).error)).toBe("42501");
    expect(code((await db.try(as(UUID_A), "update public.agents set status = 'running' where id = $1", [agent])).error)).toBe("23514");
    expect(await state()).toEqual({ a: "paused", c: "draft" });

    // Ligar (the sdr may): the agent runs and the clock lists the campaign
    expect((await run(true, SDR)).error).toBeUndefined();
    expect(await state()).toEqual({ a: "running", c: "active" });
    expect(await db.admin("select send_mode from public.email_campaigns where id = $1", [camp])).toEqual([{ send_mode: "dry_run" }]);
    await db.admin("update public.email_campaigns set status = 'paused' where status = 'active' and id <> $1", [camp]);
    await setSchedulerToken(db, TOKEN);
    const clock = anonWithToken(TOKEN);
    const due = async () => {
      const r = (await db.query<{ r: { run_id: string } }>(clock, "select public.scheduler_begin_run() as r"))[0].r.run_id;
      const ids = (await db.query<{ r: { campaign_ids: string[] } }>(clock, "select public.scheduler_due_work($1) as r", [r]))[0].r.campaign_ids;
      await db.query(clock, "select public.scheduler_finish_run($1,'{}'::jsonb,null)", [r]);
      return ids;
    };
    expect(await due()).toContain(camp);
    expect(code((await db.try(as(UUID_A), "update public.agents set status = 'paused' where id = $1", [agent])).error)).toBe("23514");
    // Pausar: both paused, the clock no longer picks the campaign
    expect((await run(false)).error).toBeUndefined();
    expect(await state()).toEqual({ a: "paused", c: "paused" });
    expect(await due()).not.toContain(camp);
    // Ligar again works; a non-email agent is refused
    expect((await run(true)).error).toBeUndefined();
    expect(await state()).toEqual({ a: "running", c: "active" });
    const hunter = (await db.query<{ id: string }>(as(UUID_A), "insert into public.agents (workspace_id, type, name) values ($1,'hunter','h') returning id", [ws]))[0].id;
    expect(code((await db.try(as(UUID_A), "select public.set_email_agent_running($1,true)", [hunter])).error)).toBe("22023");
    await run(false);
  });

  test("the e-mail sequence writer is a known AI task", async () => {
    const def = await db.admin<{ d: string }>("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'ai_calls_task'");
    expect(def[0].d).toContain("email_sequence");
    for (const t of ["qualify_deep", "profile_learn", "email_draft"]) expect(def[0].d).toContain(t);
  });
});

// ---------------------------------------------------------------- 0023 part 2 review fixes
describe("0023 part 2 fixes: owner-only sequence text, no revived rows, Ligar only, approved delays", () => {
  const claimOne = async (camp: string) => {
    const holder = gen();
    const c = (await db.query<{ r: { outcome: string; message_id: string } }>(as(UUID_A), "select public.claim_next_email($1,$2) as r", [camp, holder]))[0].r;
    expect(c.outcome).toBe("claimed");
    await db.query(as(UUID_A), "select public.finish_email_send($1,$2,'dry_run',null)", [c.message_id, holder]);
    return c.message_id;
  };
  const setApproval = (ids: string[], action: string, user = UUID_A) =>
    tryCommit(db, as(user), "select public.set_email_approval($1::uuid[], public.test_versions($1::uuid[]), $2)", [ids, action]);

  test("an sdr cannot approve a sequence message one by one; the owner can", async () => {
    const camp = await newCampaign("fix-sdr");
    await db.query(as(UUID_A), "select public.add_leads_to_campaign($1,$2::uuid[])", [camp, [await newLead("Fix Sdr", "pat@fixsdr.example", "Pat Doe", null)]]);
    const seq = await saved(camp);
    await approve(seq, (await preview(seq)).digest);
    const step1 = (await messagesOf(camp)).find((m) => m.step === 1) as Msg;
    // the sdr edits the approved text: back to draft; approving it again is the owner's
    await db.query(as(SDR), "update public.email_messages set body = 'Hi Pat, edited by the sdr.' where id = $1", [step1.id]);
    expect((await messagesOf(camp)).find((m) => m.id === step1.id)?.status).toBe("draft");
    const r = await setApproval([step1.id], "approve", SDR);
    expect(code(r.error)).toBe("42501");
    expect(r.error?.message).toMatch(/J1: only the owner approves sequence messages/);
    expect((await setApproval([step1.id], "approve")).error).toBeUndefined();
    expect((await messagesOf(camp)).find((m) => m.id === step1.id)).toMatchObject({ status: "approved", approved_by: UUID_A, body: "Hi Pat, edited by the sdr." });
  });

  test("the queue never revives a row the owner rejected", async () => {
    const camp = await newCampaign("fix-reject");
    await db.query(as(UUID_A), "select public.add_leads_to_campaign($1,$2::uuid[])", [camp, [await newLead("Rej One", "pat@rej1.example", "Pat Doe", null)]]);
    const seq = await saved(camp);
    await approve(seq, (await preview(seq)).digest);
    const step2 = (await messagesOf(camp)).find((m) => m.step === 2) as Msg;
    expect((await setApproval([step2.id], "reject")).error).toBeUndefined();
    // a later lead is queued; the rejected row stays rejected, with no owner stamp
    await db.query(as(SDR), "select public.add_leads_to_campaign($1,$2::uuid[])", [camp, [await newLead("Rej Two", "ann@rej2.example", "Ann Lee", null)]]);
    const msgs = await messagesOf(camp);
    expect(msgs.find((m) => m.id === step2.id)).toMatchObject({ status: "rejected", approved_by: null });
    expect(msgs.filter((m) => m.status === "approved")).toHaveLength(3);
  });

  test("Pausar cannot be undone by hand: a client cannot activate an agent's campaign", async () => {
    const { agent, camp } = await emailAgent("fix-activate");
    await db.query(as(UUID_A), "select public.add_leads_to_campaign($1,$2::uuid[])", [camp, [await newLead("Act One", "pat@act1.example", "Pat Doe", null)]]);
    const seq = await saved(camp);
    await approve(seq, (await preview(seq)).digest);
    expect((await tryCommit(db, as(UUID_A), "select public.set_email_agent_running($1,true)", [agent])).error).toBeUndefined();
    expect((await tryCommit(db, as(UUID_A), "select public.set_email_agent_running($1,false)", [agent])).error).toBeUndefined();
    for (const user of [UUID_A, SDR]) {
      const r = await db.try(as(user), "update public.email_campaigns set status = 'active' where id = $1", [camp]);
      expect(code(r.error), user).toBe("42501");
    }
    // a client may still pause it, and a campaign without an agent keeps the 0003 rule
    expect((await db.try(as(SDR), "update public.email_campaigns set status = 'done' where id = $1", [camp])).error).toBeUndefined();
    const plain = await newCampaign("fix-plain");
    expect((await db.try(as(SDR), "update public.email_campaigns set status = 'active' where id = $1", [plain])).error).toBeUndefined();
    await tryCommit(db, as(UUID_A), "select public.set_email_agent_running($1,false)", [agent]);
  });

  test("the approved delays are used; a client cannot change the campaign's delays", async () => {
    const camp = await newCampaign("fix-delays");
    await db.query(as(UUID_A), "select public.add_leads_to_campaign($1,$2::uuid[])", [camp, [await newLead("Del One", "pat@del1.example", "Pat Doe", null)]]);
    for (const user of [UUID_A, SDR]) {
      expect((await db.try(as(user), "update public.email_campaigns set step2_delay_days = 1, step3_delay_days = 2 where id = $1", [camp])).error?.message).toMatch(/permission denied/);
    }
    const seq = await saved(camp, STEPS, [5, 9]);
    await approve(seq, (await preview(seq)).digest);
    // even if the campaign row drifted (only the database can write it now), the approved version's delay wins
    await db.admin("update public.email_campaigns set step2_delay_days = 1, step3_delay_days = 2, status = 'active' where id = $1", [camp]);
    await claimOne(camp);
    const ok = await db.admin<{ ok: boolean }>(
      "select m.due_at = public.add_business_days(f.sent_at, 5) as ok from public.email_messages m join public.email_messages f on f.prospect_id = m.prospect_id and f.step = 1 where m.campaign_id = $1 and m.step = 2",
      [camp]);
    expect(ok).toEqual([{ ok: true }]);
  });

  test("a 1-step sequence ends the prospect after its step", async () => {
    const camp = await newCampaign("fix-one-step");
    const lead = await newLead("One Step", "pat@onestep.example", "Pat Doe", null);
    await db.query(as(UUID_A), "select public.add_leads_to_campaign($1,$2::uuid[])", [camp, [lead]]);
    const seq = await saved(camp, STEPS.slice(0, 1));
    await approve(seq, (await preview(seq)).digest);
    await db.admin("update public.email_campaigns set status = 'active' where id = $1", [camp]);
    await claimOne(camp);
    expect(await db.admin("select status from public.email_prospects where lead_id = $1", [lead])).toEqual([{ status: "done" }]);
  });

  test("create_email_agent_campaign: one rehearsal campaign per e-mail agent, owner or sdr of its workspace", async () => {
    const agent = (await db.query<{ id: string }>(as(UUID_A), "insert into public.agents (workspace_id, type, name) values ($1,'email','Create') returning id", [ws]))[0].id;
    const create = (user: string, a = agent, name = "Agent camp", list: string | null = null) =>
      tryCommit<{ id: string }>(db, as(user), "select public.create_email_agent_campaign($1,$2,$3) as id", [a, name, list]);
    // the closer and another workspace's owner cannot; a non-email agent cannot have one
    for (const user of [UUID_C, UUID_B]) expect(code((await create(user)).error), user).toBe("42501");
    const hunter = (await db.query<{ id: string }>(as(UUID_A), "insert into public.agents (workspace_id, type, name) values ($1,'hunter','h2') returning id", [ws]))[0].id;
    expect(code((await create(UUID_A, hunter)).error)).toBe("22023");
    expect(code((await create(UUID_A, agent, "  ")).error)).toBe("22023");
    // a list that is not a research list of this workspace is refused
    expect(code((await create(UUID_A, agent, "x", gen())).error)).toBe("42501");
    // the sdr creates it: draft, rehearsal, linked to the agent
    const r = await create(SDR);
    expect(r.error).toBeUndefined();
    const id = r.rows?.[0].id as string;
    expect(await db.admin("select workspace_id, agent_id, status, send_mode, name, created_by from public.email_campaigns where id = $1", [id]))
      .toEqual([{ workspace_id: ws, agent_id: agent, status: "draft", send_mode: "dry_run", name: "Agent camp", created_by: SDR }]);
    // a second campaign is refused; a client still cannot write agent_id itself
    expect(code((await create(UUID_A)).error)).toBe("55000");
    expect((await db.try(as(UUID_A), "insert into public.email_campaigns (workspace_id, name, agent_id) values ($1,'x',$2)", [ws, agent])).error?.message).toMatch(/permission denied/);
  });
});

describe("0023 set_campaign_delays", () => {
  test("a sender changes a plain campaign's delays; sequence campaigns, the closer and bad values are refused", async () => {
    const plain = await newCampaign("delays-plain");
    const setDelays = (camp: string, d2: number | null, d3: number | null, user = UUID_A) =>
      tryCommit(db, as(user), "select public.set_campaign_delays($1,$2,$3)", [camp, d2, d3]);
    expect((await setDelays(plain, 2, 5, SDR)).error).toBeUndefined();
    expect(await db.admin("select step2_delay_days, step3_delay_days from public.email_campaigns where id = $1", [plain]))
      .toEqual([{ step2_delay_days: 2, step3_delay_days: 5 }]);
    for (const [d2, d3] of [[0, 5], [31, 40], [3, 61], [5, 5], [6, 5], [null, 5], [3, null]] as const) {
      expect(code((await setDelays(plain, d2, d3)).error), `${d2} ${d3}`).toBe("22023");
    }
    for (const user of [UUID_C, UUID_B]) expect(code((await setDelays(plain, 3, 7, user)).error), user).toBe("42501");
    expect(code((await setDelays(gen(), 3, 7)).error)).toBe("42501");
    // a campaign with a sequence takes its delays from the approved version
    const seqCamp = await newCampaign("delays-seq");
    await saved(seqCamp);
    const r = await setDelays(seqCamp, 2, 5);
    expect(code(r.error)).toBe("55000");
    expect(r.error?.message).toMatch(/delays come from the approved sequence/);
    expect(await db.admin("select step2_delay_days, step3_delay_days from public.email_campaigns where id = $1", [plain]))
      .toEqual([{ step2_delay_days: 2, step3_delay_days: 5 }]);
  });
});
