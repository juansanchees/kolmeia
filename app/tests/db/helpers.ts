import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
/** Every migration, in file-name order (0001_..., 0002_...). */
export const MIGRATION_PATHS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort()
  .map((f) => path.join(MIGRATIONS_DIR, f));

/** What Supabase provides before any app migration runs. */
const SUPABASE_BOOTSTRAP = `
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;

  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid
    language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;

  -- Supabase default privileges on schema public (tables and functions are open to the API roles).
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

/** `headers`: what PostgREST would expose to SQL as request.headers (the scheduler token travels this way). */
export type Actor = { role: "anon"; headers?: Record<string, string> } | { role: "authenticated"; userId: string; headers?: Record<string, string> };
export const anon: Actor = { role: "anon" };
export const as = (userId: string): Actor => ({ role: "authenticated", userId });
/** The public key plus the scheduler token header, as the clock's route calls the database. */
export const anonWithToken = (token: string): Actor => ({ role: "anon", headers: { "x-scheduler-token": token } });

export class TestDb {
  constructor(readonly pg: PGlite) {}

  static async create(): Promise<TestDb> {
    const pg = new PGlite();
    await pg.exec(SUPABASE_BOOTSTRAP);
    for (const file of MIGRATION_PATHS) await pg.exec(readFileSync(file, "utf8")); // the real migrations, unchanged
    return new TestDb(pg);
  }

  /** Superuser (bypasses RLS): test setup only. */
  async admin<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pg.query<T>(sql, params);
    return r.rows;
  }

  /** A signed-up user. `ai` also puts them on the AI allowlist (public.ai_access, 0004), as the operator would. */
  async addUser(id: string, ai = true): Promise<void> {
    await this.admin("insert into auth.users (id) values ($1)", [id]);
    if (ai) await this.grantAi(id);
  }

  async grantAi(id: string): Promise<void> {
    await this.admin("insert into public.ai_access (user_id) values ($1) on conflict do nothing", [id]);
  }

  /** Runs `fn` inside a transaction with the role and JWT claim set, like PostgREST does. Always rolls back unless commit. */
  async run<T>(actor: Actor, fn: (q: Query) => Promise<T>, commit = false): Promise<T> {
    await this.pg.exec("begin");
    try {
      await this.pg.exec(`set local role ${actor.role}`);
      if (actor.role === "authenticated") {
        await this.pg.query("select set_config('request.jwt.claim.sub', $1, true)", [actor.userId]);
      }
      if (actor.headers) await this.pg.query("select set_config('request.headers', $1, true)", [JSON.stringify(actor.headers)]);
      const q: Query = async (sql, params = []) => (await this.pg.query(sql, params)).rows as never;
      const out = await fn(q);
      await this.pg.exec(commit ? "commit" : "rollback");
      return out;
    } catch (e) {
      await this.pg.exec("rollback");
      throw e;
    }
  }

  /** One statement as an actor, committed. Returns rows. */
  query<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
    return this.run(actor, (q) => q(sql, params) as Promise<T[]>, true);
  }

  /** One statement as an actor, rolled back. Resolves { rows } or { error }. */
  async try<T = Record<string, unknown>>(
    actor: Actor,
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[]; error?: undefined } | { rows?: undefined; error: Error }> {
    try {
      const rows = await this.run(actor, (q) => q(sql, params) as Promise<T[]>, false);
      return { rows };
    } catch (e) {
      return { error: e as Error };
    }
  }
}

export type TryResult<T> = { rows: T[]; error?: undefined } | { rows?: undefined; error: Error };

/** Like `try`, but COMMITS, so deferred constraint triggers (P1/P9) fire. */
export async function tryCommit<T = Record<string, unknown>>(db: TestDb, actor: Actor, sql: string, params: unknown[] = []): Promise<TryResult<T>> {
  try {
    return { rows: await db.query<T>(actor, sql, params) };
  } catch (e) {
    return { error: e as Error };
  }
}

export type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

export const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const UUID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/**
 * E-mail tests only (superuser setup, never in a migration): `public.test_versions(ids)` returns the updated_at of
 * each message as the caller can see it (or now() for one they cannot see), standing in for the version the
 * screen sends back with an approval (R1).
 */
export async function installEmailTestHelpers(db: TestDb): Promise<void> {
  await db.pg.exec(`
    create or replace function public.test_versions(p uuid[]) returns timestamptz[]
      language sql stable set search_path = '' as $$
        select array(
          select coalesce((select m.updated_at from public.email_messages m where m.id = u.id), now())
            from unnest(p) with ordinality as u(id, ord)
           order by u.ord)
      $$;
  `);
}

/**
 * Test-only clock travel: moves every claim back in time, in the messages and in the append-only send log (its
 * trigger is switched off for this superuser statement only, then on again).
 */
export async function ageEmailClaims(db: TestDb, seconds: number): Promise<void> {
  await db.pg.exec(`
    alter table public.email_send_log disable trigger guard_email_send_log;
    update public.email_messages set claimed_at = claimed_at - interval '${Math.trunc(seconds)} seconds' where claimed_at is not null;
    update public.email_send_log set claimed_at = claimed_at - interval '${Math.trunc(seconds)} seconds';
    alter table public.email_send_log enable trigger guard_email_send_log;
  `);
}

/** Scheduler tests only (superuser setup): stores the sha256 of `token` the way the owner's setup script does; null switches the clock off. */
export async function setSchedulerToken(db: TestDb, token: string | null): Promise<void> {
  await db.admin("update public.scheduler_state set token_sha256 = case when $1::text is null then null else encode(sha256(convert_to($1::text, 'UTF8')), 'hex') end where id = 1", [token]);
}

/** E2 test fixture: gates that never get in the way of tests about other rules (window always open, 60-180 s gap as before E2). */
export async function openGates(db: TestDb, campaignId: string): Promise<void> {
  await db.admin("update public.email_campaigns set window_start = '00:00', window_end = '24:00', send_days = '{1,2,3,4,5,6,7}', min_gap_minutes = 1, random_gap_minutes = 2 where id = $1", [campaignId]);
}
/**
 * E2 test-only: back-dates email_send_log.claimed_at by 2 days for every row of a sequence message (the timestamp the
 * one-person-per-company rule reads), so the rule sees no claim today. Side effect, by design: those rows also fall out
 * of today's mailbox/campaign counters and of the gap. Use only in tests that send to several people of one company.
 */
export async function endCompanyDay(db: TestDb): Promise<void> {
  await db.pg.exec(`
    alter table public.email_send_log disable trigger guard_email_send_log;
    update public.email_send_log l set claimed_at = l.claimed_at - interval '2 days'
     where exists (select 1 from public.email_messages m where m.id = l.message_id and m.kind = 'sequence');
    alter table public.email_send_log enable trigger guard_email_send_log;
  `);
}
/** SQL for send_days without today and tomorrow in the campaign's own zone (use inside an UPDATE of email_campaigns). */
export const NOT_TODAY =
  "array(select d from generate_series(1, 7) d where d <> extract(isodow from now() at time zone email_campaigns.timezone) and d <> extract(isodow from (now() at time zone email_campaigns.timezone) + interval '1 day'))::smallint[]";
