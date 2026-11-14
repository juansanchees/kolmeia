import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, anon, anonWithToken, as, setSchedulerToken, UUID_A } from "./helpers";
import { CIPHER, OTHER_TOKEN, TOKEN, createOwner, seedCampaign, type Seeded } from "./scheduler-seed";

// Migration 0005 (E1 scheduler): the token check, the lease, the grants and the dry-run-only limit live in the
// database. Real migrations, non-superuser roles (PGlite).

const ZERO = "00000000-0000-4000-8000-000000000000";
const ENTRY_POINTS: [string, unknown[]][] = [
  ["select public.scheduler_begin_run()", []],
  ["select public.scheduler_due_work($1)", [ZERO]],
  ["select public.scheduler_claim_next_email($1,$2)", [ZERO, ZERO]],
  ["select public.scheduler_finish_email_send($1,$2,'dry_run',null)", [ZERO, ZERO]],
  ["select public.scheduler_campaign($1,$2)", [ZERO, ZERO]],
  ["select public.scheduler_message($1,$2)", [ZERO, ZERO]],
  ["select public.scheduler_prospect($1,$2)", [ZERO, ZERO]],
  ["select public.scheduler_sender($1,$2)", [ZERO, ZERO]],
  ["select public.scheduler_finish_run($1,'{}'::jsonb,null)", [ZERO]],
];

let db: TestDb;
let ws: string;
let a: Seeded;
const code = (e: Error | undefined) => (e as (Error & { code?: string }) | undefined)?.code;
const as_clock = anonWithToken(TOKEN);

async function begin(): Promise<string> {
  const r = await db.query<{ r: { run_id: string; busy: boolean } }>(as_clock, "select public.scheduler_begin_run() as r");
  expect(r[0].r.busy).toBe(false);
  return r[0].r.run_id;
}
async function finish(run: string) {
  await db.query(as_clock, "select public.scheduler_finish_run($1,'{}'::jsonb,null)", [run]);
}

beforeAll(async () => {
  db = await TestDb.create();
  ws = await createOwner(db);
  a = await seedCampaign(db, ws, "alpha");
});
afterAll(async () => {
  await db.pg.close();
});

describe("the token is checked by the database, and the clock fails closed", () => {
  test("a missing, wrong, malformed or (clock off) any token is refused by every scheduler_* entry point with 42501", async () => {
    await setSchedulerToken(db, TOKEN);
    const cases = [anon, anonWithToken(OTHER_TOKEN), anonWithToken("not-hex"), anonWithToken(TOKEN.toUpperCase())];
    for (const actor of cases) {
      for (const [sql, params] of ENTRY_POINTS) {
        const r = await db.try(actor, sql, params);
        expect(code(r.error), sql).toBe("42501");
      }
    }
    await setSchedulerToken(db, null); // clock off: even the right token is refused
    for (const [sql, params] of ENTRY_POINTS) {
      const r = await db.try(as_clock, sql, params);
      expect(code(r.error), sql).toBe("42501");
    }
    expect(await db.admin("select 1 from public.scheduler_runs")).toHaveLength(0);
  });

  test("the header name is matched case-insensitively; a wrong token is still refused", async () => {
    await setSchedulerToken(db, TOKEN);
    const mixed = (t: string) => ({ ...anon, headers: { "X-Scheduler-Token": t } });
    const run = (await db.query<{ r: { run_id: string; busy: boolean } }>(mixed(TOKEN), "select public.scheduler_begin_run() as r"))[0].r;
    expect(run.busy).toBe(false);
    await finish(run.run_id);
    expect(code((await db.try(mixed(OTHER_TOKEN), "select public.scheduler_begin_run()")).error)).toBe("42501");
    const twice = { ...anon, headers: { "x-scheduler-token": TOKEN, "X-SCHEDULER-TOKEN": OTHER_TOKEN } };
    expect(code((await db.try(twice, "select public.scheduler_begin_run()")).error)).toBe("42501");
  });

  test("the right token opens a run; the stored value is only the hash", async () => {
    await setSchedulerToken(db, TOKEN);
    const run = await begin();
    const [s] = await db.admin<{ token_sha256: string; lease_run: string }>("select token_sha256, lease_run from public.scheduler_state");
    expect(s.token_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.token_sha256).not.toBe(TOKEN);
    expect(s.lease_run).toBe(run);
    await finish(run);
  });

  test("the hash column rejects anything that is not 64 hex characters", async () => {
    await expect(db.admin("update public.scheduler_state set token_sha256 = 'plain-token'")).rejects.toThrow(/scheduler_state_token/);
  });

  test("a logged-in owner cannot call scheduler_*, with or without the token header; helpers are not callable at all", async () => {
    for (const actor of [as(UUID_A), { ...as(UUID_A), headers: { "x-scheduler-token": TOKEN } }]) {
      for (const [sql, params] of ENTRY_POINTS) {
        expect((await db.try(actor, sql, params)).error?.message, sql).toMatch(/permission denied/);
      }
    }
    for (const actor of [as(UUID_A), as_clock]) {
      for (const sql of [
        "select public.scheduler_authorized()",
        "select public.scheduler_holds_lease(gen_random_uuid())",
        "select public.claim_next_email_core(gen_random_uuid(), gen_random_uuid(), null, null, null)",
        "select public.finish_email_send_core(gen_random_uuid(), gen_random_uuid(), 'failed', null)",
      ]) {
        expect((await db.try(actor, sql)).error?.message, sql).toMatch(/permission denied/);
      }
    }
  });
});

describe("tables", () => {
  test("RLS is enabled and forced; no policy; clients hold no privilege", async () => {
    const rows = await db.admin<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname in ('scheduler_state','scheduler_runs')",
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.relrowsecurity, r.relname).toBe(true);
      expect(r.relforcerowsecurity, r.relname).toBe(true);
    }
    expect(await db.admin("select 1 from pg_policies where tablename in ('scheduler_state','scheduler_runs')")).toHaveLength(0);
    for (const role of ["anon", "authenticated", "public"]) {
      for (const t of ["scheduler_state", "scheduler_runs"]) {
        for (const priv of ["select", "insert", "update", "delete"]) {
          const [r] = await db.admin<{ ok: boolean }>(`select has_table_privilege('${role}', 'public.${t}', '${priv}') as ok`);
          expect(r.ok, `${role} ${priv} ${t}`).toBe(false);
        }
      }
    }
    expect((await db.try(as_clock, "select token_sha256 from public.scheduler_state")).error?.message).toMatch(/permission denied/);
    expect((await db.try(as(UUID_A), "select * from public.scheduler_runs")).error?.message).toMatch(/permission denied/);
  });

  test("the error column holds a short code only", async () => {
    for (const bad of ["boom at sales@x.example", "Has Capitals", "", "x".repeat(61), "a b"]) {
      await expect(db.admin("insert into public.scheduler_runs (outcome, error) values ('error', $1)", [bad]), bad).rejects.toThrow(/scheduler_runs_error/);
    }
    await db.admin("insert into public.scheduler_runs (outcome, error) values ('error', 'compose:address')");
    await db.admin("delete from public.scheduler_runs");
  });
});

describe("the lease", () => {
  test("a second begin while a run is open is 'busy' and recorded; the first run keeps the lease", async () => {
    const run = await begin();
    const second = (await db.query<{ r: { run_id: string; busy: boolean } }>(as_clock, "select public.scheduler_begin_run() as r"))[0].r;
    expect(second.busy).toBe(true);
    expect(second.run_id).not.toBe(run);
    const rows = await db.admin<{ id: string; outcome: string; finished_at: Date | null }>("select id, outcome, finished_at from public.scheduler_runs where id in ($1,$2) order by started_at", [run, second.run_id]);
    expect(rows.find((r) => r.id === second.run_id)).toMatchObject({ outcome: "busy" });
    expect(rows.find((r) => r.id === second.run_id)!.finished_at).not.toBeNull();
    expect((await db.admin<{ lease_run: string }>("select lease_run from public.scheduler_state"))[0].lease_run).toBe(run);
    // the busy run never gets the lease, so it cannot read or claim anything
    expect((await db.try(as_clock, "select public.scheduler_due_work($1)", [second.run_id])).error?.message).toMatch(/lease not held/);
    await finish(run);
    expect((await db.admin<{ lease_run: string | null }>("select lease_run from public.scheduler_state"))[0].lease_run).toBeNull();
  });

  test("a run that never finished is closed as lease_expired when the lease runs out and a new tick starts", async () => {
    const run = await begin();
    await db.admin("update public.scheduler_state set lease_until = now() - interval '1 second'");
    expect((await db.try(as_clock, "select public.scheduler_due_work($1)", [run])).error?.message).toMatch(/lease not held/);
    const next = await begin();
    expect(next).not.toBe(run);
    expect((await db.admin<{ outcome: string; error: string }>("select outcome, error from public.scheduler_runs where id = $1", [run]))[0]).toEqual({ outcome: "error", error: "lease_expired" });
    await finish(next);
  });

  test("finish_run records counts, refuses a closed run, and prunes rows older than 30 days", async () => {
    await db.admin("insert into public.scheduler_runs (started_at, outcome, finished_at) values (now() - interval '31 days', 'ok', now() - interval '31 days')");
    const run = await begin();
    await db.query(as_clock, "select public.scheduler_finish_run($1, $2::jsonb, 'send_failed')", [run, JSON.stringify({ campaigns: 3, sent: 2, failed: 1 })]);
    expect((await db.admin("select campaigns, sent, failed, outcome, error from public.scheduler_runs where id = $1", [run]))[0]).toEqual({ campaigns: 3, sent: 2, failed: 1, outcome: "error", error: "send_failed" });
    expect((await db.try(as_clock, "select public.scheduler_finish_run($1,'{}'::jsonb,null)", [run])).error?.message).toMatch(/not open/);
    expect(await db.admin("select 1 from public.scheduler_runs where started_at < now() - interval '30 days'")).toHaveLength(0);
  });

  test("begin_run itself prunes heartbeat rows older than 30 days", async () => {
    await db.admin("insert into public.scheduler_runs (started_at, outcome, finished_at) values (now() - interval '45 days', 'ok', now() - interval '45 days')");
    const run = await begin();
    expect(await db.admin("select 1 from public.scheduler_runs where started_at < now() - interval '30 days'")).toHaveLength(0);
    await finish(run);
  });

  test("due_work and claim push the lease forward", async () => {
    const s = await seedCampaign(db, ws, "lease");
    const run = await begin();
    const lease = async () => (await db.admin<{ secs: number }>("select extract(epoch from (lease_until - now()))::float as secs from public.scheduler_state"))[0].secs;
    await db.admin("update public.scheduler_state set lease_until = now() + interval '10 seconds'");
    await db.query(as_clock, "select public.scheduler_due_work($1)", [run]);
    expect(await lease()).toBeGreaterThan(100);
    await db.admin("update public.scheduler_state set lease_until = now() + interval '10 seconds'");
    await db.query(as_clock, "select public.scheduler_claim_next_email($1,$2)", [run, s.campaign]);
    expect(await lease()).toBeGreaterThan(100);
    await finish(run);
  });

  test("every function except begin_run needs the open lease (a stranger's run id is refused)", async () => {
    const run = await begin();
    for (const [sql, params] of ENTRY_POINTS.slice(1, 8)) {
      expect((await db.try(as_clock, sql, [ZERO, ...params.slice(1)])).error?.message, sql).toMatch(/lease not held/);
    }
    await finish(run);
  });
});

describe("rehearsal only, and only what the run holds", () => {
  test("due_work lists active rehearsal campaigns with an approved due message, and nothing else", async () => {
    const paused = await seedCampaign(db, ws, "paused", { status: "paused" });
    const draftOnly = await seedCampaign(db, ws, "unapproved", { approve: false });
    const real = await seedCampaign(db, ws, "realmode");
    await db.admin("update public.email_campaigns set send_mode = 'real' where id = $1", [real.campaign]);
    const run = await begin();
    const r = (await db.query<{ r: { campaign_ids: string[] } }>(as_clock, "select public.scheduler_due_work($1) as r", [run]))[0].r;
    expect(r.campaign_ids).toContain(a.campaign);
    for (const other of [paused, draftOnly, real]) expect(r.campaign_ids).not.toContain(other.campaign);
    expect((await db.query<{ r: unknown }>(as_clock, "select public.scheduler_campaign($1,$2) as r", [run, real.campaign]))[0].r).toBeNull();
    await finish(run);
  });

  test("the scheduler claim answers not_active for a real-mode campaign, before touching anything", async () => {
    const real = await seedCampaign(db, ws, "realclaim");
    await db.admin("update public.email_campaigns set send_mode = 'real' where id = $1", [real.campaign]);
    const run = await begin();
    const r = (await db.query<{ r: { outcome: string } }>(as_clock, "select public.scheduler_claim_next_email($1,$2) as r", [run, real.campaign]))[0].r;
    expect(r).toEqual({ outcome: "not_active" });
    expect(await db.admin("select 1 from public.email_send_log where campaign_id = $1", [real.campaign])).toHaveLength(0);
    expect((await db.admin<{ status: string }>("select status from public.email_messages where id = $1", [real.messages[0]]))[0].status).toBe("approved");
    await finish(run);
  });

  test("a claim as the scheduler has no person (claimed_by null) and the run as holder; helpers see only what the run holds", async () => {
    const s = await seedCampaign(db, ws, "held");
    const run = await begin();
    const claim = (await db.query<{ r: { outcome: string; message_id: string } }>(as_clock, "select public.scheduler_claim_next_email($1,$2) as r", [run, s.campaign]))[0].r;
    expect(claim.outcome).toBe("claimed");
    const [msg] = await db.admin<{ claimed_by: string | null; claim_holder: string; send_mode: string }>("select claimed_by, claim_holder, send_mode from public.email_messages where id = $1", [claim.message_id]);
    expect(msg).toEqual({ claimed_by: null, claim_holder: run, send_mode: "dry_run" });
    const [log] = await db.admin<{ claimed_by: string | null; holder: string; mode: string }>("select claimed_by, holder, mode from public.email_send_log where message_id = $1", [claim.message_id]);
    expect(log).toEqual({ claimed_by: null, holder: run, mode: "dry_run" });

    const got = async (sql: string, params: unknown[]) => (await db.query<{ r: Record<string, unknown> | null }>(as_clock, sql, params))[0].r;
    const m = await got("select public.scheduler_message($1,$2) as r", [run, claim.message_id]);
    expect(Object.keys(m!).sort()).toEqual(["body", "campaign_id", "from_address", "id", "in_reply_to", "kind", "mailbox_id", "prospect_id", "rfc_message_id", "send_mode", "status", "subject", "to_address", "workspace_id"]);
    const p = await got("select public.scheduler_prospect($1,$2) as r", [run, s.prospects[0]]);
    expect(Object.keys(p!).sort()).toEqual(["id", "unsub_token"]);
    expect(await got("select public.scheduler_sender($1,$2) as r", [run, ws])).toMatchObject({ sender_name: "Juan Sanches" });
    // another message of the same workspace that this run does NOT hold is invisible, and so is another prospect
    expect(await got("select public.scheduler_message($1,$2) as r", [run, a.messages[0]])).toBeNull();
    expect(await got("select public.scheduler_prospect($1,$2) as r", [run, a.prospects[0]])).toBeNull();
    // finishing a message this run does not hold is refused
    expect((await db.try(as_clock, "select public.scheduler_finish_email_send($1,$2,'dry_run',null)", [run, a.messages[0]])).error?.message).toMatch(/not allowed/);
    // a rehearsal can only end as dry_run or failed, never 'sent'
    expect((await db.try(as_clock, "select public.scheduler_finish_email_send($1,$2,'sent',null)", [run, claim.message_id])).error?.message).toMatch(/send mode/);
    await db.query(as_clock, "select public.scheduler_finish_email_send($1,$2,'dry_run',null)", [run, claim.message_id]);
    expect((await db.admin<{ status: string }>("select status from public.email_messages where id = $1", [claim.message_id]))[0].status).toBe("dry_run");
    await finish(run);
  });

  test("the clock never claims a reply message; the person's path still can", async () => {
    const s = await seedCampaign(db, ws, "replyclock", { n: 1 });
    const reply = (await db.query<{ r: string }>(as(UUID_A), "select public.record_email_reply($1,$2,null,'jo@replyclock.example','Re: Quick question','Call me','<rc1@replyclock.example>',now(),'reply',null) as r", [s.prospects[0], s.mailbox]))[0].r;
    const m = (await db.query<{ id: string }>(as(UUID_A), "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, reply_to_id, subject, body) values ($1,$2,$3,'reply',$4,'Re: Quick question','Hi, sure.') returning id", [ws, s.campaign, s.prospects[0], reply]))[0].id;
    await db.query(as(UUID_A), "select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')", [m]);
    expect((await db.admin<{ status: string }>("select status from public.email_messages where id = $1", [m]))[0].status).toBe("approved");
    const run = await begin();
    const due = (await db.query<{ r: { campaign_ids: string[] } }>(as_clock, "select public.scheduler_due_work($1) as r", [run]))[0].r;
    expect(due.campaign_ids).not.toContain(s.campaign);
    const r = (await db.query<{ r: { outcome: string } }>(as_clock, "select public.scheduler_claim_next_email($1,$2) as r", [run, s.campaign]))[0].r;
    expect(r.outcome).toBe("nothing_due");
    expect((await db.admin<{ status: string }>("select status from public.email_messages where id = $1", [m]))[0].status).toBe("approved");
    await finish(run);
    const u = (await db.query<{ r: { outcome: string; message_id: string } }>(as(UUID_A), "select public.claim_next_email($1, gen_random_uuid(), $2) as r", [s.campaign, m]))[0].r;
    expect(u).toMatchObject({ outcome: "claimed", message_id: m });
  });

  test("no scheduler function can return the mailbox ciphertext", async () => {
    const fns = await db.admin<{ proname: string; prosrc: string; ret: string }>(
      "select proname, prosrc, pg_get_function_result(oid) as ret from pg_proc where pronamespace = 'public'::regnamespace and proname like 'scheduler\\_%'",
    );
    expect(fns.length).toBeGreaterThanOrEqual(11);
    for (const f of fns) {
      expect(f.prosrc, f.proname).not.toMatch(/ciphertext|mailbox_secret|public\.mailboxes/i);
      expect(["jsonb", "void", "boolean"], f.proname).toContain(f.ret);
    }
    // and nothing a scheduler function returned in this suite contained it
    const run = await begin();
    const s = await seedCampaign(db, ws, "nocipher");
    const claim = (await db.query<{ r: { message_id: string } }>(as_clock, "select public.scheduler_claim_next_email($1,$2) as r", [run, s.campaign]))[0].r;
    const out = JSON.stringify([
      await db.query(as_clock, "select public.scheduler_campaign($1,$2) as r", [run, s.campaign]),
      await db.query(as_clock, "select public.scheduler_message($1,$2) as r", [run, claim.message_id]),
      await db.query(as_clock, "select public.scheduler_sender($1,$2) as r", [run, ws]),
      await db.query(as_clock, "select public.scheduler_due_work($1) as r", [run]),
    ]);
    expect(out).not.toContain(CIPHER);
    await finish(run);
  });

  test("the core functions never return or mention the mailbox ciphertext", async () => {
    const fns = await db.admin<{ proname: string; prosrc: string; ret: string }>(
      "select proname, prosrc, pg_get_function_result(oid) as ret from pg_proc where pronamespace = 'public'::regnamespace and proname in ('claim_next_email_core','finish_email_send_core')",
    );
    expect(fns).toHaveLength(2);
    for (const f of fns) {
      expect(f.prosrc, f.proname).not.toMatch(/secret_ciphertext|ciphertext/i);
      expect(["jsonb", "void"], f.proname).toContain(f.ret);
    }
    const s = await seedCampaign(db, ws, "corecipher");
    const run = await begin();
    const claim = (await db.query<{ r: Record<string, unknown> }>(as_clock, "select public.scheduler_claim_next_email($1,$2) as r", [run, s.campaign]))[0];
    const fin = await db.query(as_clock, "select public.scheduler_finish_email_send($1,$2,'dry_run',null)", [run, (claim.r as { message_id: string }).message_id]);
    const out = JSON.stringify([claim, fin]);
    expect(out).toContain("claimed");
    expect(out).not.toContain(CIPHER);
    expect(out).not.toMatch(/ciphertext/i);
    await finish(run);
  });
});

describe("the user path is unchanged by the refactor", () => {
  test("claim_next_email as the owner still stamps the person (claimed_by = user) and keeps its checks", async () => {
    const s = await seedCampaign(db, ws, "userpath");
    const r = (await db.query<{ r: { outcome: string; message_id: string } }>(as(UUID_A), "select public.claim_next_email($1, gen_random_uuid()) as r", [s.campaign]))[0].r;
    expect(r.outcome).toBe("claimed");
    expect((await db.admin<{ claimed_by: string }>("select claimed_by from public.email_send_log where message_id = $1", [r.message_id]))[0].claimed_by).toBe(UUID_A);
    expect((await db.try(anon, "select public.claim_next_email($1, gen_random_uuid())", [s.campaign])).error?.message).toMatch(/permission denied/);
    expect((await db.try(as(UUID_A), "select public.claim_next_email(gen_random_uuid(), gen_random_uuid())")).error?.message).toMatch(/not allowed/);
  });
});

describe("the work list is fair", () => {
  test("25 blocked campaigns ahead of one healthy one do not starve it: it is listed within 2 ticks; incomplete sender profiles are skipped", async () => {
    const db2 = await TestDb.create();
    try {
      const ws2 = await createOwner(db2);
      const blocked: string[] = [];
      for (let i = 0; i < 25; i++) blocked.push((await seedCampaign(db2, ws2, `blk${i}`)).campaign);
      const healthy = await seedCampaign(db2, ws2, "healthy");
      // the blocked ones are the oldest due, so they always win the old ordering
      await db2.admin("update public.email_messages set due_at = now() - interval '2 days' where campaign_id = any($1::uuid[])", [blocked]);
      await setSchedulerToken(db2, TOKEN);
      const tick = async () => {
        const run = (await db2.query<{ r: { run_id: string } }>(as_clock, "select public.scheduler_begin_run() as r"))[0].r.run_id;
        const ids = (await db2.query<{ r: { campaign_ids: string[] } }>(as_clock, "select public.scheduler_due_work($1) as r", [run]))[0].r.campaign_ids;
        await db2.query(as_clock, "select public.scheduler_finish_run($1,'{}'::jsonb,null)", [run]);
        return ids;
      };
      const t1 = await tick();
      expect(t1).toHaveLength(20);
      expect(t1).not.toContain(healthy.campaign);
      const t2 = await tick();
      expect(t2).toContain(healthy.campaign);
      expect((await db2.admin<{ scheduler_tried_at: Date | null }>("select scheduler_tried_at from public.email_campaigns where id = $1", [healthy.campaign]))[0].scheduler_tried_at).not.toBeNull();
      // a client cannot write the marker
      expect((await db2.try(as(UUID_A), "update public.email_campaigns set scheduler_tried_at = null where id = $1", [healthy.campaign])).error?.message).toMatch(/permission denied/);
      // incomplete sender profile: nothing is listed
      await db2.admin("delete from public.sender_profiles");
      expect(await tick()).toEqual([]);
    } finally {
      await db2.pg.close();
    }
  }, 120_000);
});
