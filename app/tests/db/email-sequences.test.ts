import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TEMPLATE_VECTORS } from "../fixtures/template-vectors";
import { TestDb, as, openGates, UUID_A, UUID_B, UUID_C } from "./helpers";
import { CIPHER, createOwner } from "./scheduler-seed";

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
