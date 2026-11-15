import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, ageEmailClaims, anon, as, endCompanyDay, installEmailTestHelpers, openGates, UUID_A, UUID_B, UUID_C } from "./helpers";

// Migration 0003 (E-mail): RLS, column grants and the sending rules enforced in the database
// [R1] [R2] [R3] [R4] [R5] [R8] [R9] [R12] [R14] [R18]. Real migrations, non-superuser roles (PGlite).

const UUID_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // closer in workspace A

let db: TestDb;
let wsA: string;
let wsB: string;
const ids: Record<string, string> = {};

const TABLES = [
  "sender_profiles",
  "mailboxes",
  "suppressions",
  "email_campaigns",
  "email_prospects",
  "email_replies",
  "email_messages",
  "email_approvals",
  "campaign_mailboxes",
] as const;

const CIPHER = "v1:" + "A".repeat(60);

async function one<T = Record<string, unknown>>(user: string, sql: string, params: unknown[] = []): Promise<T> {
  const rows = await db.query<T>(as(user), sql, params);
  return rows[0];
}

async function createWorkspace(userId: string, name: string): Promise<string> {
  return (await one<{ create_workspace: string }>(userId, "select public.create_workspace($1)", [name])).create_workspace;
}

/** A finished research list with two kept companies: one with a published address (and its evidence), one without. */
async function seedList(user: string, ws: string, key: string) {
  const run = await one<{ id: string }>(
    user,
    "insert into public.research_runs (workspace_id, title, request_text) values ($1,'t','pedido') returning id",
    [ws],
  );
  const c1 = await one<{ id: string }>(
    user,
    `insert into public.research_candidates (workspace_id, run_id, name, name_key, website, public_email, email_type)
     values ($1,$2,$3,$4,'https://acme.example','Office@Acme.example','generic') returning id`,
    [ws, run.id, `Acme ${key}`, `acme ${key}`.toLowerCase()],
  );
  await db.query(as(user), "update public.research_candidates set ask_for_name = 'Pat Doe', ask_for_title = 'Owner', hook = 'Saw your permit', user_decision = 'keep' where id = $1", [c1.id]);
  await db.query(as(user), "select public.add_research_check($1,'exists_active',1,'ok','ativa',$2::jsonb)", [
    c1.id,
    JSON.stringify([{ url: "https://acme.example/contact", title: "Contact", excerpt: "Write to office@acme.example" }]),
  ]);
  const c2 = await one<{ id: string }>(
    user,
    "insert into public.research_candidates (workspace_id, run_id, name, name_key) values ($1,$2,$3,$4) returning id",
    [ws, run.id, `Beta ${key}`, `beta ${key}`.toLowerCase()],
  );
  await db.query(as(user), "update public.research_candidates set user_decision = 'keep' where id = $1", [c2.id]);
  const list = await one<{ create_research_list: string }>(user, "select public.create_research_list($1,'Lista')", [run.id]);
  return { list: list.create_research_list, withEmail: c1.id, withoutEmail: c2.id };
}

async function seedWorkspace(user: string, ws: string, key: string) {
  const l = await seedList(user, ws, key);
  ids[`list${key}`] = l.list;
  ids[`candMail${key}`] = l.withEmail;
  await db.query(as(user), "insert into public.sender_profiles (workspace_id, legal_name, postal_address, sender_name) values ($1,'Acme HVAC Corp','1 Main St, Millbury, MA 01527','Pat Sender')", [ws]);
  ids[`mb${key}`] = (await one<{ save_mailbox: string }>(user, "select public.save_mailbox($1,$2,$3)", [ws, `sales${key.toLowerCase()}@gmail.com`, CIPHER])).save_mailbox;
  await db.query(as(user), "select public.set_mailbox_verified($1, true, null)", [ids[`mb${key}`]]);
  ids[`camp${key}`] = (
    await one<{ id: string }>(user, "insert into public.email_campaigns (workspace_id, list_id, name, mailbox_id) values ($1,$2,'Campanha',$3) returning id", [
      ws,
      l.list,
      ids[`mb${key}`],
    ])
  ).id;
  await openGates(db, ids[`camp${key}`]);
  await db.query(as(user), "select public.import_list_into_campaign($1)", [ids[`camp${key}`]]);
  const p = await one<{ id: string }>(user, "select id from public.email_prospects where candidate_id = $1", [l.withEmail]);
  ids[`pros${key}`] = p.id;
  ids[`prosNoMail${key}`] = (await one<{ id: string }>(user, "select id from public.email_prospects where candidate_id = $1", [l.withoutEmail])).id;
  for (const step of [1, 2, 3]) {
    const m = await one<{ id: string }>(
      user,
      "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body, ai_drafted) values ($1,$2,$3,'sequence',$4,$5,'Hi Pat, short note.',true) returning id",
      [ws, ids[`camp${key}`], p.id, step, `Quick question ${step}`],
    );
    ids[`msg${step}${key}`] = m.id;
  }
  await db.query(as(user), "insert into public.suppressions (workspace_id, kind, value, reason) values ($1,'domain','blocked.example','manual')", [ws]);
  ids[`sup${key}`] = (await one<{ id: string }>(user, "select id from public.suppressions where workspace_id = $1", [ws])).id;
  await db.query(as(user), "select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')", [ids[`msg1${key}`]]);
  ids[`reply${key}`] = (
    await one<{ record_email_reply: string }>(user, "select public.record_email_reply($1,$2,null,'x@y.example','Re: hi','thanks',$3,now(),'reply',null)", [
      ids[`prosNoMail${key}`],
      ids[`mb${key}`],
      `<seed-${key}@mail.example>`,
    ])
  ).record_email_reply;
}

/** A fresh campaign with one prospect and approved step-1 messages, ready to claim. */
async function freshCampaign(name: string, emails: string[]) {
  const camp = await one<{ id: string }>(UUID_A, "insert into public.email_campaigns (workspace_id, list_id, name, mailbox_id) values ($1,$2,$3,$4) returning id", [
    wsA,
    ids.listA,
    name,
    ids.mbA,
  ]);
  await openGates(db, camp.id);
  await db.query(as(UUID_A), "select public.import_list_into_campaign($1)", [camp.id]);
  const prospects = await db.query<{ id: string }>(as(UUID_A), "select id from public.email_prospects where campaign_id = $1 order by created_at", [camp.id]);
  const msgs: string[] = [];
  for (const [i, email] of emails.entries()) {
    // reuse the imported prospects and add more by updating addresses (manual)
    let pid = prospects[i]?.id;
    if (!pid) {
      // extra prospects come from re-importing into new campaigns is not possible; use admin for test setup only
      const r = await db.admin<{ id: string }>(
        "insert into public.email_prospects (workspace_id, campaign_id, company_name, email, email_source) values ($1,$2,$3,$4,'manual') returning id",
        [wsA, camp.id, `Extra ${i}`, email],
      );
      pid = r[0].id;
    } else {
      await db.query(as(UUID_A), "update public.email_prospects set email = $2 where id = $1", [pid, email]);
    }
    const m = await one<{ id: string }>(
      UUID_A,
      "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body) values ($1,$2,$3,'sequence',1,'Hello there','Hi, short note.') returning id",
      [wsA, camp.id, pid],
    );
    msgs.push(m.id);
  }
  await db.query(as(UUID_A), "select public.set_email_approval($1::uuid[], public.test_versions($1::uuid[]), 'approve')", [msgs]);
  await db.query(as(UUID_A), "update public.email_campaigns set status = 'active' where id = $1", [camp.id]);
  return { camp: camp.id, msgs };
}

type Claim = { outcome: string; message_id?: string; wait_until?: string };
const claim = async (user: string, camp: string, holder = "11111111-1111-4111-8111-111111111111") =>
  (await one<{ claim_next_email: Claim }>(user, "select public.claim_next_email($1,$2)", [camp, holder])).claim_next_email;
const finish = (user: string, msg: string, result: string, holder = "11111111-1111-4111-8111-111111111111") =>
  db.query(as(user), "select public.finish_email_send($1,$2,$3,null)", [msg, holder, result]);
/** Moves every claim back in time, messages and send log (test-only clock travel). */
const ageClaims = (seconds: number) => ageEmailClaims(db, seconds);

beforeAll(async () => {
  db = await TestDb.create();
  await installEmailTestHelpers(db);
  for (const id of [UUID_A, UUID_B, UUID_C, UUID_D]) await db.addUser(id);
  wsA = await createWorkspace(UUID_A, "Empresa A");
  wsB = await createWorkspace(UUID_B, "Empresa B");
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr'), ($1,$3,'closer')", [wsA, UUID_C, UUID_D]);
  await seedWorkspace(UUID_A, wsA, "A");
  await seedWorkspace(UUID_B, wsB, "B");
});

afterAll(async () => {
  await db.pg.close();
});

describe("0003 tables: RLS on, forced; anon has nothing [R8] [R14]", () => {
  test("RLS enabled and forced on every new table", async () => {
    const rows = await db.admin<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = any($1)",
      [TABLES],
    );
    expect(rows).toHaveLength(TABLES.length);
    for (const r of rows) {
      expect(r.relrowsecurity, r.relname).toBe(true);
      expect(r.relforcerowsecurity, r.relname).toBe(true);
    }
  });

  test("every policy on the new tables targets authenticated only", async () => {
    const rows = await db.admin<{ tablename: string; roles: string[] | string }>(
      "select tablename, roles from pg_policies where schemaname = 'public' and tablename = any($1)",
      [TABLES],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(String(r.roles), r.tablename).toMatch(/^\{?authenticated\}?$/);
  });

  test.each(TABLES)("anon cannot select %s", async (table) => {
    const r = await db.try(anon, `select 1 from public.${table}`);
    expect(r.error?.message).toMatch(/permission denied/);
  });

  test("anon cannot call any e-mail RPC except unsubscribe_by_token", async () => {
    for (const sql of [
      "select public.claim_next_email($1, gen_random_uuid())",
      "select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')",
      "select public.mailbox_secret($1)",
      "select public.import_list_into_campaign($1)",
      "select public.set_campaign_send_mode($1, 'real')",
      "select public.hand_off_prospect($1)",
      "select public.mailbox_usage($1)",
    ]) {
      const r = await db.try(anon, sql, [ids.campA]);
      expect(r.error?.message, sql).toMatch(/permission denied/);
    }
  });
});

describe("user A cannot read or write workspace B [R8]", () => {
  const selectB: Array<[string, string, string, () => string]> = [
    ["sender_profiles", "workspace_id", "workspace_id", () => wsB],
    ["mailboxes", "id", "id, email", () => ids.mbB],
    ["suppressions", "id", "*", () => ids.supB],
    ["email_campaigns", "id", "*", () => ids.campB],
    ["email_prospects", "id", "*", () => ids.prosB],
    ["email_messages", "id", "*", () => ids.msg1B],
    ["email_replies", "id", "*", () => ids.replyB],
    ["email_approvals", "message_id", "*", () => ids.msg1B],
  ];

  test.each(selectB)("select %s of B returns nothing", async (table, col, cols, id) => {
    expect(await db.query(as(UUID_A), `select ${cols} from public.${table} where ${col} = $1`, [id()])).toHaveLength(0);
    expect((await db.query(as(UUID_B), `select ${cols} from public.${table} where ${col} = $1`, [id()])).length).toBeGreaterThan(0);
  });

  test("A cannot insert rows into B", async () => {
    const attempts: Array<[string, unknown[]]> = [
      ["insert into public.sender_profiles (workspace_id, legal_name) values ($1,'x')", [wsB]],
      ["insert into public.suppressions (workspace_id, kind, value, reason) values ($1,'address','a@b.example','manual')", [wsB]],
      ["insert into public.email_campaigns (workspace_id, name) values ($1,'x')", [wsB]],
      ["insert into public.email_campaigns (workspace_id, name, mailbox_id) values ($1,'x',$2)", [wsA, ids.mbB]],
      ["insert into public.email_campaigns (workspace_id, name, list_id) values ($1,'x',$2)", [wsA, ids.listB]],
      ["insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body) values ($1,$2,$3,'sequence',1,'s','b')", [wsB, ids.campB, ids.prosB]],
      ["insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body) values ($1,$2,$3,'sequence',1,'s','b')", [wsA, ids.campA, ids.prosB]],
    ];
    for (const [sql, params] of attempts) expect((await db.try(as(UUID_A), sql, params)).error, sql).toBeDefined();
  });

  test("A's updates and deletes do not touch B", async () => {
    for (const sql of [
      "update public.email_messages set subject = 'hacked' where id = $1 returning id",
      "update public.email_prospects set email = 'x@evil.example' where id = $1 returning id",
      "update public.email_campaigns set name = 'hacked' where id = $1 returning id",
      "delete from public.suppressions where id = $1 returning id",
      "delete from public.mailboxes where id = $1 returning id",
    ]) {
      const id = sql.includes("email_messages") ? ids.msg1B : sql.includes("prospects") ? ids.prosB : sql.includes("campaigns") ? ids.campB : sql.includes("suppressions") ? ids.supB : ids.mbB;
      expect(await db.query(as(UUID_A), sql, [id]), sql).toHaveLength(0);
    }
  });

  test("A cannot use B's ids in the RPCs", async () => {
    const calls: Array<[string, unknown[]]> = [
      ["select public.claim_next_email($1, gen_random_uuid())", [ids.campB]],
      ["select public.mailbox_secret($1)", [ids.mbB]],
      ["select public.set_mailbox_verified($1, true, null)", [ids.mbB]],
      ["select public.mailbox_usage($1)", [ids.mbB]],
      ["select public.import_list_into_campaign($1)", [ids.campB]],
      ["select public.set_campaign_send_mode($1, 'dry_run')", [ids.campB]],
      ["select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')", [ids.msg2B]],
      ["select public.retry_failed_email($1)", [ids.msg1B]],
      ["select public.hand_off_prospect($1)", [ids.prosB]],
      ["select public.set_reply_class($1, 'interested', 'human', null, null)", [ids.replyB]],
      ["select public.record_email_reply($1, null, null, 'a@b.example', 's', 'b', '<x@y>', now(), 'reply', null)", [ids.prosB]],
      ["select public.save_mailbox($1, 'z@gmail.com', $2)", [wsB, CIPHER]],
    ];
    for (const [sql, params] of calls) expect((await db.try(as(UUID_A), sql, params)).error?.message, sql).toMatch(/not allowed|not found/);
    expect((await db.query<{ claim_campaign_draft: boolean }>(as(UUID_A), "select public.claim_campaign_draft($1, gen_random_uuid(), 60)", [ids.campB]))[0].claim_campaign_draft).toBe(false);
  });
});

describe("secrets and forged columns [R14] [R8]", () => {
  test("the ciphertext column is not selectable by any client (no column grant)", async () => {
    for (const sql of ["select secret_ciphertext from public.mailboxes", "select * from public.mailboxes"]) {
      expect((await db.try(as(UUID_A), sql)).error?.message, sql).toMatch(/permission denied/);
    }
  });

  test("owners and SDRs CAN obtain the ciphertext, only through mailbox_secret() (useless without the server key; AAD-bound)", async () => {
    expect((await one<{ mailbox_secret: string }>(UUID_A, "select public.mailbox_secret($1)", [ids.mbA])).mailbox_secret).toBe(CIPHER);
    expect((await one<{ mailbox_secret: string }>(UUID_C, "select public.mailbox_secret($1)", [ids.mbA])).mailbox_secret).toBe(CIPHER);
    expect((await db.try(as(UUID_D), "select public.mailbox_secret($1)", [ids.mbA])).error?.message).toMatch(/not allowed/);
  });

  test("clients cannot write status, approval stamps, claim/lease, counters or send fields of a message", async () => {
    for (const col of [
      "status = 'approved'",
      "approved_by = $2",
      "approved_at = now()",
      "claimed_at = now() - interval '1 day'",
      "claim_holder = $2",
      "next_gap_seconds = 60",
      "send_mode = 'real'",
      "sent_at = now()",
      "due_at = now()",
      "rfc_message_id = '<x@y>'",
    ]) {
      const r = await db.try(as(UUID_A), `update public.email_messages set ${col} where id = $1`, col.includes("$2") ? [ids.msg2A, UUID_A] : [ids.msg2A]);
      expect(r.error?.message, col).toMatch(/permission denied/);
    }
    const ins = await db.try(
      as(UUID_A),
      "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body, status, approved_by, approved_at) values ($1,$2,$3,'sequence',1,'s','b','approved',$4,now())",
      [wsA, ids.campA, ids.prosNoMailA, UUID_A],
    );
    expect(ins.error?.message).toMatch(/permission denied/);
  });

  test("clients cannot write the campaign send mode, draft lease, mailbox status COLUMN or ciphertext, nor insert prospects or replies", async () => {
    for (const [sql, params] of [
      ["update public.email_campaigns set send_mode = 'real' where id = $1", [ids.campA]],
      ["update public.email_campaigns set draft_locked_until = now() where id = $1", [ids.campA]],
      ["update public.email_campaigns set real_enabled_by = $2 where id = $1", [ids.campA, UUID_A]],
      ["update public.mailboxes set status = 'ok' where id = $1", [ids.mbA]],
      ["update public.mailboxes set secret_ciphertext = 'x' where id = $1", [ids.mbA]],
      ["update public.email_prospects set unsub_token = repeat('a', 64) where id = $1", [ids.prosA]],
      ["update public.email_prospects set handed_off_by = $2 where id = $1", [ids.prosA, UUID_A]],
      ["insert into public.email_prospects (workspace_id, campaign_id, company_name) values ($1,$2,'x')", [wsA, ids.campA]],
      ["insert into public.email_replies (workspace_id, from_address, received_at, rfc_message_id) values ($1,'a@b.c',now(),'<z>')", [wsA]],
      ["insert into public.email_approvals (workspace_id, message_id, action) values ($1,$2,'approve')", [wsA, ids.msg2A]],
      ["delete from public.email_approvals where message_id = $1", [ids.msg1A]],
    ] as Array<[string, unknown[]]>) {
      expect((await db.try(as(UUID_A), sql, params)).error?.message, sql).toMatch(/permission denied/);
    }
  });

  test("a client can only move a prospect between active and skipped", async () => {
    expect((await db.try(as(UUID_A), "update public.email_prospects set status = 'replied' where id = $1", [ids.prosA])).error?.message).toMatch(/active and skipped/);
    expect((await db.try(as(UUID_A), "update public.email_prospects set status = 'skipped' where id = $1", [ids.prosA])).error).toBeUndefined();
  });

  test("R2 the daily limit is owner-only and capped at 50", async () => {
    expect((await db.try(as(UUID_A), "update public.mailboxes set daily_limit = 51 where id = $1", [ids.mbA])).error?.message).toMatch(/check constraint/);
    expect(await db.query(as(UUID_C), "update public.mailboxes set daily_limit = 50 where id = $1 returning id", [ids.mbA])).toHaveLength(0);
    expect((await db.try(as(UUID_A), "update public.mailboxes set daily_limit = 50 where id = $1", [ids.mbA])).error).toBeUndefined();
  });

  test("closers cannot read unassigned messages, send, approve or edit", async () => {
    expect((await db.query(as(UUID_D), "select id from public.email_messages where id = $1", [ids.msg1A])).length).toBe(0);
    expect((await db.try(as(UUID_D), "select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')", [ids.msg2A])).error?.message).toMatch(/not allowed/);
    expect((await db.try(as(UUID_D), "select public.claim_next_email($1, gen_random_uuid())", [ids.campA])).error?.message).toMatch(/not allowed/);
    expect(await db.query(as(UUID_D), "update public.email_messages set subject = 'x' where id = $1 returning id", [ids.msg2A])).toHaveLength(0);
  });
});

describe("R18 addresses: found with a source, or typed (manual)", () => {
  test("import keeps the research address only with its source URL; no address stays empty", async () => {
    const withMail = await one<{ email: string; email_source: string; email_source_url: string; contact_name: string; hook: string; evidence: unknown[] }>(
      UUID_A,
      "select email, email_source, email_source_url, contact_name, hook, evidence from public.email_prospects where id = $1",
      [ids.prosA],
    );
    expect(withMail).toMatchObject({ email: "office@acme.example", email_source: "research", email_source_url: "https://acme.example/contact", contact_name: "Pat Doe", hook: "Saw your permit" });
    expect(withMail.evidence).toHaveLength(1);
    const none = await one<{ email: string | null; email_source: string | null }>(UUID_A, "select email, email_source from public.email_prospects where id = $1", [ids.prosNoMailA]);
    expect(none).toEqual({ email: null, email_source: null });
  });

  test("an address typed by a person becomes manual and loses the research URL", async () => {
    const r = await one<{ email: string; email_source: string; email_source_url: string | null }>(
      UUID_A,
      "update public.email_prospects set email = '  New@Acme.Example ' where id = $1 returning email, email_source, email_source_url",
      [ids.prosA],
    );
    expect(r).toEqual({ email: "new@acme.example", email_source: "manual", email_source_url: null });
    await db.admin("update public.email_prospects set email = 'office@acme.example', email_source = 'research', email_source_url = 'https://acme.example/contact' where id = $1", [ids.prosA]);
  });

  test("the database refuses a research address without a source", async () => {
    const r = await db.try({ role: "anon" }, "select 1"); // keep the actor helper honest
    expect(r.error).toBeUndefined();
    await expect(db.admin("update public.email_prospects set email_source_url = null where id = $1", [ids.prosA])).rejects.toThrow(/email_prospects_r18/);
  });
});

describe("message content rules [R4] [R9] [R12]", () => {
  const insert = (subject: string, body: string, step = 1) =>
    db.try(as(UUID_A), "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body) values ($1,$2,$3,'sequence',$4,$5,$6)", [
      wsA,
      ids.campA,
      ids.prosNoMailA,
      step,
      subject,
      body,
    ]);

  test.each(["Re: your project", "RE:hello", "Fwd: info", "FW: x", "[Re] x", "  re : x"])("R4 refuses the deceptive subject %j", async (s) => {
    expect((await insert(s, "Hi")).error?.message).toMatch(/email_messages_r4_subject/);
  });

  test("R4 accepts an honest subject that starts with the letters re", async () => {
    expect((await insert("Regarding your Worcester project", "Hi")).error).toBeUndefined();
  });

  test("R12 refuses links in a sequence body", async () => {
    for (const body of ["See https://x.example", "visit www.acme.com", "http://a.b"]) {
      expect((await insert("Hello", body)).error?.message, body).toMatch(/email_messages_r12_links/);
    }
  });

  test("R9 the same step exists once per prospect", async () => {
    const r = await db.try(as(UUID_A), "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body) values ($1,$2,$3,'sequence',1,'Hello','Hi')", [
      wsA,
      ids.campA,
      ids.prosA,
    ]);
    expect(r.error?.message).toMatch(/email_messages_one_step|duplicate key/);
  });

  test("subjects with line breaks are refused (header injection)", async () => {
    expect((await insert("Hello\r\nBcc: x@y.example", "Hi")).error?.message).toMatch(/email_messages_subject/);
  });

  test("a sender name that could break the From header is refused", async () => {
    expect((await db.try(as(UUID_A), "update public.sender_profiles set sender_name = 'Pat <x@evil.example>' where workspace_id = $1", [wsA])).error?.message).toMatch(/sender_profiles_sender_name/);
  });
});

describe("R1 nothing leaves without a recorded human approval", () => {
  test("a draft is never claimed; once approved it is, with who and when", async () => {
    const { camp, msgs } = await freshCampaign("R1 a", ["r1a@ok.example"]);
    await db.query(as(UUID_A), "select public.set_email_approval($1::uuid[], public.test_versions($1::uuid[]), 'unapprove')", [msgs]);
    expect((await claim(UUID_A, camp)).outcome).toBe("nothing_due");
    await db.query(as(UUID_C), "select public.set_email_approval($1::uuid[], public.test_versions($1::uuid[]), 'approve')", [msgs]);
    const m = await one<{ status: string; approved_by: string; approved_at: Date }>(UUID_A, "select status, approved_by, approved_at from public.email_messages where id = $1", [msgs[0]]);
    expect(m.status).toBe("approved");
    expect(m.approved_by).toBe(UUID_C);
    expect(m.approved_at).toBeTruthy();
    const log = await db.query<{ user_id: string; action: string }>(as(UUID_A), "select user_id, action from public.email_approvals where message_id = $1 order by created_at", [msgs[0]]);
    expect(log.map((l) => l.action)).toEqual(["approve", "unapprove", "approve"]);
    expect(log[2].user_id).toBe(UUID_C);
    const c = await claim(UUID_A, camp);
    expect(c).toMatchObject({ outcome: "claimed", message_id: msgs[0] });
  });

  test("editing an approved message clears its approval", async () => {
    await db.query(as(UUID_A), "select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')", [ids.msg2A]);
    const r = await one<{ status: string; approved_by: string | null; human_edited: boolean }>(
      UUID_A,
      "update public.email_messages set body = 'Hi Pat, edited.' where id = $1 returning status, approved_by, human_edited",
      [ids.msg2A],
    );
    expect(r).toEqual({ status: "draft", approved_by: null, human_edited: true });
  });

  test("a sent message cannot be edited, and a rehearsal can never be reported as really sent", async () => {
    await endCompanyDay(db);   // earlier tests already claimed for this research company today (company rule is live); their log rows move back 2 days
    const { camp, msgs } = await freshCampaign("R1 b", ["r1b@ok.example"]);
    await ageClaims(400);
    expect((await claim(UUID_A, camp)).outcome).toBe("claimed");
    expect((await db.try(as(UUID_A), "select public.finish_email_send($1,$2,'sent',null)", [msgs[0], "11111111-1111-4111-8111-111111111111"])).error?.message).toMatch(/send mode/);
    await finish(UUID_A, msgs[0], "dry_run");
    expect((await db.try(as(UUID_A), "update public.email_messages set body = 'x' where id = $1", [msgs[0]])).error?.message).toMatch(/cannot be edited/);
    // and the database itself refuses a sent row without a stamp
    await expect(db.admin("update public.email_messages set approved_by = null where id = $1", [msgs[0]])).rejects.toThrow(/email_messages_r1/);
  });

  test("the result can only be reported by the holder of the claim", async () => {
    await endCompanyDay(db);   // earlier tests already claimed for this research company today (company rule is live); their log rows move back 2 days
    const { camp, msgs } = await freshCampaign("R1 c", ["r1c@ok.example"]);
    await ageClaims(400);
    expect((await claim(UUID_A, camp, "22222222-2222-4222-8222-222222222222")).outcome).toBe("claimed");
    expect((await db.try(as(UUID_A), "select public.finish_email_send($1,$2,'dry_run',null)", [msgs[0], "33333333-3333-4333-8333-333333333333"])).error?.message).toMatch(/not claimed by this holder/);
    await finish(UUID_A, msgs[0], "dry_run", "22222222-2222-4222-8222-222222222222");
  });
});

describe("R3 suppression is checked inside the claim; R5 a reply stops the sequence, a domain stops the company", () => {
  test("a suppressed address is never claimed; its message is cancelled and the prospect stopped", async () => {
    const { camp, msgs } = await freshCampaign("R3 a", ["stop-me@ok.example"]);
    await db.query(as(UUID_C), "insert into public.suppressions (workspace_id, kind, value, reason) values ($1,'address','STOP-ME@ok.example','manual')", [wsA]);
    await ageClaims(400);
    expect((await claim(UUID_A, camp)).outcome).toBe("nothing_due");
    const m = await one<{ status: string; cancel_reason: string }>(UUID_A, "select status, cancel_reason from public.email_messages where id = $1", [msgs[0]]);
    expect(m).toEqual({ status: "cancelled", cancel_reason: "suppressed" });
  });

  test("a suppressed domain (and its subdomains) blocks too", async () => {
    const { camp } = await freshCampaign("R3 b", ["a@mail.blocked.example"]);
    await ageClaims(400);
    expect((await claim(UUID_A, camp)).outcome).toBe("nothing_due");
  });

  test("removing a suppression is owner-only", async () => {
    const s = await one<{ id: string }>(UUID_C, "insert into public.suppressions (workspace_id, kind, value, reason) values ($1,'address','keep@x.example','manual') returning id", [wsA]);
    expect(await db.query(as(UUID_C), "delete from public.suppressions where id = $1 returning id", [s.id])).toHaveLength(0);
    expect(await db.query(as(UUID_A), "delete from public.suppressions where id = $1 returning id", [s.id])).toHaveLength(1);
  });

  test("created_by of a suppression cannot be forged", async () => {
    const r = await db.try(as(UUID_C), "insert into public.suppressions (workspace_id, kind, value, reason, created_by) values ($1,'address','f@x.example','manual',$2)", [wsA, UUID_A]);
    expect(r.error?.message).toMatch(/permission denied/);
  });

  test("a reply stops the remaining steps; a bounce also suppresses the address", async () => {
    const { camp, msgs } = await freshCampaign("R3 c", ["replier@ok.example", "bouncer@ok.example"]);
    const ps = await db.query<{ id: string; email: string }>(as(UUID_A), "select id, email from public.email_prospects where campaign_id = $1 order by email desc", [camp]);
    const replier = ps.find((p) => p.email === "replier@ok.example")!.id;
    const bouncer = ps.find((p) => p.email === "bouncer@ok.example")!.id;
    await db.query(as(UUID_A), "select public.record_email_reply($1,$2,null,'replier@ok.example','Re: Hello there','Call me','<r1@ok.example>',now(),'reply',null)", [replier, ids.mbA]);
    await db.query(as(UUID_A), "select public.record_email_reply($1,$2,null,'mailer-daemon@googlemail.com','Delivery Status Notification','failed','<b1@ok.example>',now(),'bounce',null)", [bouncer, ids.mbA]);
    const statuses = await db.query<{ status: string; cancel_reason: string }>(as(UUID_A), "select status, cancel_reason from public.email_messages where id = any($1) order by cancel_reason", [msgs]);
    expect(statuses).toEqual([
      { status: "cancelled", cancel_reason: "bounced" },
      { status: "cancelled", cancel_reason: "replied" },
    ]);
    const sup = await db.query(as(UUID_A), "select reason from public.suppressions where workspace_id = $1 and value = 'bouncer@ok.example'", [wsA]);
    expect(sup).toEqual([{ reason: "bounced" }]);
    // the same message stored twice is ignored
    const again = await one<{ record_email_reply: string | null }>(UUID_A, "select public.record_email_reply($1,$2,null,'replier@ok.example','Re','x','<r1@ok.example>',now(),'reply',null)", [replier, ids.mbA]);
    expect(again.record_email_reply).toBeNull();
  });

  test("an 'unsubscribe' label suppresses the address and stops the prospect (the safe direction)", async () => {
    const { camp } = await freshCampaign("R3 d", ["unsub-reply@ok.example"]);
    const p = await one<{ id: string }>(UUID_A, "select id from public.email_prospects where campaign_id = $1 and email = 'unsub-reply@ok.example'", [camp]);
    const r = await one<{ record_email_reply: string }>(UUID_A, "select public.record_email_reply($1,$2,null,'unsub-reply@ok.example','Re','please remove me','<u1@ok.example>',now(),'reply',null)", [p.id, ids.mbA]);
    await db.query(as(UUID_A), "select public.set_reply_class($1,'unsubscribe','ai','pediu para sair','claude-haiku-5-5')", [r.record_email_reply]);
    expect(await db.query(as(UUID_A), "select reason from public.suppressions where workspace_id = $1 and value = 'unsub-reply@ok.example'", [wsA])).toEqual([{ reason: "asked_to_stop" }]);
    expect((await one<{ status: string }>(UUID_A, "select status from public.email_prospects where id = $1", [p.id])).status).toBe("stopped");
  });
});

describe("R2 daily limit and gap, counted inside the atomic claim", () => {
  test("a second claim inside the 9 + 5 min gap (540-840 s by default) waits; after the gap it goes", async () => {
    await endCompanyDay(db);   // earlier tests already claimed for this research company today (company rule is live); their log rows move back 2 days
    const { camp, msgs } = await freshCampaign("R2 gap", ["g1@ok.example", "g2@ok.example"]);
    await db.admin("update public.email_campaigns set min_gap_minutes = 9, random_gap_minutes = 5 where id = $1", [camp]);
    await ageClaims(400);
    // creation order is the final claim tie-break (email_messages.seq): the first-created message goes first
    const first = await claim(UUID_A, camp);
    expect(first.outcome).toBe("claimed");
    expect(first.message_id).toBe(msgs[0]);
    const second = msgs[1];
    await finish(UUID_A, first.message_id!, "dry_run");
    const g = await one<{ next_gap_seconds: number }>(UUID_A, "select next_gap_seconds from public.email_messages where id = $1", [first.message_id]);
    expect(g.next_gap_seconds).toBeGreaterThanOrEqual(540);
    expect(g.next_gap_seconds).toBeLessThanOrEqual(840);
    const wait = await claim(UUID_A, camp);
    expect(wait.outcome).toBe("gap");
    expect(new Date(wait.wait_until!).getTime()).toBeGreaterThan(Date.now());
    await ageClaims(841);
    const next = await claim(UUID_A, camp);
    expect(next.outcome).toBe("claimed");
    expect(next.message_id).toBe(second);
    await finish(UUID_A, second, "dry_run");
    await ageClaims(841);
  });

  test("claims are serialised: three claims in a row (as two tabs would send) leave one claimed, two inside the gap [PGlite has one connection: this proves serialisation, not true parallelism]", async () => {
    await endCompanyDay(db);   // earlier tests already claimed for this research company today (company rule is live); their log rows move back 2 days
    const { camp } = await freshCampaign("R2 tabs", ["t1@ok.example", "t2@ok.example", "t3@ok.example"]);
    await ageClaims(400);
    const results = await Promise.all([1, 2, 3].map((i) => claim(UUID_A, camp, `4444444${i}-4444-4444-8444-444444444444`)));
    expect(results.filter((r) => r.outcome === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "gap")).toHaveLength(2);
  });

  test("the daily limit (calendar day in the campaign's time zone, per sending address) is never exceeded, even by recreating the mailbox", async () => {
    await db.query(as(UUID_A), "update public.mailboxes set daily_limit = 2 where id = $1", [ids.mbA]);
    await ageClaims(2 * 86_400);
    const { camp } = await freshCampaign("R2 limit", ["l1@ok.example", "l2@ok.example", "l3@ok.example"]);
    // no gap in this test: the limit is what is under test, and no claim has to be aged (ageing across local midnight would change the count)
    await db.admin("update public.email_campaigns set min_gap_minutes = 0, random_gap_minutes = 0 where id = $1", [camp]);
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await claim(UUID_A, camp);
      outcomes.push(c.outcome);
      if (c.outcome === "daily_limit") {
        expect(new Date(c.wait_until!).toISOString()).toBe(new Date((await db.admin<{ e: Date }>("select public.local_day_end('America/New_York', now()) as e"))[0].e).toISOString());
      }
      if (c.message_id) await finish(UUID_A, c.message_id, "dry_run");
    }
    expect(outcomes).toEqual(["claimed", "claimed", "daily_limit"]);
    const usage = await one<{ mailbox_usage: { dry_run: number; limit: number } }>(UUID_A, "select public.mailbox_usage($1)", [ids.mbA]);
    expect(usage.mailbox_usage).toMatchObject({ dry_run: 2, limit: 2 });
    // remove and re-add the same address: the count follows the address, not the row
    const email = (await one<{ email: string }>(UUID_A, "select email from public.mailboxes where id = $1", [ids.mbA])).email;
    await db.query(as(UUID_A), "delete from public.mailboxes where id = $1", [ids.mbA]);
    ids.mbA = (await one<{ save_mailbox: string }>(UUID_A, "select public.save_mailbox($1,$2,$3)", [wsA, email, CIPHER])).save_mailbox;
    await db.query(as(UUID_A), "update public.mailboxes set daily_limit = 2 where id = $1", [ids.mbA]);
    await db.query(as(UUID_A), "update public.email_campaigns set mailbox_id = $2 where id = $1", [camp, ids.mbA]);
    expect((await claim(UUID_A, camp)).outcome).toBe("daily_limit");
    await db.query(as(UUID_A), "update public.mailboxes set daily_limit = 30 where id = $1", [ids.mbA]);
    await db.query(as(UUID_A), "select public.set_mailbox_verified($1, true, null)", [ids.mbA]);
    await ageClaims(2 * 86_400);
  });
});

describe("R4 sender identity and the switch to real sending", () => {
  test("no claim (rehearsal or real) without legal name, postal address and sender name", async () => {
    const { camp } = await freshCampaign("R4 a", ["p1@ok.example"]);
    await db.query(as(UUID_A), "update public.sender_profiles set postal_address = '' where workspace_id = $1", [wsA]);
    expect((await claim(UUID_A, camp)).outcome).toBe("no_sender_profile");
    await db.query(as(UUID_A), "update public.sender_profiles set postal_address = '1 Main St, Millbury, MA 01527' where workspace_id = $1", [wsA]);
  });

  test("a campaign starts in rehearsal; only an owner switches to real, and only with a verified mailbox and full profile", async () => {
    const { camp } = await freshCampaign("R4 b", ["p2@ok.example"]);
    expect((await one<{ send_mode: string }>(UUID_A, "select send_mode from public.email_campaigns where id = $1", [camp])).send_mode).toBe("dry_run");
    expect((await db.try(as(UUID_C), "select public.set_campaign_send_mode($1,'real')", [camp])).error?.message).toMatch(/only an owner/);
    await db.query(as(UUID_A), "select public.set_mailbox_verified($1, false, 'auth failed')", [ids.mbA]);
    expect((await db.try(as(UUID_A), "select public.set_campaign_send_mode($1,'real')", [camp])).error?.message).toMatch(/verified mailbox/);
    await db.query(as(UUID_A), "update public.sender_profiles set legal_name = '' where workspace_id = $1", [wsA]);
    await db.query(as(UUID_A), "select public.set_mailbox_verified($1, true, null)", [ids.mbA]);
    expect((await db.try(as(UUID_A), "select public.set_campaign_send_mode($1,'real')", [camp])).error?.message).toMatch(/postal address/);
    await db.query(as(UUID_A), "update public.sender_profiles set legal_name = 'Acme HVAC Corp' where workspace_id = $1", [wsA]);
    await db.query(as(UUID_A), "select public.set_campaign_send_mode($1,'real')", [camp]);
    const c = await one<{ send_mode: string; real_enabled_by: string }>(UUID_A, "select send_mode, real_enabled_by from public.email_campaigns where id = $1", [camp]);
    expect(c).toEqual({ send_mode: "real", real_enabled_by: UUID_A });

    // a real claim needs the mailbox still verified; the claim is stamped 'real' and can only end as 'sent'
    await db.query(as(UUID_A), "select public.set_mailbox_verified($1, false, 'x')", [ids.mbA]);
    expect((await claim(UUID_A, camp)).outcome).toBe("mailbox_not_verified");
    await db.query(as(UUID_A), "select public.set_mailbox_verified($1, true, null)", [ids.mbA]);
    const got = await claim(UUID_A, camp);
    expect(got.outcome).toBe("claimed");
    expect((await db.try(as(UUID_A), "select public.finish_email_send($1,$2,'dry_run',null)", [got.message_id, "11111111-1111-4111-8111-111111111111"])).error?.message).toMatch(/send mode/);
    await finish(UUID_A, got.message_id!, "sent");
    const sent = await one<{ send_mode: string; status: string; rfc_message_id: string }>(UUID_A, "select send_mode, status, rfc_message_id from public.email_messages where id = $1", [got.message_id]);
    expect(sent.send_mode).toBe("real");
    expect(sent.status).toBe("sent");
    expect(sent.rfc_message_id).toMatch(/^<[0-9a-f]{32}@gmail\.com>$/);
    // switching the mailbox drops back to rehearsal; going back to rehearsal is always allowed
    await db.query(as(UUID_C), "select public.set_campaign_send_mode($1,'dry_run')", [camp]);
    expect((await one<{ send_mode: string }>(UUID_A, "select send_mode from public.email_campaigns where id = $1", [camp])).send_mode).toBe("dry_run");
    await ageClaims(2 * 86_400);
  });

  test("a paused or draft campaign claims nothing", async () => {
    const { camp } = await freshCampaign("R4 c", ["p3@ok.example"]);
    await db.query(as(UUID_A), "update public.email_campaigns set status = 'paused' where id = $1", [camp]);
    expect((await claim(UUID_A, camp)).outcome).toBe("not_active");
    expect((await db.try(as(UUID_A), "update public.email_campaigns set status = 'draft' where id = $1", [camp])).error?.message).toMatch(/invalid campaign status/);
  });
});

describe("sequence scheduling and idempotence [R9]", () => {
  test("add_business_days skips weekends", async () => {
    const r = await one<{ fri1: Date; fri3: Date; thu7: Date }>(
      UUID_A,
      "select public.add_business_days('2026-11-13T15:00:00Z', 1) as fri1, public.add_business_days('2026-11-13T15:00:00Z', 3) as fri3, public.add_business_days('2026-11-12T10:00:00Z', 7) as thu7",
    );
    expect(new Date(r.fri1).toISOString()).toBe("2026-11-16T15:00:00.000Z");
    expect(new Date(r.fri3).toISOString()).toBe("2026-11-18T15:00:00.000Z");
    expect(new Date(r.thu7).toISOString()).toBe("2026-11-23T10:00:00.000Z");
  });

  test("sending step 1 schedules steps 2 and 3; a claimed message is never claimed again", async () => {
    await db.query(as(UUID_A), "update public.email_campaigns set status = 'active', mailbox_id = $2 where id = $1", [ids.campA, ids.mbA]);
    await db.query(as(UUID_A), "update public.email_prospects set status = 'active' where id = $1", [ids.prosA]);
    await db.query(as(UUID_A), "select public.set_email_approval($1::uuid[], public.test_versions($1::uuid[]), 'approve')", [[ids.msg1A, ids.msg2A, ids.msg3A]]);
    const c = await claim(UUID_A, ids.campA);
    expect(c).toMatchObject({ outcome: "claimed", message_id: ids.msg1A });
    await finish(UUID_A, ids.msg1A, "dry_run");
    const due = await db.query<{ step: number; due_ok: boolean }>(
      as(UUID_A),
      `select step, due_at = public.add_business_days(m1.sent_at, case step when 2 then 3 else 7 end) as due_ok
         from public.email_messages, (select sent_at from public.email_messages where id = $1) m1
        where prospect_id = $2 and step in (2, 3) order by step`,
      [ids.msg1A, ids.prosA],
    );
    expect(due).toEqual([
      { step: 2, due_ok: true },
      { step: 3, due_ok: true },
    ]);
    await ageClaims(400);
    expect((await claim(UUID_A, ids.campA)).outcome).toBe("nothing_due"); // step 2 is days away; step 1 is done
  });

  test("a claim that never reported back becomes failed (never resent automatically)", async () => {
    await endCompanyDay(db);   // earlier tests already claimed for this research company today (company rule is live); their log rows move back 2 days
    const { camp, msgs } = await freshCampaign("R9 stale", ["stale@ok.example"]);
    await ageClaims(400);
    expect((await claim(UUID_A, camp)).outcome).toBe("claimed");
    await db.admin("update public.email_messages set claim_expires_at = now() - interval '1 second' where id = $1", [msgs[0]]);
    await ageClaims(400);
    expect((await claim(UUID_A, camp)).outcome).toBe("nothing_due");
    expect((await one<{ status: string }>(UUID_A, "select status from public.email_messages where id = $1", [msgs[0]])).status).toBe("failed");
    await db.query(as(UUID_A), "select public.retry_failed_email($1)", [msgs[0]]);
    expect((await claim(UUID_A, camp)).outcome).toBe("claimed");
  });
});

describe("hand-off and draft lease", () => {
  test("hand-off stamps who and when and stops the remaining steps", async () => {
    const { camp, msgs } = await freshCampaign("handoff", ["closer@ok.example"]);
    const p = await one<{ id: string }>(UUID_A, "select id from public.email_prospects where campaign_id = $1 and email = 'closer@ok.example'", [camp]);
    await db.query(as(UUID_C), "select public.hand_off_prospect($1)", [p.id]);
    const r = await one<{ status: string; handed_off_by: string; handed_off_at: Date }>(UUID_A, "select status, handed_off_by, handed_off_at from public.email_prospects where id = $1", [p.id]);
    expect(r.status).toBe("handed_off");
    expect(r.handed_off_by).toBe(UUID_C);
    expect((await one<{ status: string }>(UUID_A, "select status from public.email_messages where id = $1", [msgs[0]])).status).toBe("cancelled");
  });

  test("the draft lease lets one holder at a time", async () => {
    const h1 = "55555555-5555-4555-8555-555555555555";
    const h2 = "66666666-6666-4666-8666-666666666666";
    expect((await one<{ claim_campaign_draft: boolean }>(UUID_A, "select public.claim_campaign_draft($1,$2,60)", [ids.campA, h1])).claim_campaign_draft).toBe(true);
    expect((await one<{ claim_campaign_draft: boolean }>(UUID_C, "select public.claim_campaign_draft($1,$2,60)", [ids.campA, h2])).claim_campaign_draft).toBe(false);
    await db.query(as(UUID_A), "select public.release_campaign_draft($1,$2)", [ids.campA, h1]);
    expect((await one<{ claim_campaign_draft: boolean }>(UUID_C, "select public.claim_campaign_draft($1,$2,60)", [ids.campA, h2])).claim_campaign_draft).toBe(true);
    await db.query(as(UUID_C), "select public.release_campaign_draft($1,$2)", [ids.campA, h2]);
  });
});

describe("public unsubscribe by token (logged out) [R3] [R4] [R14]", () => {
  test("works as anon, is idempotent, and returns only a boolean", async () => {
    const { camp, msgs } = await freshCampaign("unsub", ["leave@ok.example"]);
    const p = await one<{ id: string; unsub_token: string }>(UUID_A, "select id, unsub_token from public.email_prospects where campaign_id = $1 and email = 'leave@ok.example'", [camp]);
    expect(p.unsub_token).toMatch(/^[0-9a-f]{64}$/);
    for (let i = 0; i < 2; i++) {
      const r = await db.query<{ unsubscribe_by_token: boolean }>(anon, "select public.unsubscribe_by_token($1)", [p.unsub_token]);
      expect(r).toEqual([{ unsubscribe_by_token: true }]);
    }
    expect(await db.query(as(UUID_A), "select reason from public.suppressions where workspace_id = $1 and value = 'leave@ok.example'", [wsA])).toEqual([{ reason: "unsubscribed" }]);
    expect((await one<{ status: string }>(UUID_A, "select status from public.email_messages where id = $1", [msgs[0]])).status).toBe("cancelled");
    expect((await one<{ status: string; stop_reason: string }>(UUID_A, "select status, stop_reason from public.email_prospects where id = $1", [p.id]))).toEqual({ status: "stopped", stop_reason: "unsubscribed" });
  });

  test("a wrong or malformed token does nothing and reveals nothing", async () => {
    for (const token of ["a".repeat(64), "not-a-token", "", "' or 1=1 --"]) {
      expect(await db.query(anon, "select public.unsubscribe_by_token($1)", [token])).toEqual([{ unsubscribe_by_token: false }]);
    }
  });

  test("anon still cannot read prospects, tokens or suppressions", async () => {
    for (const sql of ["select unsub_token from public.email_prospects", "select value from public.suppressions", "select public.is_suppressed($1, 'leave@ok.example')"]) {
      expect((await db.try(anon, sql, sql.includes("$1") ? [wsA] : [])).error?.message, sql).toMatch(/permission denied/);
    }
  });

  test("the unsubscribe function runs with an empty search_path as SECURITY DEFINER", async () => {
    const r = await db.admin<{ prosecdef: boolean; proconfig: string[] }>("select prosecdef, proconfig from pg_proc where proname = 'unsubscribe_by_token'");
    expect(r[0].prosecdef).toBe(true);
    expect(r[0].proconfig).toContain('search_path=""');
  });
});

// ================================================================ review findings (rehearsal->real, deletion, address, R2, DSN, bulk)
/** A campaign with one prospect and its 3 sequence steps, all approved (step 1 due now). */
async function seqCampaign(name: string, email: string) {
  const { camp, msgs } = await freshCampaign(name, [email]);
  const prospect = (await one<{ id: string }>(UUID_A, "select prospect_id as id from public.email_messages where id = $1", [msgs[0]])).id;
  const steps = [msgs[0]];
  for (const step of [2, 3]) {
    steps.push(
      (
        await one<{ id: string }>(
          UUID_A,
          "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body) values ($1,$2,$3,'sequence',$4,$5,'Following up.') returning id",
          [wsA, camp, prospect, step, `Step ${step}`],
        )
      ).id,
    );
  }
  await db.query(as(UUID_A), "select public.set_email_approval($1::uuid[], public.test_versions($1::uuid[]), 'approve')", [steps.slice(1)]);
  return { camp, prospect, steps };
}
const dueNow = (id: string) => db.admin("update public.email_messages set due_at = now() - interval '1 minute' where id = $1", [id]);
const statusOf = async (table: "email_messages" | "email_prospects", id: string) => (await one<{ status: string }>(UUID_A, `select status from public.${table} where id = $1`, [id])).status;
const setMode = (camp: string, mode: "real" | "dry_run") => db.query(as(UUID_A), "select public.set_campaign_send_mode($1,$2)", [camp, mode]);
const usage = async () => (await one<{ mailbox_usage: { real: number; dry_run: number; test: number } }>(UUID_A, "select public.mailbox_usage($1)", [ids.mbA])).mailbox_usage;

describe("[R1][R4] rehearsal -> real resets the rehearsal trail", () => {
  beforeAll(async () => {
    await db.query(as(UUID_A), "select public.set_mailbox_verified($1, true, null)", [ids.mbA]);
    await ageClaims(2 * 86_400);
  });

  test("step 2 never goes out for real before step 1 really went out", async () => {
    const { camp, steps } = await seqCampaign("RR a", "rr-a@ok.example");
    await ageClaims(400);
    expect((await claim(UUID_A, camp)).message_id).toBe(steps[0]);
    await finish(UUID_A, steps[0], "dry_run");
    await dueNow(steps[1]);
    await ageClaims(400);
    expect((await claim(UUID_A, camp)).message_id).toBe(steps[1]); // in rehearsal a rehearsed step 1 is enough
    await finish(UUID_A, steps[1], "dry_run");

    await setMode(camp, "real");
    const after = await db.query<{ status: string; due_at: Date | null; to_address: string | null; claimed_at: Date | null; rfc_message_id: string | null; approved_by: string }>(
      as(UUID_A),
      "select status, due_at, to_address, claimed_at, rfc_message_id, approved_by from public.email_messages where id = any($1) order by step",
      [steps],
    );
    expect(after.map((r) => r.status)).toEqual(["approved", "approved", "approved"]); // text and address unchanged: approval kept
    expect(after[0].due_at).toBeTruthy();
    expect([after[1].due_at, after[2].due_at]).toEqual([null, null]); // only once step 1 really went out
    expect(after.every((r) => r.to_address === null && r.claimed_at === null && r.rfc_message_id === null && r.approved_by === UUID_A)).toBe(true);

    await dueNow(steps[1]); // even forced due, step 2 waits for a REAL step 1
    await ageClaims(400);
    expect((await claim(UUID_A, camp)).message_id).toBe(steps[0]);
    await ageClaims(400);
    expect((await claim(UUID_A, camp)).outcome).toBe("nothing_due"); // step 1 is only 'sending', not sent
    await finish(UUID_A, steps[0], "sent");
    await ageClaims(400);
    expect((await claim(UUID_A, camp)).outcome).toBe("nothing_due"); // step 2 now scheduled in business days
    await dueNow(steps[1]);
    expect((await claim(UUID_A, camp)).message_id).toBe(steps[1]);
    await finish(UUID_A, steps[1], "sent");
    await setMode(camp, "dry_run");
    await ageClaims(2 * 86_400);
  });

  test("a prospect that rehearsal finished (done) is active again in real and gets step 1", async () => {
    const { camp, prospect, steps } = await seqCampaign("RR b", "rr-b@ok.example");
    for (const [i, id] of steps.entries()) {
      if (i) await dueNow(id);
      await ageClaims(400);
      expect((await claim(UUID_A, camp)).message_id).toBe(id);
      await finish(UUID_A, id, "dry_run");
    }
    expect(await statusOf("email_prospects", prospect)).toBe("done");
    await setMode(camp, "real");
    expect(await statusOf("email_prospects", prospect)).toBe("active");
    await ageClaims(400);
    expect((await claim(UUID_A, camp)).message_id).toBe(steps[0]);
    await finish(UUID_A, steps[0], "sent");
    await setMode(camp, "dry_run");
    await ageClaims(2 * 86_400);
  });

  test("a rehearsed message whose address changed since its approval goes back to draft", async () => {
    const { camp, prospect, steps } = await seqCampaign("RR c", "rr-c@ok.example");
    await ageClaims(400);
    await claim(UUID_A, camp);
    await finish(UUID_A, steps[0], "dry_run");
    await db.query(as(UUID_A), "update public.email_prospects set email = 'rr-c2@ok.example' where id = $1", [prospect]);
    await setMode(camp, "real");
    expect(await statusOf("email_messages", steps[0])).toBe("draft");
    await ageClaims(400);
    expect((await claim(UUID_A, camp)).outcome).toBe("nothing_due");
    await setMode(camp, "dry_run");
  });

  test("the confirmation text of the switch says the rehearsal goes back to the queue", async () => {
    const { email } = await import("@/messages/pt/email");
    expect(email.campaign.goRealConfirm).toMatch(/voltam para a fila/);
  });
});

describe("[R2][R3][R4] deleting or archiving a campaign keeps links, counters and the approval audit", () => {
  test("a campaign that claimed anything cannot be deleted; archive it; unsubscribe and counters survive even a forced delete", async () => {
    await ageClaims(2 * 86_400);
    const { camp, msgs } = await freshCampaign("Arch", ["arch@ok.example"]);
    const token = (await one<{ unsub_token: string }>(UUID_A, "select p.unsub_token from public.email_prospects p join public.email_messages m on m.prospect_id = p.id where m.id = $1", [msgs[0]])).unsub_token;
    await ageClaims(400);
    expect((await claim(UUID_A, camp)).outcome).toBe("claimed");
    await finish(UUID_A, msgs[0], "dry_run");
    const before = await usage();

    expect((await db.try(as(UUID_A), "delete from public.email_campaigns where id = $1", [camp])).error?.message).toMatch(/archive it instead/);
    expect(await db.query(as(UUID_C), "delete from public.email_campaigns where id = $1 returning id", [camp])).toHaveLength(0); // owner-only
    await db.query(as(UUID_A), "update public.email_campaigns set status = 'archived' where id = $1", [camp]);
    expect((await claim(UUID_A, camp)).outcome).toBe("not_active");
    expect((await db.try(as(UUID_A), "update public.email_campaigns set status = 'active' where id = $1", [camp])).error?.message).toMatch(/invalid campaign status/);
    expect((await db.try(as(UUID_A), "select public.set_campaign_send_mode($1,'real')", [camp])).error?.message).toMatch(/archived/);

    // a campaign that never claimed anything can still be deleted
    const empty = await one<{ id: string }>(UUID_A, "insert into public.email_campaigns (workspace_id, name, mailbox_id) values ($1,'Vazia',$2) returning id", [wsA, ids.mbA]);
    expect(await db.query(as(UUID_A), "delete from public.email_campaigns where id = $1 returning id", [empty.id])).toHaveLength(1);

    // even a forced (superuser) delete leaves the send log, the approvals and the mailed token
    await db.pg.exec("alter table public.email_campaigns disable trigger guard_email_campaign_delete");
    await db.admin("delete from public.email_campaigns where id = $1", [camp]);
    await db.pg.exec("alter table public.email_campaigns enable trigger guard_email_campaign_delete");
    expect(await db.admin("select 1 from public.email_messages where id = $1", [msgs[0]])).toHaveLength(0);
    expect(await db.query(as(UUID_A), "select action from public.email_approvals where message_id = $1", [msgs[0]])).toEqual([{ action: "approve" }]);
    expect((await db.query(as(UUID_A), "select result from public.email_send_log where message_id = $1", [msgs[0]]))).toEqual([{ result: "dry_run" }]);
    expect(await usage()).toEqual(before);
    expect(await db.query(anon, "select public.unsubscribe_by_token($1)", [token])).toEqual([{ unsubscribe_by_token: true }]);
    expect(await db.query(as(UUID_A), "select reason from public.suppressions where workspace_id = $1 and value = 'arch@ok.example'", [wsA])).toEqual([{ reason: "unsubscribed" }]);
  });
});

describe("[R1][R3] the approved address", () => {
  test("changing the address returns approvals to draft; the claim never sends to an unapproved address; unsubscribe suppresses every mailed address", async () => {
    await ageClaims(400);
    const { camp, msgs } = await freshCampaign("Addr", ["old@ok.example"]);
    const p = await one<{ id: string; unsub_token: string }>(UUID_A, "select p.id, p.unsub_token from public.email_prospects p join public.email_messages m on m.prospect_id = p.id where m.id = $1", [msgs[0]]);
    expect((await one<{ approved_to: string }>(UUID_A, "select approved_to from public.email_messages where id = $1", [msgs[0]])).approved_to).toBe("old@ok.example");
    expect((await claim(UUID_A, camp)).message_id).toBe(msgs[0]);
    await finish(UUID_A, msgs[0], "dry_run");
    const s2 = await one<{ id: string }>(UUID_A, "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body) values ($1,$2,$3,'sequence',2,'Step two','Following up.') returning id", [wsA, camp, p.id]);
    await db.query(as(UUID_A), "select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')", [s2.id]);

    await db.query(as(UUID_C), "update public.email_prospects set email = 'new@ok.example' where id = $1", [p.id]);
    const m2 = await one<{ status: string; approved_to: string | null }>(UUID_A, "select status, approved_to from public.email_messages where id = $1", [s2.id]);
    expect(m2).toEqual({ status: "draft", approved_to: null });
    const log = await db.query<{ action: string; user_id: string }>(as(UUID_A), "select action, user_id from public.email_approvals where message_id = $1 order by created_at", [s2.id]);
    expect(log.map((l) => l.action)).toEqual(["approve", "unapprove"]);
    expect(log[1].user_id).toBe(UUID_C);
    expect((await one<{ email_source: string; email_confirmed_by: string }>(UUID_A, "select email_source, email_confirmed_by from public.email_prospects where id = $1", [p.id]))).toEqual({ email_source: "manual", email_confirmed_by: UUID_C });

    // approved again for the new address; an address changed behind the trigger's back is never mailed
    await db.query(as(UUID_A), "select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')", [s2.id]);
    await dueNow(s2.id);
    await db.admin("update public.email_prospects set email = 'other@ok.example' where id = $1", [p.id]);
    await ageClaims(400);
    expect((await claim(UUID_A, camp)).outcome).toBe("nothing_due");
    await db.admin("update public.email_prospects set email = 'new@ok.example' where id = $1", [p.id]);
    expect((await claim(UUID_A, camp)).message_id).toBe(s2.id);
    expect((await one<{ to_address: string }>(UUID_A, "select to_address from public.email_messages where id = $1", [s2.id])).to_address).toBe("new@ok.example");
    await finish(UUID_A, s2.id, "dry_run");
    await expect(db.admin("update public.email_messages set to_address = 'x@evil.example' where id = $1", [s2.id])).rejects.toThrow(/email_messages_r1_address/);

    expect(await db.query(anon, "select public.unsubscribe_by_token($1)", [p.unsub_token])).toEqual([{ unsubscribe_by_token: true }]);
    const sup = await db.query<{ value: string }>(as(UUID_A), "select value from public.suppressions where workspace_id = $1 and value in ('old@ok.example','new@ok.example') order by value", [wsA]);
    expect(sup.map((x) => x.value)).toEqual(["new@ok.example", "old@ok.example"]);
  });

  test("an answer to a reply goes to the replier of the prospect's domain, and can be sent after the campaign was archived", async () => {
    await endCompanyDay(db);   // earlier tests already claimed for this research company today (company rule is live); their log rows move back 2 days
    await ageClaims(400);
    const { camp, msgs } = await freshCampaign("Ans", ["pat@answer.example"]);
    const p = (await one<{ id: string }>(UUID_A, "select prospect_id as id from public.email_messages where id = $1", [msgs[0]])).id;
    await claim(UUID_A, camp);
    await finish(UUID_A, msgs[0], "dry_run");
    const reply = (await one<{ r: string }>(UUID_A, "select public.record_email_reply($1,$2,$3,'jo@answer.example','Re: Hello there','Call Jo instead','<ans1@answer.example>',now(),'reply',null) as r", [p, ids.mbA, msgs[0]])).r;
    const stranger = (await one<{ r: string }>(UUID_A, "select public.record_email_reply($1,$2,null,'x@else.example','Re: Hello there','me too','<ans2@else.example>',now(),'reply',null) as r", [p, ids.mbA])).r;
    const answer = async (replyId: string) =>
      (await one<{ id: string }>(UUID_A, "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, reply_to_id, subject, body) values ($1,$2,$3,'reply',$4,'Re: Hello there','Hi, sure.') returning id", [wsA, camp, p, replyId])).id;
    const a1 = await answer(reply);
    const a2 = await answer(stranger);
    await db.query(as(UUID_A), "select public.set_email_approval($1::uuid[], public.test_versions($1::uuid[]), 'approve')", [[a1, a2]]);
    const to = await db.query<{ id: string; approved_to: string }>(as(UUID_A), "select id, approved_to from public.email_messages where id = any($1)", [[a1, a2]]);
    expect(to.find((x) => x.id === a1)?.approved_to).toBe("jo@answer.example");
    expect(to.find((x) => x.id === a2)?.approved_to).toBe("pat@answer.example");

    await db.query(as(UUID_A), "update public.email_campaigns set status = 'archived' where id = $1", [camp]);
    await ageClaims(400);
    expect((await claim(UUID_A, camp)).outcome).toBe("not_active");
    const c = (await one<{ r: { outcome: string; message_id: string } }>(UUID_A, "select public.claim_next_email($1, '11111111-1111-4111-8111-111111111111', $2) as r", [camp, a1])).r;
    expect(c).toMatchObject({ outcome: "claimed", message_id: a1 });
    expect((await one<{ to_address: string }>(UUID_A, "select to_address from public.email_messages where id = $1", [a1])).to_address).toBe("jo@answer.example");
    await finish(UUID_A, a1, "dry_run");
    // a due, approved sequence step is never claimable through the answer path
    const other = await freshCampaign("Ans seq", ["seq-path@ok.example"]);
    await endCompanyDay(db);   // same research company as the claim above, in another campaign
    await ageClaims(400);
    expect((await one<{ r: { outcome: string } }>(UUID_A, "select public.claim_next_email($1, gen_random_uuid(), $2) as r", [other.camp, other.msgs[0]])).r.outcome).toBe("nothing_due");
    expect((await claim(UUID_A, other.camp)).message_id).toBe(other.msgs[0]);
    await finish(UUID_A, other.msgs[0], "dry_run");
  });
});

describe("[R1] approval refers to the version on the screen", () => {
  test("a stale version (edited after it was shown) is skipped and reported; the current one is approved with address and digest", async () => {
    const { msgs } = await freshCampaign("Stale", ["stale-ap@ok.example"]);
    await db.query(as(UUID_A), "select public.set_email_approval($1::uuid[], public.test_versions($1::uuid[]), 'unapprove')", [msgs]);
    const seen = (await one<{ v: string[] }>(UUID_A, "select public.test_versions($1::uuid[]) as v", [msgs])).v;
    await db.query(as(UUID_C), "update public.email_messages set body = 'Edited by someone else.' where id = $1", [msgs[0]]);
    const r = (await one<{ r: unknown }>(UUID_A, "select public.set_email_approval($1::uuid[], $2::timestamptz[], 'approve') as r", [msgs, seen])).r;
    expect(r).toEqual({ done: 0, changed: 1, skipped: 0 });
    expect(await statusOf("email_messages", msgs[0])).toBe("draft");
    const ok = (await one<{ r: unknown }>(UUID_A, "select public.set_email_approval($1::uuid[], public.test_versions($1::uuid[]), 'approve') as r", [msgs])).r;
    expect(ok).toEqual({ done: 1, changed: 0, skipped: 0 });
    const m = await one<{ approved_to: string; approved_digest: string; digest: string }>(UUID_A, "select approved_to, approved_digest, public.message_digest(subject, body) as digest from public.email_messages where id = $1", [msgs[0]]);
    expect(m.approved_to).toBe("stale-ap@ok.example");
    expect(m.approved_digest).toBe(m.digest);
    // approving again: not a draft any more -> skipped; versions are mandatory
    expect((await one<{ r: unknown }>(UUID_A, "select public.set_email_approval($1::uuid[], public.test_versions($1::uuid[]), 'approve') as r", [msgs])).r).toEqual({ done: 0, changed: 0, skipped: 1 });
    expect((await db.try(as(UUID_A), "select public.set_email_approval($1::uuid[], null, 'approve')", [msgs])).error?.message).toMatch(/one version per message/);
  });
});

describe("[R2][R9] retries and unknown results", () => {
  test("a retry never gives a slot back: the failed attempt still counts in the limit and holds the gap", async () => {
    await ageClaims(2 * 86_400);
    await db.query(as(UUID_A), "update public.mailboxes set daily_limit = 2 where id = $1", [ids.mbA]);
    const { camp, msgs } = await freshCampaign("Retry", ["retry1@ok.example", "retry2@ok.example"]);
    const first = await claim(UUID_A, camp);
    await finish(UUID_A, first.message_id!, "failed");
    expect((await usage()).dry_run).toBe(1);
    expect(await one(UUID_A, "select public.retry_failed_email($1) as r", [first.message_id])).toEqual({ r: "approved" });
    expect((await usage()).dry_run).toBe(1);
    expect((await claim(UUID_A, camp)).outcome).toBe("gap");
    await ageClaims(200);
    const second = await claim(UUID_A, camp);
    expect(second.outcome).toBe("claimed");
    await finish(UUID_A, second.message_id!, "dry_run");
    await ageClaims(200);
    expect((await claim(UUID_A, camp)).outcome).toBe("daily_limit");
    expect(msgs).toContain(second.message_id);
    await db.query(as(UUID_A), "update public.mailboxes set daily_limit = 30 where id = $1", [ids.mbA]);
    await ageClaims(2 * 86_400);
  });

  test("a REAL claim that never reported back is 'unknown' and is retried only with the person's confirmation", async () => {
    const { camp, msgs } = await freshCampaign("Interrupted", ["int@ok.example"]);
    await setMode(camp, "real");
    await ageClaims(400);
    expect((await claim(UUID_A, camp)).message_id).toBe(msgs[0]);
    await db.admin("update public.email_messages set claim_expires_at = now() - interval '1 second' where id = $1", [msgs[0]]);
    await ageClaims(400);
    expect((await claim(UUID_A, camp)).outcome).toBe("nothing_due");
    expect(await one(UUID_A, "select status, error from public.email_messages where id = $1", [msgs[0]])).toEqual({ status: "failed", error: "interrupted" });
    expect(await one(UUID_A, "select result from public.email_send_log where message_id = $1", [msgs[0]])).toEqual({ result: "unknown" });
    expect((await db.try(as(UUID_A), "select public.retry_failed_email($1)", [msgs[0]])).error?.message).toMatch(/R9/);
    expect(await one(UUID_A, "select public.retry_failed_email($1, true) as r", [msgs[0]])).toEqual({ r: "approved" });
    await setMode(camp, "dry_run");
    await ageClaims(2 * 86_400);
  });

  test("'Enviar teste para mim' is limited to 5 a day per address, logged under its own mode", async () => {
    const before = await usage();
    for (let i = 0; i < 5; i++) {
      const c = (await one<{ r: { outcome: string; log_id: string } }>(UUID_A, "select public.claim_test_email($1, 'me@owner.example') as r", [ids.mbA])).r;
      expect(c.outcome).toBe("claimed");
      await db.query(as(UUID_A), "select public.finish_test_email($1, true, null)", [c.log_id]);
    }
    expect((await one<{ r: { outcome: string } }>(UUID_A, "select public.claim_test_email($1, 'me@owner.example') as r", [ids.mbA])).r.outcome).toBe("test_limit");
    const after = await usage();
    expect(after.test).toBe(5);
    expect([after.real, after.dry_run]).toEqual([before.real, before.dry_run]);
    expect((await db.try(as(UUID_D), "select public.claim_test_email($1, 'x@y.example')", [ids.mbA])).error?.message).toMatch(/not allowed/);
  });
});

describe("[R2][R8][R14] the send log is append-only and client-read-only", () => {
  test("clients cannot write it; not even the owner of the database can rewrite or delete a finished row", async () => {
    for (const sql of [
      "insert into public.email_send_log (workspace_id, mailbox_address, mode, to_address) values ($1,'a@b.example','real','c@d.example')",
      "update public.email_send_log set result = 'failed' where workspace_id = $1",
      "delete from public.email_send_log where workspace_id = $1",
      "select token from public.email_unsub_tokens where workspace_id = $1",
    ]) {
      expect((await db.try(as(UUID_A), sql, [wsA])).error?.message, sql).toMatch(/permission denied/);
    }
    const row = (await db.admin<{ id: string }>("select id from public.email_send_log where result <> 'pending' limit 1"))[0];
    await expect(db.admin("update public.email_send_log set result = 'sent' where id = $1", [row.id])).rejects.toThrow(/append-only/);
    await expect(db.admin("delete from public.email_send_log where id = $1", [row.id])).rejects.toThrow(/append-only/);
    expect(await db.query(as(UUID_B), "select id from public.email_send_log where workspace_id = $1", [wsA])).toHaveLength(0);
    expect(await db.query(as(UUID_D), "select id from public.email_send_log where workspace_id = $1", [wsA])).toHaveLength(0);
  });
});

describe("[R3] delivery reports: confirmed bounces act, possible ones wait for a person", () => {
  test("a possible bounce changes nothing until confirmed; dismissing it changes nothing either", async () => {
    const { camp, msgs } = await freshCampaign("PB", ["pb@ok.example"]);
    const p = (await one<{ id: string }>(UUID_A, "select prospect_id as id from public.email_messages where id = $1", [msgs[0]])).id;
    const rec = async (rfc: string) =>
      (await one<{ r: string }>(UUID_A, "select public.record_email_reply($1,$2,null,'postmaster@evil.example','Undeliverable','x',$3,now(),'possible_bounce','pb@ok.example') as r", [p, ids.mbA, rfc])).r;
    const r1 = await rec("<pb1@evil.example>");
    expect(await db.query(as(UUID_A), "select 1 from public.suppressions where workspace_id = $1 and value = 'pb@ok.example'", [wsA])).toHaveLength(0);
    expect(await statusOf("email_prospects", p)).toBe("active");
    expect(await statusOf("email_messages", msgs[0])).toBe("approved");
    await db.query(as(UUID_A), "select public.confirm_possible_bounce($1, false)", [r1]);
    expect(await one(UUID_A, "select possible_bounce, is_bounce, classification from public.email_replies where id = $1", [r1])).toEqual({ possible_bounce: false, is_bounce: false, classification: "other" });
    expect(await statusOf("email_prospects", p)).toBe("active");
    const r2 = await rec("<pb2@evil.example>");
    await db.query(as(UUID_C), "select public.confirm_possible_bounce($1, true)", [r2]);
    expect(await db.query(as(UUID_A), "select reason from public.suppressions where workspace_id = $1 and value = 'pb@ok.example'", [wsA])).toEqual([{ reason: "bounced" }]);
    expect(await statusOf("email_prospects", p)).toBe("stopped");
    expect((await db.try(as(UUID_D), "select public.confirm_possible_bounce($1, true)", [r2])).error?.message).toMatch(/not allowed/);
    expect(camp).toBeTruthy();
  });
});

describe("[R15] the closer brief is written only through save_closer_brief()", () => {
  test("no client column grant; the RPC checks shape and membership", async () => {
    expect((await db.try(as(UUID_A), "update public.email_prospects set closer_brief = '{}'::jsonb where id = $1", [ids.prosA])).error?.message).toMatch(/permission denied/);
    const good = { who: "Acme", what_they_said: "Call Tuesday", next_step: "Call", evidence_urls: ["https://acme.example/contact"], model: "claude-opus-5-5" };
    for (const bad of [{ ...good, extra: 1 }, { ...good, evidence_urls: ["javascript:alert(1)"] }, { ...good, who: 5 }, { ...good, evidence_urls: "https://x.example" }, []]) {
      expect((await db.try(as(UUID_A), "select public.save_closer_brief($1, $2::jsonb)", [ids.prosA, JSON.stringify(bad)])).error?.message, JSON.stringify(bad)).toMatch(/invalid closer brief/);
    }
    expect((await db.try(as(UUID_D), "select public.save_closer_brief($1, $2::jsonb)", [ids.prosA, JSON.stringify(good)])).error?.message).toMatch(/not allowed/);
    await db.query(as(UUID_A), "select public.save_closer_brief($1, $2::jsonb)", [ids.prosA, JSON.stringify(good)]);
    expect((await one<{ closer_brief: unknown; at: boolean }>(UUID_A, "select closer_brief, closer_brief_at is not null as at from public.email_prospects where id = $1", [ids.prosA]))).toEqual({ closer_brief: good, at: true });
  });
});

describe("[R18] an address without an evidence excerpt that contains it is only a suggestion", () => {
  test("import keeps it as suggested_email (not sendable); a person confirms it and it becomes manual, stamped with who", async () => {
    const run = await one<{ id: string }>(UUID_A, "insert into public.research_runs (workspace_id, title, request_text) values ($1,'t2','pedido') returning id", [wsA]);
    const c = await one<{ id: string }>(
      UUID_A,
      "insert into public.research_candidates (workspace_id, run_id, name, name_key, website, public_email) values ($1,$2,'Gamma R18','gamma r18','https://gamma.example','Hello@Gamma.example') returning id",
      [wsA, run.id],
    );
    await db.query(as(UUID_A), "update public.research_candidates set user_decision = 'keep' where id = $1", [c.id]);
    await db.query(as(UUID_A), "select public.add_research_check($1,'exists_active',1,'ok','ativa',$2::jsonb)", [c.id, JSON.stringify([{ url: "https://gamma.example/about", title: "About", excerpt: "Gamma builds homes in Worcester." }])]);
    const list = (await one<{ l: string }>(UUID_A, "select public.create_research_list($1,'R18') as l", [run.id])).l;
    const camp = await one<{ id: string }>(UUID_A, "insert into public.email_campaigns (workspace_id, list_id, name, mailbox_id) values ($1,$2,'R18',$3) returning id", [wsA, list, ids.mbA]);
    await db.query(as(UUID_A), "select public.import_list_into_campaign($1)", [camp.id]);
    const p = await one<{ id: string; email: string | null; email_source: string | null; suggested_email: string; suggested_email_url: string }>(
      UUID_A,
      "select id, email, email_source, suggested_email, suggested_email_url from public.email_prospects where campaign_id = $1",
      [camp.id],
    );
    expect(p).toMatchObject({ email: null, email_source: null, suggested_email: "hello@gamma.example", suggested_email_url: "https://gamma.example" });
    await db.query(as(UUID_C), "update public.email_prospects set email = $2 where id = $1", [p.id, p.suggested_email]);
    expect(await one(UUID_A, "select email, email_source, email_source_url, email_confirmed_by, suggested_email from public.email_prospects where id = $1", [p.id])).toEqual({
      email: "hello@gamma.example",
      email_source: "manual",
      email_source_url: null,
      email_confirmed_by: UUID_C,
      suggested_email: null,
    });
  });
});

describe("[R1] inherent limits without a service key (documented, not hidden)", () => {
  test("an owner/SDR calling the RPC directly can mark their own mailbox verified (the server normally does it after SMTP)", async () => {
    expect((await db.try(as(UUID_C), "select public.set_mailbox_verified($1, true, null)", [ids.mbA])).error).toBeUndefined();
    expect((await db.try(as(UUID_D), "select public.set_mailbox_verified($1, true, null)", [ids.mbA])).error?.message).toMatch(/not allowed/);
  });
});
