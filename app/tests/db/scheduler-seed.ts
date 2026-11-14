import { installEmailTestHelpers, openGates, as, UUID_A, type TestDb } from "./helpers";

// Seeds for the scheduler tests (E1): an owner with a workspace and sender profile, and campaigns whose first
// message is approved and due, all as the logged-in owner through the real functions (nothing forced).

export const CIPHER = "v1:" + "Z".repeat(60);
export const TOKEN = "a1b2c3d4".repeat(8); // 64 lowercase hex
export const OTHER_TOKEN = "0f1e2d3c".repeat(8);

export type Seeded = { campaign: string; mailbox: string; address: string; prospects: string[]; messages: string[]; emails: string[] };

export async function createOwner(db: TestDb, userId = UUID_A): Promise<string> {
  await installEmailTestHelpers(db);
  await db.addUser(userId);
  const ws = (await db.query<{ id: string }>(as(userId), "select public.create_workspace('NEAir HVAC') as id"))[0].id;
  await db.query(as(userId), "insert into public.sender_profiles (workspace_id, legal_name, postal_address, sender_name) values ($1,'New England Air HVAC Corp','1 Main St, Millbury, MA 01527','Juan Sanches')", [ws]);
  return ws;
}

/**
 * One rehearsal campaign with `n` prospects (each with a published address and evidence). Step 1 of each prospect is
 * drafted and, when `approve`, approved by the owner; the campaign is set to `status`. Each campaign has its own
 * mailbox address, so the gap (fixture: 1 + 2 min) and the daily limit of one campaign never get in the way of another.
 */
export async function seedCampaign(
  db: TestDb,
  ws: string,
  label: string,
  opts: { n?: number; approve?: boolean; status?: "active" | "paused" | "draft"; userId?: string } = {},
): Promise<Seeded> {
  const { n = 1, approve = true, status = "active", userId = UUID_A } = opts;
  const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(as(userId), sql, params);
  const run = (await q<{ id: string }>("insert into public.research_runs (workspace_id, title, request_text) values ($1,$2,'builders') returning id", [ws, `run ${label}`]))[0].id;
  const emails: string[] = [];
  for (let i = 0; i < n; i++) {
    const email = `office${i}@${label}.example`;
    emails.push(email);
    const c = (
      await q<{ id: string }>(
        "insert into public.research_candidates (workspace_id, run_id, name, name_key, website, public_email) values ($1,$2,$3,$4,'https://builder.example',$5) returning id",
        [ws, run, `${label} ${i}`, `${label} ${i}`, email],
      )
    )[0].id;
    await q("update public.research_candidates set ask_for_name = 'Pat Doe', user_decision = 'keep', hook = 'Saw your permit' where id = $1", [c]);
    await q("select public.add_research_check($1,'has_work',1,'ok','tem obra',$2::jsonb)", [c, JSON.stringify([{ url: "https://permits.example/x", title: "Permit", excerpt: `Contact ${email}` }])]);
  }
  const list = (await q<{ id: string }>("select public.create_research_list($1,'Lista') as id", [run]))[0].id;
  const address = `sales-${label}@neair.example`;
  const mailbox = (await q<{ id: string }>("select public.save_mailbox($1,$2,$3) as id", [ws, address, CIPHER]))[0].id;
  const campaign = (await q<{ id: string }>("insert into public.email_campaigns (workspace_id, list_id, name, mailbox_id) values ($1,$2,$3,$4) returning id", [ws, list, label, mailbox]))[0].id;
  await openGates(db, campaign);
  await q("select public.import_list_into_campaign($1)", [campaign]);
  const prospects = (await q<{ id: string }>("select id from public.email_prospects where campaign_id = $1 order by email", [campaign])).map((r) => r.id);
  const messages: string[] = [];
  for (const p of prospects) {
    const id = (
      await q<{ id: string }>(
        "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body, ai_drafted) values ($1,$2,$3,'sequence',1,'Quick question','Hi Pat, who handles HVAC for your projects?',false) returning id",
        [ws, campaign, p],
      )
    )[0].id;
    messages.push(id);
    if (approve) await q("select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')", [id]);
  }
  if (status !== "draft") await q("update public.email_campaigns set status = 'active' where id = $1", [campaign]);
  if (status === "paused") await q("update public.email_campaigns set status = 'paused' where id = $1", [campaign]);
  return { campaign, mailbox, address, prospects, messages, emails };
}

/** E3 fixture: a new mailbox (address `sales-<label>@neair.example`, unverified) attached as the campaign's next mailbox. */
export async function addCampaignMailbox(db: TestDb, ws: string, campaign: string, label: string, userId = UUID_A): Promise<{ mailbox: string; address: string }> {
  const address = `sales-${label}@neair.example`;
  const mailbox = (await db.query<{ id: string }>(as(userId), "select public.save_mailbox($1,$2,$3) as id", [ws, address, CIPHER]))[0].id;
  await db.query(as(userId), "insert into public.campaign_mailboxes (campaign_id, mailbox_id) values ($1,$2)", [campaign, mailbox]);
  return { mailbox, address };
}
