import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, anon, as, UUID_A, UUID_B, UUID_C } from "./helpers";

// R8: "Workspace A never reads or writes data of workspace B", tested against real Postgres (PGlite)
// with the real migration file and non-superuser roles, so Row Level Security is actually enforced.

const UUID_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
let db: TestDb;
let wsA: string;
let wsB: string;
let wsB2: string; // workspace of B with NO profile yet

async function createWorkspace(userId: string, name: string): Promise<string> {
  const rows = await db.query<{ create_workspace: string }>(as(userId), "select public.create_workspace($1)", [name]);
  return rows[0].create_workspace;
}

const PROFILE = `(workspace_id, what_we_do, service_area, wanted_work, good_customer, not_wanted)`;

beforeAll(async () => {
  db = await TestDb.create();
  for (const id of [UUID_A, UUID_B, UUID_C, UUID_D]) await db.addUser(id);
  wsA = await createWorkspace(UUID_A, "Empresa A");
  wsB = await createWorkspace(UUID_B, "Empresa B");
  wsB2 = await createWorkspace(UUID_B, "Empresa B2");
  // C is made a member of A by the migration role: clients cannot insert member rows any more (see security.test.ts)
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr')", [wsA, UUID_C]);
  await db.query(as(UUID_A), `insert into public.company_profiles ${PROFILE} values ($1,'A faz HVAC','MA','{commercial}','x','y')`, [wsA]);
  await db.query(as(UUID_B), `insert into public.company_profiles ${PROFILE} values ($1,'B faz HVAC','NH','{maintenance}','x','y')`, [wsB]);
});

afterAll(async () => {
  await db.pg.close();
});

describe("proof that RLS is really enforced in PGlite", () => {
  test("API roles are plain roles (no superuser, no bypassrls)", async () => {
    const rows = await db.admin<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('anon','authenticated')",
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.rolsuper).toBe(false);
      expect(r.rolbypassrls).toBe(false);
    }
  });

  test("a policy blocks rows: superuser sees all workspaces, authenticated A sees only its own", async () => {
    const all = await db.admin("select id from public.workspaces");
    expect(all).toHaveLength(3);
    const mine = await db.query<{ id: string }>(as(UUID_A), "select id from public.workspaces");
    expect(mine.map((r) => r.id)).toEqual([wsA]);
    const who = await db.query<{ current_user: string }>(as(UUID_A), "select current_user");
    expect(who[0].current_user).toBe("authenticated");
  });

  test("all three tables have RLS enabled and forced", async () => {
    const rows = await db.admin<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relname in ('workspaces','workspace_members','company_profiles')`,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.relrowsecurity).toBe(true);
      expect(r.relforcerowsecurity).toBe(true);
    }
  });

  test("no policy is granted to anon or public", async () => {
    const rows = await db.admin<{ roles: string[] }>(
      "select roles::text[] as roles from pg_policies where schemaname = 'public'",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.roles).toEqual(["authenticated"]);
  });

  test("security definer functions pin an empty search_path", async () => {
    const rows = await db.admin<{ proname: string; proconfig: string[] | null }>(
      `select proname, proconfig from pg_proc
       where pronamespace = 'public'::regnamespace and prosecdef`,
    );
    expect(rows.map((r) => r.proname).sort()).toEqual(
      [
        // 0001
        "create_workspace", "guard_last_owner", "handle_new_workspace", "is_workspace_member", "is_workspace_owner",
        // 0002
        "add_ai_cost_to_run", "ai_spend_today", "claim_research_step", "guard_research_list_item", "release_research_step",
        "require_research_evidence", "run_in_workspace", "stamp_research_check", "stamp_research_evidence",
        // 0004 (add_research_check became SECURITY DEFINER: it replaces evidence on retry)
        "add_research_check", "ai_spend_today_global", "ai_spend_today_user", "reserve_ai_call", "settle_ai_call",
        // 0003
        "cancel_pending_steps", "claim_campaign_draft", "claim_next_email", "finish_email_send", "hand_off_prospect",
        "import_list_into_campaign", "is_suppressed", "is_workspace_sender", "list_in_workspace", "mailbox_in_workspace",
        "mailbox_secret", "mailbox_usage", "record_email_reply", "release_campaign_draft", "retry_failed_email", "save_mailbox",
        "sender_profile_complete", "set_campaign_send_mode", "set_email_approval", "set_mailbox_verified", "set_reply_class",
        "unsubscribe_by_token", "claim_test_email", "finish_test_email", "guard_email_campaign_delete",
        "reset_prospect_approvals", "save_closer_brief", "confirm_possible_bounce",
        // 0005 (scheduler: definer functions are the only way anon reaches the clock; *_core functions are NOT definer)
        "scheduler_authorized", "scheduler_begin_run", "scheduler_campaign", "scheduler_claim_next_email", "scheduler_due_work",
        "scheduler_finish_email_send", "scheduler_finish_run", "scheduler_holds_lease", "scheduler_message", "scheduler_prospect", "scheduler_renew_lease",
        "scheduler_sender",
        // 0009 (leads: the database links candidates to leads; clients have no grant on these)
        "archive_agent_runs", "backfill_leads", "link_candidate_lead", "link_lead", "unlink_candidate_lead",
        // 0009 J2 (the closer sees research proof only through her assigned leads)
        "candidate_visible_to_assignee", "check_visible_to_assignee",
        // 0011 (lists: one duplicate rule for candidates and imports; closer reads fields of her leads)
        "find_lead", "lead_visible_to_assignee", "create_lead_import", "preview_import_rows", "import_lead_rows", "finish_lead_import", "undo_lead_import",
        // 0010 (hunter path: token-gated, anon-only entry points; hunter_assert / *_core / hunter_check_keys are NOT definer)
        "cancel_agent_runs_on_delete", "hunter_add_candidates", "hunter_add_check", "hunter_add_jobs", "hunter_add_sources",
        "hunter_begin_tick", "hunter_candidates", "hunter_checks", "hunter_claim_step", "hunter_due_work", "hunter_finish_tick",
        "hunter_get_run", "hunter_jobs", "hunter_known_companies", "hunter_pause_agent", "hunter_profile", "hunter_release_step",
        "hunter_reserve_ai_call", "hunter_settle_ai_call", "hunter_sources", "hunter_update_candidate", "hunter_update_run",
        // 0013 (connected sources: keys only through owner RPCs, searches only through enqueue_source_run; the import core has no grant)
        "import_rows_core", "list_source_connections", "set_source_connection", "set_source_cap", "delete_source_connection",
        "source_secret", "set_agent_source_settings", "enqueue_source_run",
        // 0013 (source tick path: token-gated, anon-only; source_assert_tick is NOT definer)
        "source_begin_tick", "source_finish_tick", "source_enqueue_agent_runs", "source_next_work", "source_mark_started", "source_mark_failed", "source_import",
        // 0014 (Qualificador: values copied from candidates, lead level, settings row per workspace, queue, cost per lead)
        "copy_candidate_fields", "copy_candidate_fields_trg", "delete_candidate_fields", "lead_level", "refresh_lead_level",
        "level_from_lead_fields", "level_from_check", "level_from_evidence", "level_from_candidate", "ack_level_note",
        "create_workspace_qualifier", "qualifier_workspace_cap", "enqueue_lead_for_qualifier", "requeue_lead_on_import",
        "add_ai_cost_to_lead", "qualifier_spent_today", "qualifier_status",
        // 0014 part 2 (Qualificador path: token-gated, anon-only; qualifier_assert is NOT definer)
        "qualifier_begin_tick", "qualifier_finish_tick", "qualifier_claim_next", "qualifier_merge", "qualifier_add_fields",
        "qualifier_refute", "qualifier_step_done", "qualifier_release", "qualifier_pause", "qualifier_reserve_ai_call",
        "qualifier_settle_ai_call", "request_qualification",
      ].sort(),
    );
    for (const r of rows) expect(r.proconfig).toContain("search_path=\"\"");
  });

  test("every public function pins an empty search_path", async () => {
    const rows = await db.admin<{ proname: string; proconfig: string[] | null }>(
      `select proname, proconfig from pg_proc where pronamespace = 'public'::regnamespace`,
    );
    for (const r of rows) expect(r.proconfig, r.proname).toContain("search_path=\"\"");
  });
});

describe("user A cannot touch workspace B (workspaces)", () => {
  test("select", async () => {
    const r = await db.try(as(UUID_A), "select * from public.workspaces where id = $1", [wsB]);
    expect(r.rows).toHaveLength(0);
  });
  test("insert as another user is refused", async () => {
    const r = await db.try(as(UUID_A), "insert into public.workspaces (name, created_by) values ('x', $1)", [UUID_B]);
    expect(r.error?.message).toMatch(/permission denied/);
  });
  test("update affects 0 rows", async () => {
    const r = await db.try(as(UUID_A), "update public.workspaces set name = 'hacked' where id = $1 returning id", [wsB]);
    expect(r.rows).toHaveLength(0);
  });
  test("delete affects 0 rows", async () => {
    const r = await db.try(as(UUID_A), "delete from public.workspaces where id = $1 returning id", [wsB]);
    expect(r.rows).toHaveLength(0);
  });
});

describe("user A cannot touch workspace B (workspace_members)", () => {
  test("select", async () => {
    const r = await db.try(as(UUID_A), "select * from public.workspace_members where workspace_id = $1", [wsB]);
    expect(r.rows).toHaveLength(0);
  });
  test("cannot add themselves to B's workspace", async () => {
    const r = await db.try(as(UUID_A), "insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'owner')", [wsB, UUID_A]);
    expect(r.error?.message).toMatch(/permission denied/);
  });
  test("cannot add someone else to B's workspace", async () => {
    const r = await db.try(as(UUID_A), "insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr')", [wsB, UUID_C]);
    expect(r.error?.message).toMatch(/permission denied/);
  });
  test("update affects 0 rows", async () => {
    const r = await db.try(as(UUID_A), "update public.workspace_members set role = 'sdr' where workspace_id = $1 returning user_id", [wsB]);
    expect(r.rows).toHaveLength(0);
  });
  test("delete affects 0 rows", async () => {
    const r = await db.try(as(UUID_A), "delete from public.workspace_members where workspace_id = $1 returning user_id", [wsB]);
    expect(r.rows).toHaveLength(0);
  });
});

describe("user A cannot touch workspace B (company_profiles)", () => {
  test("select", async () => {
    const r = await db.try(as(UUID_A), "select * from public.company_profiles where workspace_id = $1", [wsB]);
    expect(r.rows).toHaveLength(0);
  });
  test("insert into B's workspace is refused", async () => {
    const r = await db.try(as(UUID_A), `insert into public.company_profiles ${PROFILE} values ($1,'a','b','{}','c','d')`, [wsB2]);
    expect(r.error?.message).toMatch(/row-level security/);
  });
  test("update affects 0 rows", async () => {
    const r = await db.try(as(UUID_A), "update public.company_profiles set what_we_do = 'hacked' where workspace_id = $1 returning workspace_id", [wsB]);
    expect(r.rows).toHaveLength(0);
  });
  test("cannot move own profile row into B's workspace", async () => {
    const r = await db.try(as(UUID_A), "update public.company_profiles set workspace_id = $1 where workspace_id = $2", [wsB2, wsA]);
    expect(r.error?.message).toMatch(/permission denied/); // column grant: workspace_id is not updatable by clients
  });
  test("delete affects 0 rows", async () => {
    const r = await db.try(as(UUID_A), "delete from public.company_profiles where workspace_id = $1 returning workspace_id", [wsB]);
    expect(r.rows).toHaveLength(0);
  });
});

describe("anon sees nothing and writes nothing", () => {
  for (const table of ["workspaces", "workspace_members", "company_profiles"]) {
    test(`select on ${table} is denied`, async () => {
      const r = await db.try(anon, `select * from public.${table}`);
      expect(r.error?.message).toMatch(/permission denied/);
    });
  }
  test("insert/update/delete are denied", async () => {
    const stmts = [
      "insert into public.workspaces (name, created_by) values ('x', '" + UUID_A + "')",
      "update public.workspaces set name = 'x'",
      "delete from public.workspaces",
      "insert into public.workspace_members (workspace_id, user_id) values ('" + wsA + "', '" + UUID_A + "')",
      "delete from public.workspace_members",
      "update public.company_profiles set what_we_do = 'x'",
      "delete from public.company_profiles",
    ];
    for (const s of stmts) {
      const r = await db.try(anon, s);
      expect(r.error?.message, s).toMatch(/permission denied/);
    }
  });
  test("anon cannot call the RPC or the helpers", async () => {
    for (const s of [
      "select public.create_workspace('x')",
      `select public.is_workspace_member('${wsA}')`,
      `select public.is_workspace_owner('${wsA}')`,
    ]) {
      const r = await db.try(anon, s);
      expect(r.error?.message, s).toMatch(/permission denied/);
    }
  });
});

describe("members of a workspace", () => {
  test("owner A reads the workspace, both member rows and the profile", async () => {
    expect(await db.query(as(UUID_A), "select id from public.workspaces")).toHaveLength(1);
    const members = await db.query(as(UUID_A), "select user_id from public.workspace_members where workspace_id = $1", [wsA]);
    expect(members).toHaveLength(2);
    expect(await db.query(as(UUID_A), "select 1 from public.company_profiles")).toHaveLength(1);
  });

  test("sdr C reads the workspace, its members and its profile", async () => {
    const ws = await db.query<{ id: string }>(as(UUID_C), "select id from public.workspaces");
    expect(ws.map((r) => r.id)).toEqual([wsA]);
    expect(await db.query(as(UUID_C), "select user_id from public.workspace_members")).toHaveLength(2);
    expect(await db.query(as(UUID_C), "select 1 from public.company_profiles")).toHaveLength(1);
  });

  test("sdr C can update the profile (updated_by is set to the caller by the trigger)", async () => {
    const r = await db.try<{ what_we_do: string; updated_by: string }>(
      as(UUID_C),
      "update public.company_profiles set what_we_do = 'novo' where workspace_id = $1 returning what_we_do, updated_by",
      [wsA],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows![0].what_we_do).toBe("novo");
    expect(r.rows![0].updated_by).toBe(UUID_C);
  });

  test("a member can insert the profile of a workspace that has none", async () => {
    const r = await db.try(as(UUID_B), `insert into public.company_profiles ${PROFILE} values ($1,'a','b','{commercial}','c','d') returning workspace_id`, [wsB2]);
    expect(r.rows).toHaveLength(1);
  });

  test("sdr C cannot add, change or remove members", async () => {
    const ins = await db.try(as(UUID_C), "insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr')", [wsA, UUID_D]);
    expect(ins.error?.message).toMatch(/permission denied/);
    const upd = await db.try(as(UUID_C), "update public.workspace_members set role = 'owner' where user_id = $1 returning user_id", [UUID_C]);
    expect(upd.rows).toHaveLength(0);
    const del = await db.try(as(UUID_C), "delete from public.workspace_members where workspace_id = $1 returning user_id", [wsA]);
    expect(del.rows).toHaveLength(0);
  });

  test("sdr C cannot rename or delete the workspace, nor delete the profile", async () => {
    const upd = await db.try(as(UUID_C), "update public.workspaces set name = 'x' where id = $1 returning id", [wsA]);
    expect(upd.rows).toHaveLength(0);
    const del = await db.try(as(UUID_C), "delete from public.workspaces where id = $1 returning id", [wsA]);
    expect(del.rows).toHaveLength(0);
    const delP = await db.try(as(UUID_C), "delete from public.company_profiles where workspace_id = $1 returning workspace_id", [wsA]);
    expect(delP.rows).toHaveLength(0);
  });

  test("owner A can rename the workspace, remove members, delete the profile", async () => {
    const ren = await db.try(as(UUID_A), "update public.workspaces set name = 'Novo nome' where id = $1 returning id", [wsA]);
    expect(ren.rows).toHaveLength(1);
    const add = await db.try(as(UUID_A), "insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'closer') returning user_id", [wsA, UUID_D]);
    expect(add.error?.message).toMatch(/permission denied/); // no client insert in this phase
    const rm = await db.try(as(UUID_A), "delete from public.workspace_members where workspace_id = $1 and user_id = $2 returning user_id", [wsA, UUID_C]);
    expect(rm.rows).toHaveLength(1);
    const delP = await db.try(as(UUID_A), "delete from public.company_profiles where workspace_id = $1 returning workspace_id", [wsA]);
    expect(delP.rows).toHaveLength(1);
  });

  test("a user with no membership cannot add themselves to workspace A", async () => {
    const r = await db.try(as(UUID_D), "insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'owner')", [wsA, UUID_D]);
    expect(r.error?.message).toMatch(/permission denied/);
    expect(await db.query(as(UUID_D), "select 1 from public.workspaces")).toHaveLength(0);
  });
});

describe("workspace creation", () => {
  test("create_workspace makes the creator an owner", async () => {
    const r = await db.run(as(UUID_D), async (q) => {
      const [{ create_workspace: id }] = await q<{ create_workspace: string }>("select public.create_workspace('  Nova Co  ')");
      const members = await q<{ user_id: string; role: string }>("select user_id, role from public.workspace_members where workspace_id = $1", [id]);
      const ws = await q<{ name: string; created_by: string }>("select name, created_by from public.workspaces where id = $1", [id]);
      return { members, ws };
    });
    expect(r.members).toEqual([{ user_id: UUID_D, role: "owner" }]);
    expect(r.ws).toEqual([{ name: "Nova Co", created_by: UUID_D }]);
  });

  test("create_workspace rejects blank and overlong names", async () => {
    expect((await db.try(as(UUID_D), "select public.create_workspace('   ')")).error).toBeDefined();
    expect((await db.try(as(UUID_D), "select public.create_workspace($1)", ["x".repeat(81)])).error).toBeDefined();
    expect((await db.try(as(UUID_D), "select public.create_workspace(null)")).error).toBeDefined();
  });

  test("a user cannot create a workspace as another user (direct insert)", async () => {
    const r = await db.try(as(UUID_D), "insert into public.workspaces (name, created_by) values ('x', $1)", [UUID_A]);
    expect(r.error?.message).toMatch(/permission denied/);
  });

  test("a direct insert on workspaces is refused, even as self (creation only through the RPC)", async () => {
    const r = await db.try(as(UUID_D), "insert into public.workspaces (id, name, created_by) values ($1, 'Direta', $2)", [UUID_C, UUID_D]);
    expect(r.error?.message).toMatch(/permission denied/);
  });
});

describe("data constraints", () => {
  test("unknown wanted_work value is rejected by the database", async () => {
    const r = await db.try(as(UUID_B), "update public.company_profiles set wanted_work = '{residential}' where workspace_id = $1", [wsB]);
    expect(r.error?.message).toMatch(/wanted_work/);
  });
});
