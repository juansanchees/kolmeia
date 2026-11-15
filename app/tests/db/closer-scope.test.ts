import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, as } from "./helpers";

// Migration 0017 (closer scope): a closer reads only the e-mail rows of the leads assigned to her (leads.owner_id),
// never the campaign plumbing (campaigns, mailboxes, sender profiles, suppressions, campaign_mailboxes), and cannot
// write suppressions. Owners and SDRs keep reading the whole workspace. Fictional data only.

const OWNER = "10000000-0000-4000-8000-000000000001";
const SDR = "10000000-0000-4000-8000-000000000002";
const CLOSER_A = "10000000-0000-4000-8000-000000000003";
const CLOSER_B = "10000000-0000-4000-8000-000000000004";
const OWNER_2 = "20000000-0000-4000-8000-000000000001";
const CLOSER_2 = "20000000-0000-4000-8000-000000000002";

const CIPHER = "v1:" + "A".repeat(60);

let db: TestDb;
let ws1: string;
let ws2: string;

/** Every e-mail row seeded for one company (one prospect). */
type Rows = { prospect: string; message: string; reply: string; approval: string; sendLog: string };
const seeded: Record<string, Rows> = {};
const infra: Record<string, string> = {};
const candidates: Record<string, string> = {};

async function one<T = Record<string, unknown>>(user: string, sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(as(user), sql, params))[0];
}

/** Rows hanging off one prospect: a sequence message, its approval, a send-log row and a reply. */
async function emailRows(ws: string, campaign: string, prospect: string, key: string): Promise<Rows> {
  const [m] = await db.admin<{ id: string }>(
    "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body) values ($1,$2,$3,'sequence',1,$4,'Hi, short note.') returning id",
    [ws, campaign, prospect, `Subject ${key}`],
  );
  const [a] = await db.admin<{ id: string }>(
    "insert into public.email_approvals (workspace_id, message_id, user_id, action) values ($1,$2,null,'approve') returning id",
    [ws, m.id],
  );
  const [l] = await db.admin<{ id: string }>(
    "insert into public.email_send_log (workspace_id, campaign_id, prospect_id, message_id, mailbox_address, mode, to_address) values ($1,$2,$3,$4,'sales@mail.example','dry_run','to@acme.example') returning id",
    [ws, campaign, prospect, m.id],
  );
  const [r] = await db.admin<{ id: string }>(
    "insert into public.email_replies (workspace_id, campaign_id, prospect_id, message_id, from_address, subject, body_text, received_at, rfc_message_id) values ($1,$2,$3,$4,'to@acme.example','Re: hi','thanks',now(),$5) returning id",
    [ws, campaign, prospect, m.id, `<reply-${key}@mail.example>`],
  );
  return { prospect, message: m.id, reply: r.id, approval: a.id, sendLog: l.id };
}

/** A workspace with one campaign and one handed-off prospect per company; returns the lead id per company key. */
async function seedWorkspace(owner: string, ws: string, keys: string[]): Promise<Record<string, string>> {
  const run = await one<{ id: string }>(owner, "insert into public.research_runs (workspace_id, title, request_text) values ($1,'t','pedido') returning id", [ws]);
  const cands: Record<string, string> = {};
  for (const k of keys) {
    const c = await one<{ id: string }>(
      owner,
      "insert into public.research_candidates (workspace_id, run_id, name, name_key) values ($1,$2,$3,$4) returning id",
      [ws, run.id, `Company ${k}`, `company ${k}`.toLowerCase()],
    );
    await db.query(as(owner), "update public.research_candidates set user_decision = 'keep', verified_at = now() where id = $1", [c.id]);
    cands[k] = c.id;
    candidates[k] = c.id;
    // proof the closer may read for her own lead (0009 J2): one check with its evidence
    await db.query(as(owner), "select public.add_research_check($1,'exists_active',1,'ok','ativa',$2::jsonb)", [
      c.id,
      JSON.stringify([{ url: "https://acme.example/contact", title: "Contact", excerpt: "Active" }]),
    ]);
  }
  const list = await one<{ create_research_list: string }>(owner, "select public.create_research_list($1,'Lista')", [run.id]);
  await db.query(as(owner), "insert into public.sender_profiles (workspace_id, legal_name, postal_address, sender_name) values ($1,'Acme HVAC Corp','1 Main St, Millbury, MA 01527','Pat Sender')", [ws]);
  const mb = (await one<{ save_mailbox: string }>(owner, "select public.save_mailbox($1,$2,$3)", [ws, `sales-${ws.slice(0, 8)}@gmail.com`, CIPHER])).save_mailbox;
  const camp = await one<{ id: string }>(owner, "insert into public.email_campaigns (workspace_id, list_id, name, mailbox_id) values ($1,$2,'Campanha',$3) returning id", [
    ws,
    list.create_research_list,
    mb,
  ]);
  await db.query(as(owner), "insert into public.campaign_mailboxes (campaign_id, mailbox_id) values ($1,$2) on conflict do nothing", [camp.id, mb]);
  await db.query(as(owner), "insert into public.suppressions (workspace_id, kind, value, reason) values ($1,'domain','blocked.example','manual')", [ws]);
  infra[`camp:${ws}`] = camp.id;
  const leads: Record<string, string> = {};
  for (const k of keys) {
    const [p] = await db.admin<{ id: string }>(
      "insert into public.email_prospects (workspace_id, campaign_id, candidate_id, company_name, status, handed_off_at) values ($1,$2,$3,$4,'handed_off',now()) returning id",
      [ws, camp.id, cands[k], `Company ${k}`],
    );
    seeded[k] = await emailRows(ws, camp.id, p.id, k);
    leads[k] = (await db.admin<{ lead_id: string }>("select lead_id from public.research_candidates where id = $1", [cands[k]]))[0].lead_id;
  }
  // a prospect typed by hand: no candidate, so no lead, so never a closer's
  const [manual] = await db.admin<{ id: string }>(
    "insert into public.email_prospects (workspace_id, campaign_id, company_name, email, email_source, status, handed_off_at) values ($1,$2,'Manual Co','x@manual.example','manual','handed_off',now()) returning id",
    [ws, camp.id],
  );
  seeded[`manual:${ws}`] = await emailRows(ws, camp.id, manual.id, `manual-${ws.slice(0, 8)}`);
  return leads;
}

beforeAll(async () => {
  db = await TestDb.create();
  for (const id of [OWNER, SDR, CLOSER_A, CLOSER_B, OWNER_2, CLOSER_2]) await db.addUser(id);
  ws1 = (await one<{ create_workspace: string }>(OWNER, "select public.create_workspace('Empresa 1')")).create_workspace;
  ws2 = (await one<{ create_workspace: string }>(OWNER_2, "select public.create_workspace('Empresa 2')")).create_workspace;
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr'), ($1,$3,'closer'), ($1,$4,'closer'), ($5,$6,'closer')", [
    ws1,
    SDR,
    CLOSER_A,
    CLOSER_B,
    ws2,
    CLOSER_2,
  ]);
  const l1 = await seedWorkspace(OWNER, ws1, ["toA", "toB", "free"]);
  const l2 = await seedWorkspace(OWNER_2, ws2, ["other"]);
  await db.admin("update public.leads set owner_id = $1 where id = $2", [CLOSER_A, l1.toA]);
  await db.admin("update public.leads set owner_id = $1 where id = $2", [CLOSER_B, l1.toB]);
  await db.admin("update public.leads set owner_id = $1 where id = $2", [CLOSER_2, l2.other]);
  await db.admin("insert into public.lead_fields (workspace_id, lead_id, field, value, source) values ($1,$2,'note','call after 3pm','import')", [ws1, l1.toB]);
});

afterAll(async () => {
  await db.pg.close();
});

const SCOPED = [
  ["email_prospects", "prospect"],
  ["email_messages", "message"],
  ["email_replies", "reply"],
  ["email_approvals", "approval"],
  ["email_send_log", "sendLog"],
] as const;

const PLUMBING = ["email_campaigns", "mailboxes", "sender_profiles", "suppressions", "campaign_mailboxes"] as const;

/** Tables without an id column: read their key instead. */
const KEY_COLUMN: Record<string, string> = { campaign_mailboxes: "campaign_id", sender_profiles: "workspace_id" };

const ids = async (user: string, table: string) =>
  (await db.query<{ id: string }>(as(user), `select ${KEY_COLUMN[table] ?? "id"} as id from public.${table}`))
    .map((r) => r.id)
    .sort();

describe("0017 closer scope: e-mail rows", () => {
  for (const [table, key] of SCOPED) {
    test(`closer A reads only her own ${table}`, async () => {
      expect(await ids(CLOSER_A, table)).toEqual([seeded.toA[key]]);
    });
    test(`closer B reads only her own ${table}`, async () => {
      expect(await ids(CLOSER_B, table)).toEqual([seeded.toB[key]]);
    });
    test(`the other workspace's closer reads only her own ${table}`, async () => {
      expect(await ids(CLOSER_2, table)).toEqual([seeded.other[key]]);
    });
    test(`owner and sdr still read every ${table} row of their workspace`, async () => {
      const all = [seeded.toA[key], seeded.toB[key], seeded.free[key], seeded[`manual:${ws1}`][key]].sort();
      expect(await ids(OWNER, table)).toEqual(all);
      expect(await ids(SDR, table)).toEqual(all);
    });
  }

  test("a closer removed from the workspace reads nothing, though owner_id still names her", async () => {
    const LEAD_TABLES = ["leads", "lead_fields", "research_candidates", "research_checks", "research_evidence"];
    const count = async (t: string) => (await db.query(as(CLOSER_B), `select 1 from public.${t}`)).length;
    for (const t of LEAD_TABLES) expect(await count(t), `${t} before removal`).toBeGreaterThan(0);
    expect(await db.query(as(CLOSER_B), "select id from public.research_candidates")).toEqual([{ id: candidates.toB }]);
    await db.admin("delete from public.workspace_members where workspace_id = $1 and user_id = $2", [ws1, CLOSER_B]);
    try {
      for (const t of LEAD_TABLES) expect(await count(t), t).toBe(0);
      for (const [table] of SCOPED) expect(await ids(CLOSER_B, table), table).toEqual([]);
    } finally {
      await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'closer')", [ws1, CLOSER_B]);
    }
  });

  test("the /leads/closer query as closer A returns only her hand-off", async () => {
    const rows = await db.query<{ id: string }>(as(CLOSER_A), "select id from public.email_prospects where workspace_id = $1 and status = 'handed_off'", [ws1]);
    expect(rows.map((r) => r.id)).toEqual([seeded.toA.prospect]);
  });
});

describe("0017 closer scope: campaign plumbing is sender-only", () => {
  for (const table of PLUMBING) {
    test(`closer reads no ${table}`, async () => {
      expect(await ids(CLOSER_A, table)).toEqual([]);
      expect(await ids(CLOSER_2, table)).toEqual([]);
    });
    test(`owner and sdr still read ${table}`, async () => {
      expect((await ids(OWNER, table)).length).toBeGreaterThan(0);
      expect((await ids(SDR, table)).length).toBeGreaterThan(0);
    });
  }

  test("closer cannot add a suppression", async () => {
    const r = await db.try(as(CLOSER_A), "insert into public.suppressions (workspace_id, kind, value, reason) values ($1,'domain','closer.example','manual')", [ws1]);
    expect(r.error?.message).toMatch(/row-level security/);
  });

  test("sdr can still add a suppression", async () => {
    const r = await db.try(as(SDR), "insert into public.suppressions (workspace_id, kind, value, reason) values ($1,'domain','sdr.example','manual') returning id", [ws1]);
    expect(r.error).toBeUndefined();
    expect(r.rows).toHaveLength(1);
  });

  test("closer cannot delete a suppression", async () => {
    const r = await db.try(as(CLOSER_A), "delete from public.suppressions where workspace_id = $1 returning id", [ws1]);
    expect(r.rows ?? []).toHaveLength(0);
  });
});
