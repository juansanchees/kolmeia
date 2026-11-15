import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, anon, as } from "./helpers";

// Migration 0020 part A (F5): closer invites by link, the people list, lead hand-off and won/lost, and a removed
// member's leads going back to unassigned. Fictional data only (*.example). Real migrations, non-superuser roles (PGlite).

const OWNER_A = "30000000-0000-4000-8000-000000000001";
const SDR_A = "30000000-0000-4000-8000-000000000002";
const CLOSER_2 = "30000000-0000-4000-8000-000000000003"; // already a closer of workspace A
const CLOSER = "30000000-0000-4000-8000-000000000004"; // closer@a.example, joins A by invite
const OTHER = "30000000-0000-4000-8000-000000000005"; // other@a.example, no workspace
const OWNER_B = "40000000-0000-4000-8000-000000000001"; // owner-b@b.example
const CLOSER_B = "40000000-0000-4000-8000-000000000002";
const UPPER = "40000000-0000-4000-8000-000000000003"; // UPPER@B.example in auth, no workspace

let db: TestDb;
let wsA: string;
let wsB: string;
const leads: string[] = [];
const cands: string[] = [];

const code = (e: unknown) => (e as { code?: string } | undefined)?.code;
const msg = (e: unknown) => (e as Error | undefined)?.message;

async function one<T = Record<string, unknown>>(user: string, sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(as(user), sql, params))[0];
}

const invite = async (user: string, ws: string, name: string, email: string) =>
  (await one<{ t: string }>(user, "select public.create_workspace_invite($1,$2,$3) as t", [ws, name, email])).t;

const brief = (urls: string[] = ["https://acme.example/contact"]) =>
  JSON.stringify({ who: "Pat Doe, facilities manager", what_they_said: "Wants a quote", next_step: "Call Tuesday", evidence_urls: urls, model: "manual" });

const leadRow = (id: string) =>
  db.admin<{ status: string; owner_id: string | null; handed_off_by: string | null; handed_off_at: string | null; closer_brief: unknown }>(
    "select status, owner_id, handed_off_by, handed_off_at, closer_brief from public.leads where id = $1",
    [id],
  ).then((r) => r[0]);

beforeAll(async () => {
  db = await TestDb.create();
  const emails: [string, string][] = [
    [OWNER_A, "owner@a.example"],
    [SDR_A, "sdr@a.example"],
    [CLOSER_2, "closer2@a.example"],
    [CLOSER, "closer@a.example"],
    [OTHER, "other@a.example"],
    [OWNER_B, "owner-b@b.example"],
    [CLOSER_B, "closer@b.example"],
    [UPPER, "UPPER@B.example"],
  ];
  for (const [id, email] of emails) await db.addUser(id, true, email);
  wsA = (await one<{ create_workspace: string }>(OWNER_A, "select public.create_workspace('Empresa A')")).create_workspace;
  wsB = (await one<{ create_workspace: string }>(OWNER_B, "select public.create_workspace('Empresa B')")).create_workspace;
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr'), ($1,$3,'closer'), ($4,$5,'closer')", [
    wsA,
    SDR_A,
    CLOSER_2,
    wsB,
    CLOSER_B,
  ]);
  const run = await one<{ id: string }>(OWNER_A, "insert into public.research_runs (workspace_id, title, request_text) values ($1,'t','pedido') returning id", [wsA]);
  for (const k of ["one", "two", "three", "four"]) {
    const c = await one<{ id: string }>(
      OWNER_A,
      "insert into public.research_candidates (workspace_id, run_id, name, name_key) values ($1,$2,$3,$4) returning id",
      [wsA, run.id, `Company ${k}`, `company ${k}`],
    );
    await db.query(as(OWNER_A), "update public.research_candidates set user_decision = 'keep', verified_at = now() where id = $1", [c.id]);
    await db.query(as(OWNER_A), "select public.add_research_check($1,'exists_active',1,'ok','ativa',$2::jsonb)", [
      c.id,
      JSON.stringify([{ url: "https://acme.example/contact", title: "Contact", excerpt: "Active" }]),
    ]);
    cands.push(c.id);
    leads.push((await db.admin<{ lead_id: string }>("select lead_id from public.research_candidates where id = $1", [c.id]))[0].lead_id);
  }
});

afterAll(async () => {
  await db.pg.close();
});

describe("0020 part A: invites, people, hand-off, won/lost", () => {
  test("only the owner creates and revokes invites; the token is returned once and stored hashed", async () => {
    for (const u of [SDR_A, CLOSER_2, OWNER_B]) {
      expect(code((await db.try(as(u), "select public.create_workspace_invite($1,'Ana','ana@a.example')", [wsA])).error), u).toBe("42501");
    }
    expect((await db.try(anon, "select public.create_workspace_invite($1,'Ana','ana@a.example')", [wsA])).error).toBeDefined();
    expect(code((await db.try(as(OWNER_A), "select public.create_workspace_invite($1,'Ana','not an e-mail')", [wsA])).error)).toBe("22023");
    expect(code((await db.try(as(OWNER_A), "select public.create_workspace_invite($1,'  ','ana@a.example')", [wsA])).error)).toBe("22023");

    const token = await invite(OWNER_A, wsA, "Ana", "Ana@A.example");
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    for (const u of [OWNER_A, SDR_A, CLOSER_2]) {
      const denied = await db.try(as(u), "select token_hash from public.workspace_invites");
      expect(msg(denied.error), u).toMatch(/permission denied/);
    }
    const rows = await db.query<{ id: string; email: string; role: string; created_by: string; expires_at: string }>(
      as(OWNER_A),
      "select id, email, role, created_by, expires_at from public.workspace_invites where workspace_id = $1",
      [wsA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "ana@a.example", role: "closer", created_by: OWNER_A });
    const [stored] = await db.admin<{ ok: boolean; days: number }>(
      "select token_hash = encode(sha256(convert_to($2::text, 'UTF8')),'hex') as ok, round(extract(epoch from expires_at - created_at) / 86400)::int as days from public.workspace_invites where id = $1",
      [rows[0].id, token],
    );
    expect(stored).toEqual({ ok: true, days: 7 });
    expect((await db.admin("select 1 from public.workspace_invites where token_hash = $1", [token]))).toHaveLength(0);

    // no client writes
    expect((await db.try(as(OWNER_A), "update public.workspace_invites set revoked_at = now()")).error).toBeDefined();
    expect((await db.try(as(OWNER_A), "delete from public.workspace_invites")).error).toBeDefined();

    for (const u of [SDR_A, CLOSER_2, OWNER_B]) {
      expect(code((await db.try(as(u), "select public.revoke_workspace_invite($1)", [rows[0].id])).error), u).toBe("42501");
    }
    await db.query(as(OWNER_A), "select public.revoke_workspace_invite($1)", [rows[0].id]);
    const [rev] = await db.admin<{ revoked_at: string | null }>("select revoked_at from public.workspace_invites where id = $1", [rows[0].id]);
    expect(rev.revoked_at).not.toBeNull();
  });

  test("accept: same e-mail, once, before expiry, only for a user without a workspace", async () => {
    const token = await invite(OWNER_A, wsA, "Ana Closer", "closer@a.example");

    const [preview] = await db.query<{ workspace_name: string; email: string; valid: boolean }>(as(OTHER), "select * from public.invite_preview($1)", [token]);
    expect(preview).toEqual({ workspace_name: "Empresa A", email: "closer@a.example", valid: true });
    expect(await db.query(as(OTHER), "select * from public.invite_preview($1)", ["0".repeat(64)])).toHaveLength(0);
    expect((await db.try(anon, "select * from public.invite_preview($1)", [token])).error).toBeDefined();

    const wrong = await db.try(as(OTHER), "select public.accept_workspace_invite($1)", [token]);
    expect([code(wrong.error), msg(wrong.error)]).toEqual(["P0001", "wrong_email"]);

    const forB = await invite(OWNER_A, wsA, "B owner", "owner-b@b.example");
    const has = await db.try(as(OWNER_B), "select public.accept_workspace_invite($1)", [forB]);
    expect([code(has.error), msg(has.error)]).toEqual(["P0001", "has_workspace"]);

    const old = await invite(OWNER_A, wsA, "Ana Closer", "closer@a.example");
    await db.admin("update public.workspace_invites set expires_at = now() - interval '1 minute' where token_hash = encode(sha256(convert_to($1::text, 'UTF8')),'hex')", [old]);
    expect(msg((await db.try(as(CLOSER), "select public.accept_workspace_invite($1)", [old])).error)).toBe("expired");
    expect((await db.query<{ valid: boolean }>(as(CLOSER), "select valid from public.invite_preview($1)", [old]))[0].valid).toBe(false);

    const revoked = await invite(OWNER_A, wsA, "Ana Closer", "closer@a.example");
    const [rid] = await db.admin<{ id: string }>("select id from public.workspace_invites where token_hash = encode(sha256(convert_to($1::text, 'UTF8')),'hex')", [revoked]);
    await db.query(as(OWNER_A), "select public.revoke_workspace_invite($1)", [rid.id]);
    expect(msg((await db.try(as(CLOSER), "select public.accept_workspace_invite($1)", [revoked])).error)).toBe("expired");
    expect((await db.query<{ valid: boolean }>(as(CLOSER), "select valid from public.invite_preview($1)", [revoked]))[0].valid).toBe(false);

    // an e-mail that is not confirmed yet does not count
    await db.admin("update auth.users set email_confirmed_at = null where id = $1", [CLOSER]);
    const unconfirmed = await db.try(as(CLOSER), "select public.accept_workspace_invite($1)", [token]);
    expect([code(unconfirmed.error), msg(unconfirmed.error)]).toEqual(["P0001", "wrong_email"]);
    await db.admin("update auth.users set email_confirmed_at = now() where id = $1", [CLOSER]);
    expect(msg((await db.try(as(CLOSER), "select public.accept_workspace_invite($1)", ["f".repeat(64)])).error)).toBe("expired");

    expect(await db.admin("select 1 from public.workspace_members where user_id = any($1)", [[OTHER, CLOSER]])).toHaveLength(0);

    const ok = await one<{ ws: string }>(CLOSER, "select public.accept_workspace_invite($1) as ws", [token]);
    expect(ok.ws).toBe(wsA);
    expect(await db.admin("select workspace_id, role from public.workspace_members where user_id = $1", [CLOSER])).toEqual([{ workspace_id: wsA, role: "closer" }]);
    const [acc] = await db.admin<{ accepted_by: string; accepted_at: string | null }>(
      "select accepted_by, accepted_at from public.workspace_invites where token_hash = encode(sha256(convert_to($1::text, 'UTF8')),'hex')",
      [token],
    );
    expect(acc.accepted_by).toBe(CLOSER);
    expect(acc.accepted_at).not.toBeNull();

    expect(msg((await db.try(as(CLOSER), "select public.accept_workspace_invite($1)", [token])).error)).toBe("expired");
    expect(msg((await db.try(as(OTHER), "select public.accept_workspace_invite($1)", [token])).error)).toBe("expired");
    expect((await db.query<{ valid: boolean }>(as(CLOSER), "select valid from public.invite_preview($1)", [token]))[0].valid).toBe(false);
  });

  test("people list and invites are owner/sdr only", async () => {
    for (const u of [CLOSER, CLOSER_2, OWNER_B, OTHER]) {
      expect(code((await db.try(as(u), "select * from public.list_workspace_people($1)", [wsA])).error), u).toBe("42501");
    }
    for (const u of [OWNER_A, SDR_A]) {
      const people = await db.query<{ user_id: string; role: string; label: string }>(as(u), "select * from public.list_workspace_people($1)", [wsA]);
      const byId = Object.fromEntries(people.map((p) => [p.user_id, p]));
      expect(Object.keys(byId).sort()).toEqual([OWNER_A, SDR_A, CLOSER_2, CLOSER].sort());
      expect(byId[CLOSER]).toEqual({ user_id: CLOSER, role: "closer", label: "Ana Closer" });
      expect(byId[OWNER_A].label).toBe("owner");
      expect(byId[CLOSER_2].label).toBe("closer");
    }
    expect((await db.query(as(OWNER_A), "select id from public.workspace_invites")).length).toBeGreaterThan(0);
    for (const u of [SDR_A, CLOSER, OWNER_B]) {
      expect(await db.query(as(u), "select id from public.workspace_invites"), u).toHaveLength(0);
    }
  });

  test("hand-off: owner/sdr to a closer of the same workspace, brief required and checked; status with_closer, or meeting kept", async () => {
    const [l1, l2] = leads;
    for (const u of [CLOSER_2, CLOSER, OWNER_B]) {
      expect(code((await db.try(as(u), "select public.hand_off_lead($1,$2,$3::jsonb)", [l1, CLOSER, brief()])).error), u).toBe("42501");
    }
    for (const to of [SDR_A, OWNER_A, CLOSER_B, OTHER]) {
      expect(code((await db.try(as(OWNER_A), "select public.hand_off_lead($1,$2,$3::jsonb)", [l1, to, brief()])).error), to).toBe("22023");
    }
    expect(code((await db.try(as(OWNER_A), "select public.hand_off_lead($1,$2,null)", [l1, CLOSER])).error)).toBe("22023");
    expect(code((await db.try(as(OWNER_A), "select public.hand_off_lead($1,$2,$3::jsonb)", [l1, CLOSER, brief(["javascript:alert(1)"])])).error)).toBe("22023");
    expect(code((await db.try(as(OWNER_A), "select public.hand_off_lead($1,$2,$3::jsonb)", [l1, CLOSER, '{"who":"x"}'])).error)).toBe("22023");

    await db.admin("update public.leads set status = 'won' where id = $1", [leads[3]]);
    expect(code((await db.try(as(OWNER_A), "select public.hand_off_lead($1,$2,$3::jsonb)", [leads[3], CLOSER, brief()])).error)).toBe("55000");
    await db.admin("update public.leads set status = 'new' where id = $1", [leads[3]]);

    await db.query(as(SDR_A), "select public.hand_off_lead($1,$2,$3::jsonb)", [l1, CLOSER, brief()]);
    const r1 = await leadRow(l1);
    expect(r1).toMatchObject({ status: "with_closer", owner_id: CLOSER, handed_off_by: SDR_A, closer_brief: JSON.parse(brief()) });
    expect(r1.handed_off_at).not.toBeNull();

    await db.admin("update public.leads set status = 'meeting' where id = $1", [l2]);
    await db.query(as(OWNER_A), "select public.hand_off_lead($1,$2,$3::jsonb)", [l2, CLOSER, brief()]);
    expect(await leadRow(l2)).toMatchObject({ status: "meeting", owner_id: CLOSER, handed_off_by: OWNER_A });
    // re-hand-off to another closer
    await db.query(as(OWNER_A), "select public.hand_off_lead($1,$2,$3::jsonb)", [l2, CLOSER_2, brief()]);
    expect(await leadRow(l2)).toMatchObject({ status: "meeting", owner_id: CLOSER_2 });

    // the closer reads her lead and its proof through the existing policies, nothing else
    expect((await db.query<{ id: string }>(as(CLOSER), "select id from public.leads")).map((r) => r.id)).toEqual([l1]);
    expect((await db.query<{ id: string }>(as(CLOSER), "select id from public.research_candidates")).map((r) => r.id)).toEqual([cands[0]]);
    expect(await db.query(as(CLOSER), "select id from public.research_checks")).toHaveLength(1);
    expect(await db.query(as(CLOSER), "select id from public.research_evidence")).toHaveLength(1);
    // no client writes on the new columns
    expect((await db.try(as(OWNER_A), "update public.leads set owner_id = null where id = $1", [l1])).error).toBeDefined();
  });

  test("won/lost by a sender or the assigned closer only", async () => {
    const [l1, l2, l3] = leads;
    expect(code((await db.try(as(CLOSER_2), "select public.set_lead_status($1,'won')", [l1])).error)).toBe("42501");
    expect(code((await db.try(as(OWNER_B), "select public.set_lead_status($1,'won')", [l1])).error)).toBe("42501");
    expect(code((await db.try(as(CLOSER), "select public.set_lead_status($1,'meeting')", [l1])).error)).toBe("22023");
    expect(code((await db.try(as(OWNER_A), "select public.set_lead_status($1,null)", [l1])).error)).toBe("22023");

    await db.admin("update public.leads set status = 'discarded' where id = $1", [l3]);
    expect(code((await db.try(as(OWNER_A), "select public.set_lead_status($1,'lost')", [l3])).error)).toBe("55000");
    await db.admin("update public.leads set status = 'new' where id = $1", [l3]);

    await db.query(as(CLOSER), "select public.set_lead_status($1,'won')", [l1]);
    expect((await leadRow(l1)).status).toBe("won");
    await db.query(as(SDR_A), "select public.set_lead_status($1,'lost')", [l2]);
    expect((await leadRow(l2)).status).toBe("lost");
    await db.query(as(OWNER_A), "select public.set_lead_status($1,'won')", [l3]);
    expect((await leadRow(l3)).status).toBe("won");
  });

  test("removing a member frees her leads", async () => {
    const [l1, l2, , l4] = leads;
    await db.query(as(OWNER_A), "select public.hand_off_lead($1,$2,$3::jsonb)", [l4, CLOSER, brief()]);
    expect((await leadRow(l4)).owner_id).toBe(CLOSER);
    await db.query(as(OWNER_A), "delete from public.workspace_members where workspace_id = $1 and user_id = $2", [wsA, CLOSER]);
    expect(await leadRow(l1)).toMatchObject({ owner_id: null, status: "won" });
    expect(await leadRow(l4)).toMatchObject({ owner_id: null, status: "with_closer" });
    expect((await leadRow(l2)).owner_id).toBe(CLOSER_2);
  });

  test("the auth e-mail matches the invite whatever its case", async () => {
    const token = await invite(OWNER_B, wsB, "Upper", "upper@b.example");
    const ok = await one<{ ws: string }>(UPPER, "select public.accept_workspace_invite($1) as ws", [token]);
    expect(ok.ws).toBe(wsB);
    expect(await db.admin("select role from public.workspace_members where user_id = $1", [UPPER])).toEqual([{ role: "closer" }]);
  });
});
