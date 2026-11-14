# E2 Portões Novos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the four missing sending gates (send window in the campaign's time zone, per-campaign daily limit on a local calendar day, 9 + 5 min gap, one person per company per day) inside the database claim, with tests that prove each "no".
**Architecture:** One new migration `0006_gates.sql` adds 7 columns to `email_campaigns`, plain (non-definer) SQL helpers, and a new body for `claim_next_email_core` (both wrappers from 0005 keep calling it unchanged). The app only learns two new outcome codes, their pt-BR messages and a read-only schedule line on the campaign page; the clock's tick already treats unknown outcomes as "nothing sent".
**Tech Stack:** Next.js 16.4.5, TypeScript, Supabase/Postgres (RLS forced), vitest 5 + PGlite.
**Spec:** kolmeia/docs/engenharia-envio.html sections 03, 05, 06, 07 (+ this plan's Decisions section)

`APP` = `kolmeia/app`. Every command runs from `APP`.

## Decisions (fixed by the owner, copied verbatim into the code)
- Columns on `email_campaigns`: `timezone text not null default 'America/New_York'` (valid IANA), `window_start time not null default '09:00'`, `window_end time not null default '18:00'` (start < end), `send_days smallint[] not null default '{1,2,3,4,5}'` (ISO 1=Mon..7=Sun, non-empty, 1-7), `daily_limit integer not null default 30` (1..500), `min_gap_minutes integer not null default 9` (0..120), `random_gap_minutes integer not null default 5` (0..60). Clients: read yes, write no.
- Window: claimable only when the local ISO weekday is in `send_days` and `window_start <= local time < window_end`. Outcome `outside_window`.
- Daily limit: mailbox (`least(mailboxes.daily_limit, 50)`, by sending address, per mode, as today) and campaign (`email_campaigns.daily_limit`), both counted from local midnight of the campaign's `timezone`. Mailbox keeps `daily_limit`; campaign answers `campaign_limit`.
- Gap: `min_gap_minutes * 60 + floor(random() * (random_gap_minutes * 60 + 1))` seconds, per mailbox address (defaults: 540..840 s).
- Company: per workspace, per local day, at most one prospect per company with a sequence message claimed. Key = `candidate_id::text`, else lowercased non-free-mail e-mail domain, else `lower(btrim(company_name))`. Free-mail list: gmail.com, googlemail.com, outlook.com, hotmail.com, live.com, yahoo.com, icloud.com, me.com, aol.com, proton.me, protonmail.com. Same prospect again the same day: allowed. Blocked candidate: skipped, no outcome code.
- Scope: kind 'sequence', both paths (person and clock), both modes. Kind 'reply' is exempt from window, company rule and campaign limit.
- Implementation choices made by this plan (reported to the owner): `window_end = '24:00'` is allowed (all-day window); time zone check = regex `^[A-Za-z]+(/[A-Za-z0-9_+-]+)+$` or `UTC`, then Postgres must accept it (abbreviations like `EST` are refused); `wait_until` of both limits = next local midnight; `outside_window` has no `wait_until`; the campaign counter counts every send-log row of the campaign in that mode (reply claims count, but are never blocked by it); the company rule counts claims of the same send mode (a rehearsal day and a real day are separate, like the limits); a per-workspace advisory lock serialises claims so two mailboxes cannot both pick the same company; `scheduler_due_work` is unchanged.

## Global Constraints
- Migration: create `APP/supabase/migrations/0006_gates.sql`; never edit 0001-0005.
- No new SECURITY DEFINER function: the exact list in `tests/db/rls.test.ts` stays as is. Every new function has `set search_path = ''`.
- New helpers: `revoke all ... from public, anon, authenticated`, except `is_iana_timezone(text)`: `revoke all from public, anon; grant execute to authenticated` (it runs inside a check constraint as the inserting client, like `is_email_address`).
- No client grant on the 7 new columns (0003 grants table-level SELECT, column-level INSERT/UPDATE only for older columns: nothing to add).
- Claim order in 0006: stale sweep → `not_active` → `outside_window` → `no_mailbox` / mailbox row lock / address lock / `mailbox_not_verified` / `no_sender_profile` → `daily_limit` → `campaign_limit` → `gap` → suppression → candidate select (company rule inside the select).
- Legacy tests changed to the new rule (and only these): `tests/db/email-rls.test.ts` "a second claim inside the 60-180 s gap waits; after the gap it goes" (Task 4) and "the daily limit (rolling 24 h, per sending address) is never exceeded, even by recreating the mailbox" (Task 3); comments in `tests/unit/rules/email.test.ts` L17, `tests/db/scheduler-seed.ts` L23, `tests/engine/scheduler.test.ts` L139. Other legacy tests keep their assertions; their fixtures get `openGates` (window always open, gap 1 + 2 min = the old 60-180 s) and email-rls `claim` gets `endCompanyDay`.
- Keep the stale-claim sweep, `for update` on the mailbox row, the address advisory lock and `for update of x skip locked` where they are in 0005.
- No fake clock in production SQL: helpers take an explicit `p_at timestamptz`; the claim passes `now()`. Tests move time with `ageEmailClaims`, with settings relative to the real instant, or by calling the pure helpers with fixed instants.
- No git in `kolmeia/`. "Checkpoint" = run the command shown. Backup of pre-E2 code: `kolmeia/.backups/app-E1-2026-11-13.tgz`.
- Dry-run only: nothing enables real sending. No new env vars, no service-role key, no `console.*` in `src/lib/email` (guards test).
- Baseline: `npm run check` green, 635 tests passing.

## Review Focus
1. **Daylight-saving change day** (2026-03-08 and 2026-11-01 in America/New_York: 23 h and 25 h days). Owner: Task 1. Pin: `local day bounds survive DST`.
2. **A window that never opens** (empty or out-of-range `send_days`, invalid zone, `window_start >= window_end`). Owner: Task 1. Pin: `E2 columns: defaults, checks, readable and not writable by clients`.
3. **One mailbox shared by two campaigns in different zones.** Owner: Task 3. Pin: `a mailbox shared by campaigns in two zones counts from each claiming campaign's own midnight`.
4. **Free-mail address with a messy company name** (blank names are impossible: 0003 `email_prospects_company_len`; trimmed/upper-case variants must merge, different names on gmail must not). Owner: Task 5. Pin: `free-mail addresses fall back to the trimmed, lowercased company name`.
5. **A follow-up due while another person of the same company was mailed today.** Owner: Task 5. Pin: `a follow-up of the same person may go the same day; another person of a company mailed today waits`.

---

## File Structure
| File | Responsibility |
|---|---|
| `APP/supabase/migrations/0006_gates.sql` (create) | columns + checks, helpers, widened gap checks, new `claim_next_email_core` body |
| `APP/tests/db/gates.test.ts` (create) | DB tests of every gate on the real migrations |
| `APP/tests/db/helpers.ts` (modify, append) | `openGates`, `endCompanyDay`, `NOT_TODAY` test fixtures |
| `APP/tests/db/scheduler-seed.ts` (modify ~L20-50) | seeded campaigns get `openGates`; comment about the gap |
| `APP/tests/db/email-rls.test.ts` (modify L69-139, L517-567) | fixtures open the gates; two legacy R2 tests updated to the new rule |
| `APP/tests/engine/email-engine.test.ts` (modify L98) | fixture opens the gates |
| `APP/tests/engine/scheduler.test.ts` (modify, append + L139 comment) | tick and sendStep with the two new outcomes |
| `APP/tests/unit/rules/email.test.ts` (modify L17, L33) | R2 comment, R7 becomes covered |
| `APP/tests/unit/email-schedule.test.ts` (create) | schedule line formatting + outcome messages |
| `APP/src/lib/email/types.ts` (modify L37-51, L161-169) | new campaign columns, new outcomes |
| `APP/src/lib/email/schedule.ts` (modify, append) | `scheduleParts()` |
| `APP/src/messages/pt/email.ts` (modify `campaign` ~L160, `send.outcomes` L191-204) | pt-BR texts |
| `APP/src/app/(app)/email/campanhas/[id]/page.tsx` (modify L61) | read-only schedule line |
| `APP/src/lib/email/scheduler.ts` (L78 comment), `APP/src/components/email/ReplyControls.tsx` (L91 comment) | wording only |
| `APP/README.md` (modify L39, L55, L65, new section) | sending rules in Portuguese, migrations 0005 + 0006 |

---

### Task 1: Columns, helpers and test fixtures

**Files:** Create `APP/supabase/migrations/0006_gates.sql`, `APP/tests/db/gates.test.ts`. Modify `APP/tests/db/helpers.ts` (append), `APP/tests/db/scheduler-seed.ts` (after L50), `APP/tests/db/email-rls.test.ts` (L75-82 seedWorkspace campaign insert, L104-109 freshCampaign, L138-139 `claim`), `APP/tests/engine/email-engine.test.ts` (after L98).
**Interfaces:** Produces SQL `public.is_iana_timezone(p_tz text) returns boolean` (immutable), `public.local_day_start(p_tz text, p_at timestamptz) returns timestamptz`, `public.local_day_end(p_tz text, p_at timestamptz) returns timestamptz`, `public.in_send_window(p_tz text, p_start time, p_end time, p_days smallint[], p_at timestamptz) returns boolean`, `public.company_key(p_candidate uuid, p_email text, p_company text) returns text` (immutable), `public.campaign_claims_since(p_campaign uuid, p_mode text, p_since timestamptz) returns integer` (all stable unless noted). TS: `openGates(db: TestDb, campaignId: string): Promise<void>`, `endCompanyDay(db: TestDb): Promise<void>`, `NOT_TODAY: string`.

- [ ] Step 1: Write the failing tests in `tests/db/gates.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, as, UUID_A } from "./helpers";
import { createOwner } from "./scheduler-seed";

// Migration 0006 (E2 "Portões novos"): window, time zone, campaign limit, 9 + 5 min gap, one person per company [R2] [R7].
let db: TestDb;
let ws: string;
beforeAll(async () => { db = await TestDb.create(); ws = await createOwner(db); });
afterAll(async () => { await db.pg.close(); });
const iso = (d: unknown) => new Date(d as string).toISOString();

describe("0006 settings and helpers", () => {
  test("E2 columns: defaults, checks, readable and not writable by clients", async () => {
    const [c] = await db.query<Record<string, unknown>>(as(UUID_A),
      "insert into public.email_campaigns (workspace_id, name) values ($1,'Defaults') returning id, timezone, window_start, window_end, send_days, daily_limit, min_gap_minutes, random_gap_minutes", [ws]);
    expect(c).toMatchObject({ timezone: "America/New_York", window_start: "09:00:00", window_end: "18:00:00", send_days: [1, 2, 3, 4, 5], daily_limit: 30, min_gap_minutes: 9, random_gap_minutes: 5 });
    const bad = ["timezone = 'Mars/Base'", "timezone = 'EST'", "timezone = '+05'", "timezone = ''", "window_start = '18:00', window_end = '09:00'",
      "window_start = '09:00', window_end = '09:00'", "send_days = '{}'", "send_days = '{0}'", "send_days = '{8}'", "send_days = '{1,NULL}'",
      "daily_limit = 0", "daily_limit = 501", "min_gap_minutes = -1", "min_gap_minutes = 121", "random_gap_minutes = -1", "random_gap_minutes = 61"];
    for (const s of bad) await expect(db.admin(`update public.email_campaigns set ${s} where id = $1`, [c.id]), s).rejects.toThrow(/check constraint/);
    await db.admin("update public.email_campaigns set timezone = 'Asia/Tokyo', window_start = '00:00', window_end = '24:00', send_days = '{6,7}', daily_limit = 500, min_gap_minutes = 0, random_gap_minutes = 60 where id = $1", [c.id]);
    await db.admin("update public.email_campaigns set timezone = 'UTC' where id = $1", [c.id]);
    for (const s of ["timezone = 'UTC'", "window_start = '08:00'", "window_end = '17:00'", "send_days = '{1}'", "daily_limit = 10", "min_gap_minutes = 1", "random_gap_minutes = 1"]) {
      expect((await db.try(as(UUID_A), `update public.email_campaigns set ${s} where id = $1`, [c.id])).error?.message, s).toMatch(/permission denied/);
    }
    expect((await db.try(as(UUID_A), "insert into public.email_campaigns (workspace_id, name, daily_limit) values ($1,'x',5)", [ws])).error?.message).toMatch(/permission denied/);
  });

  test("local day bounds survive DST (23 h and 25 h days)", async () => {
    const [r] = await db.admin(`select
      public.local_day_start('America/New_York','2026-03-08T12:00:00Z') as s1, public.local_day_end('America/New_York','2026-03-08T12:00:00Z') as e1,
      public.local_day_start('America/New_York','2026-11-01T12:00:00Z') as s2, public.local_day_end('America/New_York','2026-11-01T12:00:00Z') as e2,
      public.local_day_start('Asia/Tokyo','2026-11-13T20:00:00Z') as s3`);
    expect([iso(r.s1), iso(r.e1), iso(r.s2), iso(r.e2), iso(r.s3)]).toEqual([
      "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z", "2026-11-13T15:00:00.000Z"]);
  });

  test("in_send_window: weekday, start inclusive, end exclusive, zone and DST", async () => {
    const w = async (tz: string, at: string, start = "09:00", end = "18:00", days = "{1,2,3,4,5}") =>
      (await db.admin<{ ok: boolean }>("select public.in_send_window($1,$2::time,$3::time,$4::smallint[],$5::timestamptz) as ok", [tz, start, end, days, at]))[0].ok;
    const NY = "America/New_York";
    expect(await w(NY, "2026-11-16T14:00:00Z")).toBe(true);   // Mon 09:00 EST
    expect(await w(NY, "2026-11-16T13:59:59Z")).toBe(false);
    expect(await w(NY, "2026-11-16T22:59:59Z")).toBe(true);
    expect(await w(NY, "2026-11-16T23:00:00Z")).toBe(false);  // 18:00 is outside
    expect(await w(NY, "2026-11-14T15:00:00Z")).toBe(false);  // Saturday
    expect(await w(NY, "2026-03-09T13:30:00Z")).toBe(true);   // Mon 09:30 EDT
    expect(await w(NY, "2026-03-06T13:30:00Z")).toBe(false);  // Fri 08:30 EST
    expect(await w("America/Los_Angeles", "2026-11-16T14:30:00Z")).toBe(false);
    expect(await w("Europe/London", "2026-11-16T14:30:00Z")).toBe(true);
    expect(await w("Asia/Tokyo", "2026-11-16T14:30:00Z")).toBe(false);
    expect(await w("UTC", "2026-11-14T23:59:59Z", "00:00", "24:00", "{1,2,3,4,5,6,7}")).toBe(true);
  });

  test("company_key: research company, then business domain, then the company name", async () => {
    const k = async (cand: string | null, email: string | null, name: string) =>
      (await db.admin<{ k: string }>("select public.company_key($1::uuid,$2,$3) as k", [cand, email, name]))[0].k;
    const id = "0b5e5e5e-0000-4000-8000-000000000001";
    expect(await k(id, "a@acme.example", "Acme")).toBe(id);
    expect(await k(null, "Pat@Acme.Example", "Acme")).toBe("acme.example");
    expect(await k(null, "pat@gmail.com", "  Acme Builders ")).toBe("acme builders");
    expect(await k(null, "x@ProtonMail.com", "Beta")).toBe("beta");
    expect(await k(null, null, "Gamma")).toBe("gamma");
  });
});
```
- [ ] Step 2: `npx vitest run tests/db/gates.test.ts` → FAIL: `column "timezone" does not exist` / `function public.local_day_start(...) does not exist`.
- [ ] Step 3: Implement `0006_gates.sql` (header comment in the style of 0005: what E2 adds, which rules, that the wrappers are untouched). Order: `is_iana_timezone` first, then `alter table public.email_campaigns add column if not exists ...` for the 7 columns with named constraints `email_campaigns_timezone` (`public.is_iana_timezone(timezone)`), `email_campaigns_send_days` (`cardinality(send_days) between 1 and 7 and send_days <@ '{1,2,3,4,5,6,7}'::smallint[]`), `email_campaigns_daily_limit`, `email_campaigns_min_gap`, `email_campaigns_random_gap`, plus table constraint `email_campaigns_window check (window_start < window_end)`; then the helpers; then the revokes/grant from Global Constraints. Logic the tests do not determine:
```sql
create or replace function public.is_iana_timezone(p_tz text) returns boolean
language plpgsql immutable set search_path = '' as $$
begin
  if p_tz is null or (p_tz <> 'UTC' and p_tz !~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+)+$') then return false; end if;
  perform timestamptz '2000-01-01 00:00:00+00' at time zone p_tz;   -- Postgres must know the zone
  return true;
exception when others then return false;
end $$;
-- local midnight -> instant (DST-safe: the arithmetic is done on the local wall clock)
--   local_day_start: select date_trunc('day', p_at at time zone p_tz) at time zone p_tz;
--   local_day_end:   select (date_trunc('day', p_at at time zone p_tz) + interval '1 day') at time zone p_tz;
-- in_send_window:
--   select extract(isodow from p_at at time zone p_tz)::smallint = any (p_days)
--      and (p_at at time zone p_tz)::time >= p_start and (p_at at time zone p_tz)::time < p_end;
-- company_key:
--   select coalesce(p_candidate::text,
--     case when split_part(lower(p_email), '@', 2) not in ('', 'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
--       'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com') then split_part(lower(p_email), '@', 2) end,
--     lower(btrim(p_company)));
-- campaign_claims_since (mirrors address_claims_since: every result, strict >):
--   select count(*)::integer from public.email_send_log l where l.campaign_id = p_campaign and l.mode = p_mode and l.claimed_at > p_since;
```
  Then the fixtures in `tests/db/helpers.ts`:
```ts
/** E2 test fixture: gates that never get in the way of tests about other rules (window always open, 60-180 s gap as before E2). */
export async function openGates(db: TestDb, campaignId: string): Promise<void> {
  await db.admin("update public.email_campaigns set window_start = '00:00', window_end = '24:00', send_days = '{1,2,3,4,5,6,7}', min_gap_minutes = 1, random_gap_minutes = 2 where id = $1", [campaignId]);
}
/** E2 test-only: claimed sequence messages move 2 days back, so the one-person-per-company rule sees no claim today (the send log, limits and gap, is untouched). */
export async function endCompanyDay(db: TestDb): Promise<void> {
  await db.admin("update public.email_messages set claimed_at = claimed_at - interval '2 days' where claimed_at is not null and kind = 'sequence'");
}
/** SQL for send_days without today and tomorrow in the campaign's own zone (use inside an UPDATE of email_campaigns). */
export const NOT_TODAY =
  "array(select d from generate_series(1, 7) d where d <> extract(isodow from now() at time zone email_campaigns.timezone) and d <> extract(isodow from (now() at time zone email_campaigns.timezone) + interval '1 day'))::smallint[]";
```
  Call `openGates` in `seedCampaign` (scheduler-seed.ts, right after the campaign insert; change the L23 comment to "the gap (fixture: 1 + 2 min) and the daily limit"), in email-rls `seedWorkspace` and `freshCampaign` (right after each campaign insert), and in email-engine `beforeAll` after `ids.camp`. In email-rls make `claim` call `await endCompanyDay(db)` before the RPC (cross-test campaigns reuse the same research candidate).
- [ ] Step 4: `npx vitest run tests/db/gates.test.ts` → 4 passed.
- [ ] Step 5: Checkpoint `npx vitest run` → 639 passed, 0 failed (the claim is not changed yet).

### Task 2: Gate "Dentro do horário" (window and time zone)

**Files:** Modify `0006_gates.sql` (append the new `claim_next_email_core`), `tests/db/gates.test.ts`.
**Interfaces:** Consumes `in_send_window`, `NOT_TODAY`, `openGates` (via `seedCampaign`). Produces `claim_next_email_core(p_campaign uuid, p_holder uuid, p_message uuid, p_actor uuid, p_only_mode text) returns jsonb` (same signature as 0005) answering `{"outcome":"outside_window"}`; test helpers `claim`, `finish`, `set`, `clockClaim`, `answerReply` in gates.test.ts.

- [ ] Step 1: Add to `gates.test.ts` (imports: `anonWithToken, setSchedulerToken, ageEmailClaims, NOT_TODAY` from helpers; `seedCampaign, TOKEN, type Seeded` from scheduler-seed):
```ts
type Claim = { outcome: string; message_id?: string; wait_until?: string };
const HOLDER = "22222222-2222-4222-8222-222222222222";
const claim = async (camp: string, user = UUID_A, message: string | null = null) =>
  (await db.query<{ r: Claim }>(as(user), "select public.claim_next_email($1,$2,$3) as r", [camp, HOLDER, message]))[0].r;
const finish = (msg: string, user = UUID_A) => db.query(as(user), "select public.finish_email_send($1,$2,'dry_run',null)", [msg, HOLDER]);
const set = (camp: string, sql: string) => db.admin(`update public.email_campaigns set ${sql} where id = $1`, [camp]);
async function clockClaim(camp: string): Promise<Claim> {
  await setSchedulerToken(db, TOKEN);
  const clock = anonWithToken(TOKEN);
  const run = (await db.query<{ r: { run_id: string } }>(clock, "select public.scheduler_begin_run() as r"))[0].r.run_id;
  const r = (await db.query<{ r: Claim }>(clock, "select public.scheduler_claim_next_email($1,$2) as r", [run, camp]))[0].r;
  await db.query(clock, "select public.scheduler_finish_run($1,'{}'::jsonb,null)", [run]);
  return r;
}
/** The prospect of `sent` replies; a person writes and approves an answer. Returns the answer's id. */
async function answerReply(s: Seeded, sent: string): Promise<string> {
  const p = (await db.admin<{ id: string; email: string }>("select p.id, p.email from public.email_messages m join public.email_prospects p on p.id = m.prospect_id where m.id = $1", [sent]))[0];
  const reply = (await db.query<{ r: string }>(as(UUID_A), "select public.record_email_reply($1,$2,$3,$4,'Re: Quick question','Sounds good',$5,now(),'reply',null) as r", [p.id, s.mailbox, sent, p.email, `<r-${sent}@x.example>`]))[0].r;
  const a = (await db.query<{ id: string }>(as(UUID_A), "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, reply_to_id, subject, body) values ($1,$2,$3,'reply',$4,'Re: Quick question','Hi, sure.') returning id", [ws, s.campaign, p.id, reply]))[0].id;
  await db.query(as(UUID_A), "select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')", [a]);
  return a;
}

describe("E2 gate 3: Dentro do horário", () => {
  test("outside the window nothing is claimed on the user path, the clock path and in real mode; inside it is", async () => {
    const s = await seedCampaign(db, ws, "win");
    await set(s.campaign, `send_days = ${NOT_TODAY}`);
    expect(await claim(s.campaign)).toEqual({ outcome: "outside_window" });
    expect(await clockClaim(s.campaign)).toEqual({ outcome: "outside_window" });
    await set(s.campaign, "send_mode = 'real'");   // unverified mailbox: the window answers first
    expect(await claim(s.campaign)).toEqual({ outcome: "outside_window" });
    await set(s.campaign, "send_mode = 'dry_run', send_days = '{1,2,3,4,5,6,7}'");
    expect(await db.admin("select 1 from public.email_send_log where campaign_id = $1", [s.campaign])).toHaveLength(0);
    expect(await clockClaim(s.campaign)).toMatchObject({ outcome: "claimed", message_id: s.messages[0] });
  });

  test("the window is read in the campaign's own time zone", async () => {
    // UTC+14 and UTC-11 are never on the same calendar day
    const k = await seedCampaign(db, ws, "tzkir");
    const p = await seedCampaign(db, ws, "tzpago");
    const today = "array[extract(isodow from now() at time zone 'Pacific/Kiritimati')]::smallint[]";
    await set(k.campaign, `timezone = 'Pacific/Kiritimati', send_days = ${today}`);
    await set(p.campaign, `timezone = 'Pacific/Pago_Pago', send_days = ${today}`);
    expect(await claim(k.campaign)).toMatchObject({ outcome: "claimed", message_id: k.messages[0] });
    expect(await claim(p.campaign)).toEqual({ outcome: "outside_window" });
  });

  test("an answer to a reply is exempt from the window (sequence steps still wait)", async () => {
    const s = await seedCampaign(db, ws, "winreply", { n: 2 });
    await set(s.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    const first = (await claim(s.campaign)).message_id!;
    await finish(first);
    const answer = await answerReply(s, first);
    await set(s.campaign, `send_days = ${NOT_TODAY}`);
    expect(await claim(s.campaign)).toMatchObject({ outcome: "claimed", message_id: answer });
    await finish(answer);
    expect(await claim(s.campaign)).toEqual({ outcome: "outside_window" });
  });
});
```
- [ ] Step 2: `npx vitest run tests/db/gates.test.ts -t "gate 3"` → FAIL: the claims answer `claimed` / `nothing_due` instead of `outside_window`.
- [ ] Step 3: In `0006_gates.sql`, append `create or replace function public.claim_next_email_core(...)` as a copy of 0005 L57-201 plus `revoke all on function public.claim_next_email_core(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;`. Declare `v_seq_open boolean; v_reply_due boolean;`. Right after the `not_active` check (0005 L92-94), insert:
```sql
  -- E2 gate 3: sequence steps only inside the campaign's window (its own time zone); answers to replies are exempt
  v_seq_open := public.in_send_window(c.timezone, c.window_start, c.window_end, c.send_days, now());
  v_reply_due := p_only_mode is null and exists (
    select 1 from public.email_messages r
     where r.campaign_id = c.id and r.kind = 'reply' and r.status = 'approved' and r.due_at <= now());
  if p_message is null and not v_seq_open and not v_reply_due then
    return jsonb_build_object('outcome', 'outside_window');
  end if;
```
  and in the candidate select change the sequence branch to `(p_message is null and v_seq_open and c.status = 'active' and x.kind = 'sequence' ...`.
- [ ] Step 4: `npx vitest run tests/db/gates.test.ts` → 7 passed.
- [ ] Step 5: Checkpoint `npx vitest run` → 642 passed, 0 failed.

### Task 3: Gate "Limite do dia" (local calendar day, mailbox and campaign)

**Files:** Modify `0006_gates.sql` (claim body), `tests/db/gates.test.ts`, `tests/db/email-rls.test.ts` L542-566.
**Interfaces:** Consumes `local_day_start`, `local_day_end`, `campaign_claims_since`, `answerReply`, `claim`, `finish`, `set`. Produces outcomes `{"outcome":"daily_limit","wait_until": local_day_end(tz, now())}` and `{"outcome":"campaign_limit","wait_until": local_day_end(tz, now())}`; local variable `v_day_start timestamptz` (used again in Task 5).

- [ ] Step 1: Add tests:
```ts
const dayEnd = async (tz: string) => iso((await db.admin<{ e: Date }>("select public.local_day_end($1, now()) as e", [tz]))[0].e);
const mailboxLimit = (mb: string, n: number) => db.query(as(UUID_A), "update public.mailboxes set daily_limit = $2 where id = $1", [mb, n]);

describe("E2 gate 4: Limite do dia", () => {
  test("the mailbox limit counts from local midnight of the campaign's zone, not the last 24 h", async () => {
    const s = await seedCampaign(db, ws, "mbday", { n: 2 });
    await set(s.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    await mailboxLimit(s.mailbox, 1);
    await finish((await claim(s.campaign)).message_id!);
    const lim = await claim(s.campaign);
    expect(lim.outcome).toBe("daily_limit");
    expect(iso(lim.wait_until)).toBe(await dayEnd("America/New_York"));
    const [{ secs }] = await db.admin<{ secs: number }>("select ceil(extract(epoch from now() - public.local_day_start('America/New_York', now())))::int + 60 as secs");
    await ageEmailClaims(db, secs);   // the claim is now 1 min before local midnight: inside the last 24 h, but yesterday
    expect((await claim(s.campaign)).outcome).toBe("claimed");
  });

  test("a mailbox shared by campaigns in two zones counts from each claiming campaign's own midnight", async () => {
    const ny = await seedCampaign(db, ws, "shny", { n: 2 });
    const tk = await seedCampaign(db, ws, "shtk", { n: 2 });
    await set(ny.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    await set(tk.campaign, `mailbox_id = '${ny.mailbox}', timezone = 'Asia/Tokyo', min_gap_minutes = 0, random_gap_minutes = 0`);
    await mailboxLimit(ny.mailbox, 1);
    await finish((await claim(ny.campaign)).message_id!);
    const [r] = await db.admin<{ secs: number; ny_later: boolean }>(`select ceil(extract(epoch from now() - greatest(a, b)))::int + 60 as secs, a > b as ny_later
      from (select public.local_day_start('America/New_York', now()) a, public.local_day_start('Asia/Tokyo', now()) b) t`);
    await ageEmailClaims(db, r.secs);   // 1 min before the later midnight: "today" in one zone, "yesterday" in the other
    const [later, earlier] = r.ny_later ? [ny.campaign, tk.campaign] : [tk.campaign, ny.campaign];
    expect((await claim(earlier)).outcome).toBe("daily_limit");
    expect((await claim(later)).outcome).toBe("claimed");
  });

  test("campaign_limit stops the campaign at its own limit; the lower limit wins; replies are exempt", async () => {
    const s = await seedCampaign(db, ws, "cplim", { n: 3 });
    await set(s.campaign, "daily_limit = 1, min_gap_minutes = 0, random_gap_minutes = 0");
    const first = (await claim(s.campaign)).message_id!;
    await finish(first);
    const c = await claim(s.campaign);
    expect(c.outcome).toBe("campaign_limit");
    expect(iso(c.wait_until)).toBe(await dayEnd("America/New_York"));
    expect(await clockClaim(s.campaign)).toMatchObject({ outcome: "campaign_limit" });
    await set(s.campaign, "daily_limit = 5");
    await mailboxLimit(s.mailbox, 1);
    expect((await claim(s.campaign)).outcome).toBe("daily_limit");
    await mailboxLimit(s.mailbox, 30);
    await set(s.campaign, "daily_limit = 1");
    const answer = await answerReply(s, first);
    expect(await claim(s.campaign)).toMatchObject({ outcome: "claimed", message_id: answer });
  });
});
```
  Update the legacy test in `email-rls.test.ts` L542: rename to `"the daily limit (calendar day in the campaign's time zone, per sending address) is never exceeded, even by recreating the mailbox"` and, for the third claim of the loop, assert `expect(new Date(c.wait_until!).toISOString()).toBe(new Date((await db.admin<{ e: Date }>("select public.local_day_end('America/New_York', now()) as e"))[0].e).toISOString())` when `c.outcome === "daily_limit"`. All other assertions stay.
- [ ] Step 2: `npx vitest run tests/db/gates.test.ts -t "gate 4"` → FAIL: the first test claims the second message only after the rolling 24 h (`daily_limit` after ageing), `wait_until` is oldest + 24 h, `campaign_limit` never appears.
- [ ] Step 3: In the claim body: declare `v_day_start timestamptz`; set `v_day_start := public.local_day_start(c.timezone, now());` right after the window block; replace the mailbox limit block (0005 L112-119) by `address_claims_since(b.email, c.send_mode, v_day_start) >= v_limit` returning `'wait_until', public.local_day_end(c.timezone, now())` (drop `v_oldest`); then, before the gap block:
```sql
  -- E2 gate 4: the campaign's own limit, same calendar day; answers to replies are exempt
  if p_message is null and v_seq_open
     and public.campaign_claims_since(c.id, c.send_mode, v_day_start) >= c.daily_limit then
    v_seq_open := false;
    if not v_reply_due then
      return jsonb_build_object('outcome', 'campaign_limit', 'wait_until', public.local_day_end(c.timezone, now()));
    end if;
  end if;
```
- [ ] Step 4: `npx vitest run tests/db/gates.test.ts tests/db/email-rls.test.ts` → all pass (gates: 10).
- [ ] Step 5: Checkpoint `npx vitest run` → 645 passed, 0 failed.

### Task 4: Gate "Intervalo" (9 + 5 min)

**Files:** Modify `0006_gates.sql` (constraints + one line of the claim body), `tests/db/gates.test.ts`, `tests/db/email-rls.test.ts` L518-532.
**Interfaces:** Consumes `campaign.min_gap_minutes`, `campaign.random_gap_minutes`. Produces stored `email_messages.next_gap_seconds` and `email_send_log.gap_seconds` in `0..10800`.

- [ ] Step 1: Add tests:
```ts
describe("E2 gate 5: Intervalo", () => {
  test("the gap is 9 min + up to 5 min drawn per claim (540-840 s), stored on the message and the log", async () => {
    const s = await seedCampaign(db, ws, "gapa", { n: 2 });
    await set(s.campaign, "min_gap_minutes = 9, random_gap_minutes = 5");
    const c1 = await claim(s.campaign);
    await finish(c1.message_id!);
    const [g] = await db.admin<{ next_gap_seconds: number; gap_seconds: number }>("select m.next_gap_seconds, l.gap_seconds from public.email_messages m join public.email_send_log l on l.message_id = m.id where m.id = $1", [c1.message_id]);
    expect(g.next_gap_seconds).toBeGreaterThanOrEqual(540);
    expect(g.next_gap_seconds).toBeLessThanOrEqual(840);
    expect(g.gap_seconds).toBe(g.next_gap_seconds);
    const w = await claim(s.campaign);
    expect(w.outcome).toBe("gap");
    expect(new Date(w.wait_until!).getTime() - Date.now()).toBeGreaterThan(500_000);
    await ageEmailClaims(db, g.next_gap_seconds - 30);
    expect((await claim(s.campaign)).outcome).toBe("gap");
    await ageEmailClaims(db, 31);
    expect((await claim(s.campaign)).outcome).toBe("claimed");
  });

  test("0 + 0 means no gap; 120 + 60 is accepted (up to 10800 s)", async () => {
    const s = await seedCampaign(db, ws, "gapb", { n: 3 });
    await set(s.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    await finish((await claim(s.campaign)).message_id!);
    await set(s.campaign, "min_gap_minutes = 120, random_gap_minutes = 60");
    const c2 = await claim(s.campaign);
    expect(c2.outcome).toBe("claimed");
    const [g] = await db.admin<{ next_gap_seconds: number }>("select next_gap_seconds from public.email_messages where id = $1", [c2.message_id]);
    expect(g.next_gap_seconds).toBeGreaterThanOrEqual(7200);
    expect(g.next_gap_seconds).toBeLessThanOrEqual(10800);
  });
});
```
  Update the legacy test `email-rls.test.ts` L518: rename to `"a second claim inside the 9 + 5 min gap (540-840 s by default) waits; after the gap it goes"`; after `freshCampaign` add `await db.admin("update public.email_campaigns set min_gap_minutes = 9, random_gap_minutes = 5 where id = $1", [camp]);`; bounds `540`/`840`; `await ageClaims(181)` becomes `await ageClaims(841)`; add a final `await ageClaims(841);` so the next test starts outside the gap.
- [ ] Step 2: `npx vitest run tests/db/gates.test.ts -t "gate 5"` → FAIL: `next_gap_seconds` is 60-180; with 120 + 60 the claim fails on `email_messages_gap`.
- [ ] Step 3: In `0006_gates.sql` (before the claim function): drop and re-add `email_messages_gap` as `check (next_gap_seconds between 0 and 10800)` and `email_send_log_gap` as `check (gap_seconds between 0 and 10800)` (`drop constraint if exists`, then `add constraint`). In the claim body replace `v_gap := 60 + floor(random() * 121)::integer;` by `v_gap := c.min_gap_minutes * 60 + floor(random() * (c.random_gap_minutes * 60 + 1))::integer;`.
- [ ] Step 4: `npx vitest run tests/db/gates.test.ts tests/db/email-rls.test.ts` → all pass (gates: 12).
- [ ] Step 5: Checkpoint `npx vitest run` → 647 passed, 0 failed.

### Task 5: Gate "Uma pessoa por empresa"

**Files:** Modify `0006_gates.sql` (claim select + one lock), `tests/db/gates.test.ts`, `tests/unit/rules/email.test.ts` (L17 comment, L33).
**Interfaces:** Consumes `company_key`, `v_day_start`. Produces test helpers `addProspect(camp, company, email, candidate?, workspace?, user?) => Promise<{ prospect: string; message: string }>` and `addStep(camp, prospect, step) => Promise<string>`.

- [ ] Step 1: Add tests (import `UUID_B`):
```ts
async function addProspect(camp: string, company: string, email: string, candidate: string | null = null, workspace = ws, user = UUID_A) {
  const prospect = (await db.admin<{ id: string }>("insert into public.email_prospects (workspace_id, campaign_id, candidate_id, company_name, email, email_source) values ($1,$2,$3,$4,$5,'manual') returning id", [workspace, camp, candidate, company, email]))[0].id;
  const message = (await db.query<{ id: string }>(as(user), "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body) values ($1,$2,$3,'sequence',1,'Hello there','Hi, short note.') returning id", [workspace, camp, prospect]))[0].id;
  await db.query(as(user), "select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')", [message]);
  return { prospect, message };
}
async function addStep(camp: string, prospect: string, step: 2 | 3): Promise<string> {
  const id = (await db.query<{ id: string }>(as(UUID_A), "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body) values ($1,$2,$3,'sequence',$4,'Following up','Short follow-up.') returning id", [ws, camp, prospect, step]))[0].id;
  await db.query(as(UUID_A), "select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')", [id]);
  await db.admin("update public.email_messages set due_at = now() - interval '1 minute' where id = $1", [id]);
  return id;
}
async function drain(camp: string, n: number, user = UUID_A): Promise<string[]> {
  const got: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = await claim(camp, user);
    got.push(c.message_id ?? c.outcome);
    if (c.message_id) await finish(c.message_id, user);
  }
  return got;
}
const statusOf = async (id: string) => (await db.admin<{ status: string }>("select status from public.email_messages where id = $1", [id]))[0].status;

describe("E2 gate 6: Uma pessoa por empresa [R7]", () => {
  test("R7 one person per company per local day; a blocked prospect is skipped and the queue moves on", async () => {
    const s = await seedCampaign(db, ws, "coa");
    await set(s.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    const x1 = await addProspect(s.campaign, "Acme", "x1@acme.example");
    const x2 = await addProspect(s.campaign, "Acme Inc", "x2@acme.example");
    const y = await addProspect(s.campaign, "Beta", "y@beta.example");
    expect(await drain(s.campaign, 4)).toEqual([s.messages[0], x1.message, y.message, "nothing_due"]);
    expect(await statusOf(x2.message)).toBe("approved");   // waits for tomorrow, not cancelled
    await ageEmailClaims(db, 2 * 86_400);
    expect(await drain(s.campaign, 1)).toEqual([x2.message]);
  });

  test("free-mail addresses fall back to the trimmed, lowercased company name", async () => {
    const s = await seedCampaign(db, ws, "cob");
    await set(s.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    const a = await addProspect(s.campaign, "Acme Builders", "a@gmail.com");
    const b = await addProspect(s.campaign, "Beta Homes", "b@gmail.com");
    await addProspect(s.campaign, "  ACME builders ", "c@yahoo.com");
    expect(await drain(s.campaign, 4)).toEqual([s.messages[0], a.message, b.message, "nothing_due"]);
  });

  test("the research company counts across campaigns of the workspace; another workspace does not count", async () => {
    const s1 = await seedCampaign(db, ws, "coc1");
    const s2 = await seedCampaign(db, ws, "coc2");
    for (const s of [s1, s2]) await set(s.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    const cand = (await db.admin<{ c: string }>("select candidate_id as c from public.email_prospects where id = $1", [s1.prospects[0]]))[0].c;
    const twin = await addProspect(s2.campaign, "Other name", "boss@elsewhere.example", cand);
    const shared = await addProspect(s1.campaign, "Shared", "z@shared.example");
    expect(await drain(s1.campaign, 2)).toEqual([s1.messages[0], shared.message]);
    expect(await drain(s2.campaign, 2)).toEqual([s2.messages[0], "nothing_due"]);
    expect(await statusOf(twin.message)).toBe("approved");
    const wsB = await createOwner(db, UUID_B);
    const b = await seedCampaign(db, wsB, "cocb", { userId: UUID_B });
    await set(b.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    const other = await addProspect(b.campaign, "Shared", "w@shared.example", null, wsB, UUID_B);
    expect(await drain(b.campaign, 2, UUID_B)).toEqual([b.messages[0], other.message]);
  });

  test("a follow-up of the same person may go the same day; another person of a company mailed today waits", async () => {
    const s = await seedCampaign(db, ws, "cod");
    await set(s.campaign, "min_gap_minutes = 0, random_gap_minutes = 0");
    const a = await addProspect(s.campaign, "Delta", "a@delta.example");
    const b = await addProspect(s.campaign, "Delta", "b@delta.example");
    expect(await drain(s.campaign, 3)).toEqual([s.messages[0], a.message, "nothing_due"]);
    await ageEmailClaims(db, 2 * 86_400);
    expect(await drain(s.campaign, 1)).toEqual([b.message]);         // today: only b of Delta
    const a2 = await addStep(s.campaign, a.prospect, 2);
    const b2 = await addStep(s.campaign, b.prospect, 2);
    expect(await drain(s.campaign, 2)).toEqual([b2, "nothing_due"]);
    expect(await statusOf(a2)).toBe("approved");
  });
});
```
  In `tests/unit/rules/email.test.ts`: L17 comment becomes `// calendar-day limit by sending address (cap 50, owner-only) and by campaign, 9 + 5 min gap, window in the campaign's zone, concurrent claims`; L33 `test.todo("R7 ...")` becomes `test("R7 No máximo 1 pessoa da mesma empresa por dia", () => { covered("R7", "tests/db/gates.test.ts"); });`.
- [ ] Step 2: `npx vitest run tests/db/gates.test.ts -t "gate 6"` → FAIL: `x2` is claimed right after `x1`.
- [ ] Step 3: In the claim body: after `perform pg_advisory_xact_lock(hashtextextended('email-address:' || b.email, 0));` add `perform pg_advisory_xact_lock(hashtextextended('email-company-day:' || c.workspace_id::text, 0));` (serialises claims of one workspace across mailboxes for the company rule). In the select's sequence branch add:
```sql
          and not exists (
            -- E2 gate 6: another person of the same company already claimed today (same workspace, same send mode)
            select 1 from public.email_messages o
              join public.email_prospects op on op.id = o.prospect_id
             where o.workspace_id = c.workspace_id and o.kind = 'sequence' and o.send_mode = c.send_mode
               and o.claimed_at > v_day_start and o.prospect_id <> x.prospect_id
               and public.company_key(op.candidate_id, o.to_address, op.company_name)
                 = public.company_key(p.candidate_id, x.approved_to, p.company_name))
```
- [ ] Step 4: `npx vitest run tests/db/gates.test.ts tests/unit/rules/email.test.ts` → all pass (gates: 16).
- [ ] Step 5: Checkpoint `npx vitest run` → 652 passed, 0 failed (4 new + R7 todo now a passing test).

### Task 6: App side (outcomes, messages, schedule line, tick)

**Files:** Modify `src/lib/email/types.ts`, `src/lib/email/schedule.ts`, `src/messages/pt/email.ts`, `src/app/(app)/email/campanhas/[id]/page.tsx` L61, `src/lib/email/scheduler.ts` L78 (comment), `src/components/email/ReplyControls.tsx` L91 (comment), `tests/engine/scheduler.test.ts` (append; L139 comment "fixture gap 1 + 2 min"). Create `tests/unit/email-schedule.test.ts`.
**Interfaces:** Produces `ClaimOutcome` + `"outside_window" | "campaign_limit"`; `CampaignRow` + `timezone: string; window_start: string; window_end: string; send_days: number[]; daily_limit: number; min_gap_minutes: number; random_gap_minutes: number` (and the same 7 names appended to `CAMPAIGN_COLUMNS`); `scheduleParts(c: Pick<CampaignRow, "send_days" | "window_start" | "window_end" | "timezone" | "daily_limit">): { days: string; start: string; end: string; tz: string; limit: number }`; message keys `t.email.send.outcomes.outside_window`, `t.email.send.outcomes.campaign_limit`, `t.email.campaign.schedule`.

- [ ] Step 1: Write `tests/unit/email-schedule.test.ts`:
```ts
import { describe, expect, test } from "vitest";
import { scheduleParts } from "@/lib/email/schedule";
import type { ClaimOutcome } from "@/lib/email/types";
import { fill, t } from "@/messages/pt";

const d = { send_days: [1, 2, 3, 4, 5], window_start: "09:00:00", window_end: "18:00:00", timezone: "America/New_York", daily_limit: 30 };
describe("E2 schedule line and outcome messages", () => {
  test("the default campaign reads as one line", () => {
    expect(fill(t.email.campaign.schedule, scheduleParts(d))).toBe("Envia seg a sex, das 09:00 às 18:00 (America/New_York), até 30 por dia");
    expect(scheduleParts({ ...d, send_days: [5, 1, 3] }).days).toBe("seg, qua, sex");
    expect(scheduleParts({ ...d, send_days: [6, 7] }).days).toBe("sáb, dom");
    expect(scheduleParts({ ...d, send_days: [1, 2, 3, 4, 5, 6, 7] }).days).toBe("seg a dom");
    expect(scheduleParts({ ...d, window_start: "00:00:00", window_end: "24:00:00" })).toMatchObject({ start: "00:00", end: "24:00" });
  });
  test("every claim outcome has a pt-BR message", () => {
    const all: Record<ClaimOutcome, string> = t.email.send.outcomes;
    expect(all.outside_window).toBe("Fora do horário de envio desta campanha. Os e-mails voltam a sair no próximo horário.");
    expect(all.campaign_limit).toBe("Limite diário desta campanha atingido. Continua amanhã.");
  });
});
```
  Append to `tests/engine/scheduler.test.ts` (import `NOT_TODAY` from `../db/helpers`):
```ts
describe("E2 gates on the clock and on a person's click", () => {
  test("outside the window the tick sends nothing and counts no failure; sendStep answers outside_window", async () => {
    const s = await seedCampaign(db, ws, "etwowin");
    await admin(`update public.email_campaigns set send_days = ${NOT_TODAY} where id = $1`, [s.campaign]);
    expect(await tick()).toMatchObject({ outcome: "ok", sent: 0, failed: 0 });
    expect(await sendStep({ store: new SqlEmailStore(db, UUID_A), smtp }, s.campaign, randomUUID(), ORIGINS)).toMatchObject({ outcome: "outside_window" });
    expect(await admin("select 1 from public.email_send_log where campaign_id = $1", [s.campaign])).toHaveLength(0);
    expect(smtp.calls).toBe(0);
    await admin("update public.email_campaigns set status = 'paused' where id = $1", [s.campaign]);
  });
  test("over the campaign limit the tick counts nothing; sendStep answers campaign_limit with the next local midnight", async () => {
    const s = await seedCampaign(db, ws, "etwolim", { n: 2 });
    await admin("update public.email_campaigns set daily_limit = 1, min_gap_minutes = 0, random_gap_minutes = 0 where id = $1", [s.campaign]);
    expect(await tick()).toMatchObject({ outcome: "ok", sent: 1, failed: 0 });
    expect(await tick()).toMatchObject({ outcome: "ok", sent: 0, failed: 0 });
    const r = await sendStep({ store: new SqlEmailStore(db, UUID_A), smtp }, s.campaign, randomUUID(), ORIGINS);
    const [{ e }] = await admin<{ e: Date }>("select public.local_day_end('America/New_York', now()) as e");
    expect(r.outcome).toBe("campaign_limit");
    expect(new Date(r.waitUntil!).toISOString()).toBe(new Date(e).toISOString());
    await admin("update public.email_campaigns set status = 'paused' where id = $1", [s.campaign]);
  });
});
```
- [ ] Step 2: `npx vitest run tests/unit/email-schedule.test.ts tests/engine/scheduler.test.ts` → FAIL: `scheduleParts` is not exported; the engine tests already pass (the SQL answers the codes), which proves the tick needs no code change.
- [ ] Step 3: Implement. `types.ts`: the two outcomes, the 7 `CampaignRow` fields, `CAMPAIGN_COLUMNS` += `, timezone, window_start, window_end, send_days, daily_limit, min_gap_minutes, random_gap_minutes`. `messages/pt/email.ts`: `send.outcomes.outside_window` and `send.outcomes.campaign_limit` with the exact strings above; `campaign.schedule: "Envia {days}, das {start} às {end} ({tz}), até {limit} por dia"`. `schedule.ts`: `scheduleParts` with `const WEEKDAYS_PT = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"]` (index = ISO day - 1); days sorted and de-duplicated; one contiguous run of 3 or more → `"<first> a <last>"`, otherwise names joined with `", "`; times = first 5 characters. `page.tsx` after L61: `<p className="text-[13px] text-muted">{fill(C.schedule, scheduleParts(campaign))}</p>`. Comments: scheduler.ts L78 `// gap, daily_limit, campaign_limit, outside_window, nothing_due, not_active, ...: the rules said "not now"; nothing to count`; ReplyControls L91 `9 + 5 min gap`.
- [ ] Step 4: `npx vitest run tests/unit tests/engine/scheduler.test.ts` → all pass.
- [ ] Step 5: Checkpoint `npx tsc --noEmit && npx vitest run` → 0 type errors; 656 passed, 0 failed.

### Task 7: README and full check

**Files:** Modify `APP/README.md` L39, L55, L65; add a section after "## Relógio (E1)".
**Interfaces:** none.

- [ ] Step 1: Write the failing check: `grep -n "60-180" README.md` currently prints L55 (expected after the step: no output) and `grep -n "0006_gates" README.md` prints nothing (expected after: L39, L65 and the new section).
- [ ] Step 2: Run both greps; expected now: `60-180` found, `0006_gates` not found.
- [ ] Step 3: Edit README (Portuguese). L39: "Aplicar as migrações de `supabase/migrations/` em ordem, de `0001` a `0006` (SQL Editor, como `postgres`)". L55: replace "intervalo aleatório de 60-180 s" with "horário e fuso da campanha, limite do dia por caixa e por campanha, intervalo de 9 min + até 5 min sorteados, 1 pessoa por empresa por dia". L65: "aplicar as migrações `0005_scheduler.sql` e `0006_gates.sql`" (the spec's "É a migração 0005" predates the split; E2 is in 0006). New section:
```md
## Portões de envio (E2)
Valem para os e-mails da sequência, no clique e no relógio, em ensaio e em envio real. Respostas a quem respondeu só obedecem ao limite e ao intervalo da caixa.
- **Horário**: só sai em `send_days` (1 = seg ... 7 = dom), entre `window_start` (inclusive) e `window_end` (exclusive), no fuso `timezone` da campanha. Padrão: seg a sex, 09:00 às 18:00, America/New_York. Fora disso: "Fora do horário de envio desta campanha".
- **Limite do dia**: o dia zera à meia-noite do fuso da campanha. Caixa: `daily_limit` da caixa (teto 50), por endereço. Campanha: `daily_limit` da campanha (padrão 30, de 1 a 500). Vale o menor.
- **Intervalo**: 9 min + 0 a 5 min sorteados entre dois envios da mesma caixa (`min_gap_minutes`, `random_gap_minutes`).
- **1 pessoa por empresa por dia** (por espaço): empresa = a mesma empresa da Pesquisa; senão o domínio do e-mail (menos Gmail, Outlook, Yahoo e outros gratuitos); senão o nome da empresa. A outra pessoa espera o dia seguinte, sem travar a fila. O passo seguinte da mesma pessoa pode sair no mesmo dia.
- Os ajustes ficam na campanha e por enquanto só se mudam no banco (a tela de configurações vem depois). A página da campanha mostra a regra em uma linha.
- **Antes de publicar** esta versão do app, aplicar `0006_gates.sql`: a página da campanha lê as colunas novas.
```
- [ ] Step 4: Re-run the two greps → `60-180` absent; `0006_gates` present.
- [ ] Step 5: Checkpoint `npm run check` → typecheck, lint, 656 tests, build and bundle check all green. Done when this passes with at least the 16 new tests in `tests/db/gates.test.ts` and the 2 new engine tests.
