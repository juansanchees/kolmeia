# E3 Rodízio de Caixas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A campaign sends through up to 10 mailboxes of its workspace ("preciso que tenha emails, vários emails que seja possível cadastrar"): each new person goes to the least-used usable mailbox of the day, and stays on that mailbox for every later step and every answer.
**Architecture:** One new migration `0007_rotation.sql` adds the join table `campaign_mailboxes` (source of truth for sending), the sticky column `email_prospects.mailbox_id`, one plain sync function (two triggers) that keeps `email_campaigns.mailbox_id` as "first mailbox", a backfill, and new bodies (same signatures and grants) for `claim_next_email_core`, `set_campaign_send_mode`, `scheduler_due_work` and `scheduler_message`. The app sends with the mailbox stamped on the claimed message and gets a checkbox list on the campaign page.
**Tech Stack:** Next.js 16.4.5, TypeScript, Supabase/Postgres (RLS forced), vitest + PGlite.
**Spec:** kolmeia/docs/engenharia-envio.html sections 05 (card 3), 06, 07 (E3)

`APP` = `kolmeia/app`. Every command runs from `APP`.

## Global Constraints
- Migration: create `APP/supabase/migrations/0007_rotation.sql`; never edit 0001-0006.
- Re-created in 0007 with `create or replace`, same signature, same `revoke`/`grant` lines repeated: `claim_next_email_core(uuid, uuid, uuid, uuid, text)` (0006), `scheduler_due_work(uuid)` and `scheduler_message(uuid, uuid)` (0005), `set_campaign_send_mode(uuid, text)` (0003). The 0005 wrappers are untouched.
- No new SECURITY DEFINER function: the exact list in `tests/db/rls.test.ts` is unchanged. New plain functions `guard_campaign_mailbox()`, `sync_campaign_mailboxes()`, `backfill_prospect_mailboxes()`: `set search_path = ''`, `revoke all ... from public, anon, authenticated`.
- Table: `campaign_mailboxes (campaign_id uuid not null references public.email_campaigns (id) on delete cascade, mailbox_id uuid not null references public.mailboxes (id) on delete cascade, workspace_id uuid not null references public.workspaces (id) on delete cascade, created_at timestamptz not null default now(), primary key (campaign_id, mailbox_id))` + index `campaign_mailboxes_mailbox_idx (mailbox_id)`. `on delete cascade` for `mailbox_id` replaces 0003's `set null`, which a primary-key column cannot take (the link disappears, the campaign stays).
- Same workspace and the cap of 10 are enforced by `guard_campaign_mailbox()` (BEFORE INSERT): locks the campaign row (`for update`), stamps `workspace_id` from the campaign, raises `mailbox not in this workspace` (42501) when the mailbox's workspace differs or is invisible, `not allowed` (42501) when the campaign is invisible, `a campaign has at most 10 mailboxes` (23514) at 10 rows; `created_at := clock_timestamp()` (insert order = list order inside one transaction).
- Grants on `campaign_mailboxes`: `revoke all from public, anon, authenticated; grant select, delete to authenticated; grant insert (campaign_id, mailbox_id) to authenticated` (no update). RLS enabled and forced. Policies (modelled on `email_campaigns_*` in 0003): `campaign_mailboxes_select` using `is_workspace_member(workspace_id)`; `campaign_mailboxes_insert` with check `is_workspace_sender(workspace_id) and mailbox_in_workspace(mailbox_id, workspace_id)`; `campaign_mailboxes_delete` using `is_workspace_sender(workspace_id)`.
- Sticky: `alter table public.email_prospects add column if not exists mailbox_id uuid references public.mailboxes (id) on delete set null`. No client write (0003 grants UPDATE on `email_prospects` only for `contact_name, contact_title, email, status`). Set only by the claim, only when null.
- Compatibility (decision 3): ONE plain function `sync_campaign_mailboxes()` on two triggers, because two write paths exist and both must keep working: the list (new screen) and the old column (campaign creation form, existing tests, admin fixtures). Trigger `sync_campaign_mailbox_list` AFTER INSERT OR UPDATE OF mailbox_id ON email_campaigns: insert the new mailbox into the list if absent (`insert ... select ... where not exists`, so the guard never sees a duplicate), THEN delete the old one. Trigger `sync_campaign_first_mailbox` AFTER INSERT OR DELETE ON campaign_mailboxes: `update email_campaigns set mailbox_id = <first> where id = ... and mailbox_id is distinct from <first> and (mailbox_id is null or mailbox_id not in the list)`; first = `order by created_at, mailbox_id limit 1`. Both run as the caller (clients hold `update (mailbox_id)` on campaigns and `insert (campaign_id, mailbox_id)` on the list); no recursion beyond one level.
- 0003's `guard_email_campaign` is untouched: in real mode, a change of the FIRST mailbox still sends the campaign back to rehearsal; adding or removing another mailbox does not (each one is checked at claim time).
- Rotation rule: a due message may be claimed through any free mailbox only when its prospect has `mailbox_id is null` AND no `email_send_log` row in the campaign's `send_mode`; otherwise only through `p.mailbox_id`. A deleted sticky mailbox (FK set null) therefore never re-rotates.
- `set_campaign_send_mode(…, 'real')`: requires at least one mailbox of `campaign_mailboxes` with `status = 'ok'` (same message `R4: a verified mailbox is required`), and clears `email_prospects.mailbox_id` of the campaign's prospects that have no send-log row in mode `'real'` (rehearsal stickers never bind real mail).
- Usable in mode: real → `mailboxes.status = 'ok'`; dry_run → any (as E2). A prospect stuck to a mailbox that is removed, unverified in real mode, or deleted is skipped by the select; with nothing else due the claim answers `nothing_due` (or the held E2 outcome). No new outcome code.
- Claim order in 0007: stale sweep → `not_active` → `outside_window` → empty list `no_mailbox` → locks → none usable `mailbox_not_verified` → `no_sender_profile` → per-mailbox gates → all blocked by limits `daily_limit` → `campaign_limit` → all blocked `gap`/`daily_limit` (earliest `wait_until`) → suppression → candidate select (company rule unchanged) → mailbox choice.
- Lock order: (1) every mailbox row of the campaign in ONE `for update` statement ordered by `email`; (2) `pg_advisory_xact_lock('email-address:' || email)` per address, ascending `email`; (3) workspace lock `email-company-day:` (E2); (4) `for update of x skip locked`. Stale sweep stays first.
- No fake clock in production SQL. Tests move time with `ageEmailClaims`.
- No git in `kolmeia/`: "Checkpoint" = run the command shown. Backups: `kolmeia/.backups/`.
- Dry-run capable throughout; nothing enables a real send. No new env vars, no service-role key, no `console.*` in `src/lib/email`. The clock never reads a mailbox secret; scheduler functions never mention `public.mailboxes` (test in `tests/db/scheduler.test.ts`).
- Baseline: `npm run check` green, 675 passed | 3 todo. Existing assertions are not changed; only fixture lists grow (`TABLES` in `tests/db/email-rls.test.ts`).

## Review Focus
1. **A mailbox deleted while people are stuck to it** (FK sets `email_prospects.mailbox_id` to null; without the send-log rule they would silently move to another address mid-thread). Owner: Task 3. Pin: `a deleted mailbox: its people wait (follow-ups and answers), new people go to the others`.
2. **Two campaigns sharing a mailbox** (limits and gap are per address across campaigns; the rank must read the address count, not the campaign's). Owner: Task 2. Pin: `two campaigns sharing a mailbox: the address count is shared, so the other campaign's new prospect goes to its other mailbox`.
3. **Real mode with one verified and one unverified mailbox** (first mailbox unverified must not block the switch; the unverified one must never send; rehearsal stickers must not pin real mail to it). Owner: Task 4. Pin: `real mode with one verified and one unverified mailbox: the switch is allowed, only the verified one sends, rehearsal stickers are cleared`.
4. **Changing the mailbox list mid-campaign** (unticking a mailbox strands its people; re-ticking must resume them on the same address). Owner: Task 3. Pin: `(d) removed from the campaign: the stuck follow-up waits, new prospects use the others, re-adding resumes it`.
5. **Only stuck messages are due and their mailbox is blocked while another is free** (the person sees "nada vencido" and thinks the campaign is dead). Owner: Task 3. Pin: `only stuck messages are due and their mailbox is in its gap: the answer is that gap, not nothing_due`.

---

## File Structure
| File | Responsibility |
|---|---|
| `APP/supabase/migrations/0007_rotation.sql` (create) | table, sticky column, guard + sync triggers, grants/RLS, backfills, 4 re-created functions |
| `APP/tests/db/rotation.test.ts` (create) | DB tests of the list, the sync, the rotation, the waits, real mode, the clock |
| `APP/tests/db/scheduler-seed.ts` (modify, append) | `addCampaignMailbox` fixture |
| `APP/tests/db/email-rls.test.ts` (modify L14-23) | `TABLES` += `"campaign_mailboxes"` |
| `APP/tests/engine/rotation.test.ts` (create) | sendStep with two real mailboxes and fake SMTP |
| `APP/tests/unit/email-rotation.test.ts` (create) | list diff, per-address count, local midnight, pt-BR keys |
| `APP/src/lib/email/types.ts` (modify `MessageRow`, `MESSAGE_COLUMNS`) | `mailbox_id` on messages |
| `APP/src/lib/email/store.ts` (modify `SendMessage`) | `"mailbox_id"` in the Pick |
| `APP/src/lib/email/engine.ts` (modify `sendStep` L232-242) | credentials and stop flag from the message's mailbox |
| `APP/src/lib/email/rotation.ts` (create) | `MAX_CAMPAIGN_MAILBOXES`, `mailboxListChange`, `sentTodayByAddress` |
| `APP/src/lib/email/schedule.ts` (modify, append) | `localDayStart` |
| `APP/src/app/(app)/email/actions.ts` (modify, after `setDelays`) | `setCampaignMailboxes` |
| `APP/src/components/email/forms.tsx` (modify, after `DelaysForm`) | `CampaignMailboxesForm` |
| `APP/src/app/(app)/email/campanhas/[id]/page.tsx` (modify L28-45, L60) | list of mailboxes, sent today, "Buscar respostas" for the campaign's mailboxes |
| `APP/src/messages/pt/email.ts` (modify `campaign`) | pt-BR texts |
| `APP/README.md` (modify L39, L65, new section) | Portuguese docs |

---

### Task 1: Table, sticky column, sync and backfill

**Files:** Create `0007_rotation.sql`, `tests/db/rotation.test.ts`. Modify `tests/db/scheduler-seed.ts` (append), `tests/db/email-rls.test.ts` L14-23.
**Interfaces:** Produces table `public.campaign_mailboxes`, column `public.email_prospects.mailbox_id`, trigger functions `public.guard_campaign_mailbox() returns trigger`, `public.sync_campaign_mailboxes() returns trigger`, `public.backfill_prospect_mailboxes() returns integer`. TS: `addCampaignMailbox(db: TestDb, ws: string, campaign: string, label: string, userId?: string): Promise<{ mailbox: string; address: string }>`.

- [ ] Step 1: Append to `tests/db/scheduler-seed.ts`:
```ts
/** E3 fixture: a new mailbox (address `sales-<label>@neair.example`, unverified) attached as the campaign's next mailbox. */
export async function addCampaignMailbox(db: TestDb, ws: string, campaign: string, label: string, userId = UUID_A): Promise<{ mailbox: string; address: string }> {
  const address = `sales-${label}@neair.example`;
  const mailbox = (await db.query<{ id: string }>(as(userId), "select public.save_mailbox($1,$2,$3) as id", [ws, address, CIPHER]))[0].id;
  await db.query(as(userId), "insert into public.campaign_mailboxes (campaign_id, mailbox_id) values ($1,$2)", [campaign, mailbox]);
  return { mailbox, address };
}
```
  Add `"campaign_mailboxes"` to `TABLES` in `email-rls.test.ts`. Write `tests/db/rotation.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, anon, anonWithToken, as, ageEmailClaims, setSchedulerToken, UUID_A, UUID_B, UUID_C } from "./helpers";
import { addCampaignMailbox, CIPHER, createOwner, seedCampaign, TOKEN, type Seeded } from "./scheduler-seed";

// Migration 0007 (E3 "Rodízio de caixas"): several mailboxes per campaign, one fixed mailbox per person.
let db: TestDb;
let ws: string;
let wsB: string;
beforeAll(async () => {
  db = await TestDb.create();
  ws = await createOwner(db);
  wsB = await createOwner(db, UUID_B);
  await db.addUser(UUID_C);
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'closer')", [ws, UUID_C]);
});
afterAll(async () => { await db.pg.close(); });
const iso = (d: unknown) => new Date(d as string).toISOString();
type Claim = { outcome: string; message_id?: string; wait_until?: string };
const HOLDER = "33333333-3333-4333-8333-333333333333";
const claim = async (camp: string) => (await db.query<{ r: Claim }>(as(UUID_A), "select public.claim_next_email($1,$2) as r", [camp, HOLDER]))[0].r;
const finish = (msg: string, result = "dry_run") => db.query(as(UUID_A), "select public.finish_email_send($1,$2,$3,null)", [msg, HOLDER, result]);
const set = (camp: string, sql: string) => db.admin(`update public.email_campaigns set ${sql} where id = $1`, [camp]);
const noGap = (camp: string) => set(camp, "min_gap_minutes = 0, random_gap_minutes = 0");
const listOf = async (camp: string) => (await db.admin<{ mailbox_id: string }>("select mailbox_id from public.campaign_mailboxes where campaign_id = $1 order by created_at, mailbox_id", [camp])).map((r) => r.mailbox_id);
const firstOf = async (camp: string) => (await db.admin<{ mailbox_id: string | null }>("select mailbox_id from public.email_campaigns where id = $1", [camp]))[0].mailbox_id;
const stickyOf = async (p: string) => (await db.admin<{ mailbox_id: string | null }>("select mailbox_id from public.email_prospects where id = $1", [p]))[0].mailbox_id;
const fromOf = async (msg: string) => (await db.admin<{ from_address: string }>("select from_address from public.email_messages where id = $1", [msg]))[0].from_address;
const prospectOf = async (msg: string) => (await db.admin<{ prospect_id: string }>("select prospect_id from public.email_messages where id = $1", [msg]))[0].prospect_id;
const statusOf = async (id: string) => (await db.admin<{ status: string }>("select status from public.email_messages where id = $1", [id]))[0].status;
/** Claims and finishes one e-mail; `from` is the address it left from. */
async function send(camp: string): Promise<{ outcome: string; id?: string; from?: string }> {
  const c = await claim(camp);
  if (!c.message_id) return { outcome: c.outcome };
  await finish(c.message_id);
  return { outcome: c.outcome, id: c.message_id, from: await fromOf(c.message_id) };
}

describe("0007 campaign_mailboxes and the sticky column", () => {
  test("RLS forced; members read; senders attach and detach; a closer cannot; another workspace's mailbox is refused (g)", async () => {
    const s = await seedCampaign(db, ws, "t1");
    expect((await db.admin("select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.campaign_mailboxes'::regclass"))[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect(await listOf(s.campaign)).toEqual([s.mailbox]);
    expect(await db.query(as(UUID_C), "select mailbox_id from public.campaign_mailboxes where campaign_id = $1", [s.campaign])).toHaveLength(1);
    expect(await db.query(as(UUID_B), "select mailbox_id from public.campaign_mailboxes where campaign_id = $1", [s.campaign])).toHaveLength(0);
    const b = await addCampaignMailbox(db, ws, s.campaign, "t1b");
    expect(await listOf(s.campaign)).toEqual([s.mailbox, b.mailbox]);
    const other = await seedCampaign(db, wsB, "t1x", { userId: UUID_B });
    const c = (await db.query<{ id: string }>(as(UUID_A), "select public.save_mailbox($1,'sales-t1c@neair.example',$2) as id", [ws, CIPHER]))[0].id;
    const ins = "insert into public.campaign_mailboxes (campaign_id, mailbox_id) values ($1,$2)";
    expect((await db.try(as(UUID_A), ins, [s.campaign, other.mailbox])).error?.message).toMatch(/not in this workspace|row-level security/);
    expect((await db.try(as(UUID_B), ins, [s.campaign, other.mailbox])).error?.message).toMatch(/not allowed|row-level security/);
    expect((await db.try(as(UUID_C), ins, [s.campaign, c])).error?.message).toMatch(/not allowed|row-level security/);
    expect((await db.try(as(UUID_A), "insert into public.campaign_mailboxes (campaign_id, mailbox_id, workspace_id) values ($1,$2,$3)", [s.campaign, c, ws])).error?.message).toMatch(/permission denied/);
    expect((await db.try(as(UUID_A), "update public.campaign_mailboxes set mailbox_id = $2 where campaign_id = $1", [s.campaign, c])).error?.message).toMatch(/permission denied/);
    expect(await db.query(as(UUID_C), "delete from public.campaign_mailboxes where campaign_id = $1 returning mailbox_id", [s.campaign])).toHaveLength(0);
    expect(await db.query(as(UUID_A), "delete from public.campaign_mailboxes where campaign_id = $1 and mailbox_id = $2 returning mailbox_id", [s.campaign, b.mailbox])).toHaveLength(1);
    expect((await db.try(anon, "select 1 from public.campaign_mailboxes")).error?.message).toMatch(/permission denied/);
  });

  test("at most 10 mailboxes per campaign", async () => {
    const s = await seedCampaign(db, ws, "t2");
    for (let i = 1; i < 10; i++) await addCampaignMailbox(db, ws, s.campaign, `t2m${i}`);
    expect(await listOf(s.campaign)).toHaveLength(10);
    await expect(addCampaignMailbox(db, ws, s.campaign, "t2m10")).rejects.toThrow(/at most 10 mailboxes/);
    await db.query(as(UUID_A), "delete from public.campaign_mailboxes where campaign_id = $1 and mailbox_id = $2", [s.campaign, (await listOf(s.campaign))[9]]);
    await addCampaignMailbox(db, ws, s.campaign, "t2m11");
  });

  test("the compatibility column email_campaigns.mailbox_id follows the list, and a write to it changes the list", async () => {
    const s = await seedCampaign(db, ws, "t3");
    const b = await addCampaignMailbox(db, ws, s.campaign, "t3b");
    const c = await addCampaignMailbox(db, ws, s.campaign, "t3c");
    expect(await firstOf(s.campaign)).toBe(s.mailbox);                        // adding never moves the first
    await db.query(as(UUID_A), "delete from public.campaign_mailboxes where campaign_id = $1 and mailbox_id = $2", [s.campaign, s.mailbox]);
    expect(await firstOf(s.campaign)).toBe(b.mailbox);                        // the earliest remaining
    await db.query(as(UUID_A), "update public.email_campaigns set mailbox_id = $2 where id = $1", [s.campaign, s.mailbox]);
    expect([await listOf(s.campaign), await firstOf(s.campaign)]).toEqual([[c.mailbox, s.mailbox], s.mailbox]);   // old first out, new in
    await db.query(as(UUID_A), "delete from public.mailboxes where id = $1", [s.mailbox]);
    expect([await listOf(s.campaign), await firstOf(s.campaign)]).toEqual([[c.mailbox], c.mailbox]);
    await db.query(as(UUID_A), "delete from public.campaign_mailboxes where campaign_id = $1", [s.campaign]);
    expect(await firstOf(s.campaign)).toBeNull();
  });

  test("email_prospects.mailbox_id: readable by members, not writable by clients, set null when the mailbox is deleted", async () => {
    const s = await seedCampaign(db, ws, "t4");
    expect(await db.query(as(UUID_C), "select mailbox_id from public.email_prospects where id = $1", [s.prospects[0]])).toEqual([{ mailbox_id: null }]);
    expect((await db.try(as(UUID_A), "update public.email_prospects set mailbox_id = $2 where id = $1", [s.prospects[0], s.mailbox])).error?.message).toMatch(/permission denied/);
    await db.admin("update public.email_prospects set mailbox_id = $2 where id = $1", [s.prospects[0], s.mailbox]);
    await db.query(as(UUID_A), "delete from public.mailboxes where id = $1", [s.mailbox]);
    expect(await stickyOf(s.prospects[0])).toBeNull();
  });

  test("backfill_prospect_mailboxes: the mailbox of the latest claim (message, else send-log address); unclaimed stays null", async () => {
    const s = await seedCampaign(db, ws, "t5", { n: 2 });
    const c = await claim(s.campaign);
    await finish(c.message_id!);
    await db.admin("update public.email_prospects set mailbox_id = null where campaign_id = $1", [s.campaign]);
    await db.admin("select public.backfill_prospect_mailboxes()");
    const sent = await prospectOf(c.message_id!);
    expect([await stickyOf(sent), await stickyOf(s.prospects.find((p) => p !== sent)!)]).toEqual([s.mailbox, null]);
    await db.admin("update public.email_prospects set mailbox_id = null where id = $1", [sent]);
    await db.admin("update public.email_messages set mailbox_id = null where id = $1", [c.message_id]);
    await db.admin("select public.backfill_prospect_mailboxes()");
    expect(await stickyOf(sent)).toBe(s.mailbox);
  });

  test("EXECUTE on the 0007 helpers is denied to anon and authenticated", async () => {
    for (const fn of ["guard_campaign_mailbox()", "sync_campaign_mailboxes()", "backfill_prospect_mailboxes()"]) {
      const [g] = await db.admin(`select has_function_privilege('anon', 'public.${fn}', 'execute') as a, has_function_privilege('authenticated', 'public.${fn}', 'execute') as u`);
      expect(g, fn).toEqual({ a: false, u: false });
    }
  });
});
```
- [ ] Step 2: `npx vitest run tests/db/rotation.test.ts` → FAIL: `relation "public.campaign_mailboxes" does not exist`.
- [ ] Step 3: Implement `0007_rotation.sql`, header comment in the style of 0006 (what E3 adds; that the list is the source of truth and `mailbox_id` is the compatibility "first mailbox"; no SECURITY DEFINER added). Order: table + index → backfill of the list (`insert into public.campaign_mailboxes (campaign_id, mailbox_id, workspace_id, created_at) select c.id, c.mailbox_id, c.workspace_id, c.created_at from public.email_campaigns c join public.mailboxes b on b.id = c.mailbox_id and b.workspace_id = c.workspace_id on conflict do nothing`, before the triggers exist) → sticky column → the three functions → triggers `guard_campaign_mailbox` (BEFORE INSERT ON campaign_mailboxes), `sync_campaign_first_mailbox`, `sync_campaign_mailbox_list` (see Global Constraints) → revokes, grants, RLS, policies → `select public.backfill_prospect_mailboxes();`. Logic the tests do not fully determine:
```sql
-- backfill_prospect_mailboxes(): only prospects still without a mailbox; latest claimed message, else the latest send-log
-- row of the campaign's current mode mapped to the workspace's mailbox with that address. Returns the rows changed.
update public.email_prospects p
   set mailbox_id = coalesce(
     (select x.mailbox_id from public.email_messages x
       where x.prospect_id = p.id and x.mailbox_id is not null order by x.claimed_at desc nulls last limit 1),
     (select b.id from public.email_send_log l
        join public.email_campaigns c on c.id = p.campaign_id
        join public.mailboxes b on b.workspace_id = p.workspace_id and b.email = l.mailbox_address
       where l.prospect_id = p.id and l.mode = c.send_mode order by l.claimed_at desc limit 1))
 where p.mailbox_id is null;
-- sync_campaign_mailboxes(), branch on tg_table_name:
--  'email_campaigns' (AFTER INSERT OR UPDATE OF mailbox_id): if new.mailbox_id is not null then
--     insert into public.campaign_mailboxes (campaign_id, mailbox_id) select new.id, new.mailbox_id
--      where not exists (select 1 from public.campaign_mailboxes where campaign_id = new.id and mailbox_id = new.mailbox_id);
--   then, on UPDATE with old.mailbox_id not null and distinct: delete that (new.id, old.mailbox_id) row.  Insert first, delete second.
--  'campaign_mailboxes' (AFTER INSERT OR DELETE): v_camp := coalesce(new.campaign_id, old.campaign_id);
--     update public.email_campaigns c set mailbox_id = f.first from (select (select cm.mailbox_id from public.campaign_mailboxes cm
--       where cm.campaign_id = v_camp order by cm.created_at, cm.mailbox_id limit 1) as first) f
--      where c.id = v_camp and c.mailbox_id is distinct from f.first
--        and (c.mailbox_id is null or not exists (select 1 from public.campaign_mailboxes cm where cm.campaign_id = v_camp and cm.mailbox_id = c.mailbox_id));
```
- [ ] Step 4: `npx vitest run tests/db/rotation.test.ts tests/db/email-rls.test.ts` → all pass (rotation: 6).
- [ ] Step 5: Checkpoint `npx vitest run` → 682 passed | 3 todo, 0 failed (6 new + 1 `TABLES` case; the claim still reads `mailbox_id`, kept in step).

### Task 2: Rotation inside the claim

**Files:** Modify `0007_rotation.sql` (append `claim_next_email_core`), `tests/db/rotation.test.ts`.
**Interfaces:** Consumes `campaign_mailboxes`, `address_claims_since`, `local_day_start`, `local_day_end`, `next_window_open`, `campaign_claims_since`, `company_key` (unchanged). Produces `claim_next_email_core(p_campaign uuid, p_holder uuid, p_message uuid, p_actor uuid, p_only_mode text) returns jsonb` with claims stamped `email_messages.mailbox_id = <chosen>`, `from_address = <chosen email>`, and `email_prospects.mailbox_id` set when null; test helper `addStep(s: Seeded, prospect: string, step: 2 | 3): Promise<string>`.

- [ ] Step 1: Add to `rotation.test.ts`:
```ts
async function addStep(s: Seeded, prospect: string, step: 2 | 3): Promise<string> {
  const id = (await db.query<{ id: string }>(as(UUID_A), "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body) values ($1,$2,$3,'sequence',$4,'Following up','Short follow-up.') returning id", [ws, s.campaign, prospect, step]))[0].id;
  await db.query(as(UUID_A), "select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')", [id]);
  await db.admin("update public.email_messages set due_at = now() - interval '1 minute' where id = $1", [id]);
  return id;
}
const gapEnd = async (address: string) => iso((await db.admin<{ w: Date }>("select max(claimed_at) + interval '540 seconds' as w from public.email_send_log where mailbox_address = $1", [address]))[0].w);

describe("E3 rodízio", () => {
  test("(b) new prospects alternate by least sent today; ties go to the mailbox whose last claim is oldest", async () => {
    const s = await seedCampaign(db, ws, "r2b", { n: 4 });
    const b = await addCampaignMailbox(db, ws, s.campaign, "r2bb");
    await noGap(s.campaign);
    const got: (string | undefined)[] = [];
    for (let i = 0; i < 4; i++) got.push((await send(s.campaign)).from);
    expect(new Set(got)).toEqual(new Set([s.address, b.address]));
    expect([got[1] !== got[0], got[2], got[3]]).toEqual([true, got[0], got[1]]);
  });

  test("(a) step 2 leaves through the mailbox of step 1 even when another mailbox is freer", async () => {
    const s = await seedCampaign(db, ws, "r2a", { n: 3 });
    const b = await addCampaignMailbox(db, ws, s.campaign, "r2ab");
    await noGap(s.campaign);
    const first = await send(s.campaign);
    await send(s.campaign);
    expect((await send(s.campaign)).from).toBe(first.from);                   // first's mailbox: 2 today, the other: 1
    const p = await prospectOf(first.id!);
    const mine = first.from === s.address ? s.mailbox : b.mailbox;
    expect(await stickyOf(p)).toBe(mine);
    const step2 = await addStep(s, p, 2);
    expect(await send(s.campaign)).toMatchObject({ id: step2, from: first.from });
    expect(await stickyOf(p)).toBe(mine);
  });

  test("(c) a mailbox in its gap or at its limit is skipped; when all are blocked the earliest wait wins", async () => {
    const s = await seedCampaign(db, ws, "r2c", { n: 3 });
    await set(s.campaign, "min_gap_minutes = 9, random_gap_minutes = 0");
    expect((await send(s.campaign)).from).toBe(s.address);                    // only A attached
    const b = await addCampaignMailbox(db, ws, s.campaign, "r2cb");
    expect((await send(s.campaign)).from).toBe(b.address);                    // A in its gap
    const both = await claim(s.campaign);
    expect(both.outcome).toBe("gap");
    expect(iso(both.wait_until)).toBe(await gapEnd(s.address));               // A frees first
    await ageEmailClaims(db, 600);
    await db.query(as(UUID_A), "update public.mailboxes set daily_limit = 1 where id = $1", [s.mailbox]);
    expect((await send(s.campaign)).from).toBe(b.address);                    // A at its limit; B (1 today) is used
    const g = await claim(s.campaign);
    expect([g.outcome, iso(g.wait_until)]).toEqual(["gap", await gapEnd(b.address)]);   // B's gap beats A's next day
  });

  test("(f) the campaign limit counts the claims of all its mailboxes", async () => {
    const s = await seedCampaign(db, ws, "r2f", { n: 3 });
    const b = await addCampaignMailbox(db, ws, s.campaign, "r2fb");
    await set(s.campaign, "daily_limit = 2, min_gap_minutes = 0, random_gap_minutes = 0");
    expect(new Set([(await send(s.campaign)).from, (await send(s.campaign)).from])).toEqual(new Set([s.address, b.address]));
    expect((await claim(s.campaign)).outcome).toBe("campaign_limit");
  });

  test("two campaigns sharing a mailbox: the address count is shared, so the other campaign's new prospect goes to its other mailbox", async () => {
    const x = await seedCampaign(db, ws, "r2x", { n: 2 });
    const y = await seedCampaign(db, ws, "r2y", { n: 2 });
    await db.query(as(UUID_A), "insert into public.campaign_mailboxes (campaign_id, mailbox_id) values ($1,$2)", [y.campaign, x.mailbox]);
    for (const c of [x, y]) await noGap(c.campaign);
    await send(x.campaign);
    await send(x.campaign);
    expect((await send(y.campaign)).from).toBe(y.address);                    // x's address has 2 today
    await db.query(as(UUID_A), "update public.mailboxes set daily_limit = 2 where id = $1", [x.mailbox]);
    await db.query(as(UUID_A), "delete from public.campaign_mailboxes where campaign_id = $1 and mailbox_id = $2", [y.campaign, y.mailbox]);
    expect((await claim(y.campaign)).outcome).toBe("daily_limit");            // the shared address is full for y too
  });

  test("(e) one mailbox: every claim goes through it, the prospect is stamped with it, blocked outcomes are unchanged", async () => {
    const s = await seedCampaign(db, ws, "r2e", { n: 2 });
    await set(s.campaign, "min_gap_minutes = 9, random_gap_minutes = 0");
    const c1 = await send(s.campaign);
    expect(c1.from).toBe(s.address);
    expect(await stickyOf(await prospectOf(c1.id!))).toBe(s.mailbox);
    const g = await claim(s.campaign);
    expect([g.outcome, iso(g.wait_until)]).toEqual(["gap", await gapEnd(s.address)]);
    expect([await listOf(s.campaign), await firstOf(s.campaign)]).toEqual([[s.mailbox], s.mailbox]);
  });
});
```
- [ ] Step 2: `npx vitest run tests/db/rotation.test.ts -t "rodízio"` → FAIL: every claim leaves from the first mailbox (`from` never equals the second address); `stickyOf` is null.
- [ ] Step 3: Append `create or replace function public.claim_next_email_core(...)` as a copy of the 0006 body (0006 L107-307) plus `revoke all on function public.claim_next_email_core(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;`. Declare `v_usable uuid[]; v_free uuid[] := '{}'; v_block_ids uuid[] := '{}'; v_block_kinds text[] := '{}'; v_block_waits timestamptz[] := '{}'; v_kind text; v_wait timestamptz; v_id uuid;`. Keep 0006 L128-162 (campaign read, stale sweep, `not_active`, window, `v_day_start`) and L199-208 (campaign limit), L219-234 (suppression), the company `not exists` and the message/log/token writes. Replace 0006 L163-198 and L209-217 by:
```sql
  if not exists (select 1 from public.campaign_mailboxes cm where cm.campaign_id = c.id) then
    return jsonb_build_object('outcome', 'no_mailbox');
  end if;
  -- E3 lock order (E2 generalised; cannot deadlock): (1) all mailbox rows of the campaign in ONE statement, by address.
  -- Rows belong to one workspace and every claim of that workspace sorts them the same way, so two campaigns sharing
  -- mailboxes lock them in the same order. (2) address advisory locks, ascending, taken only after every row lock:
  -- a claim never waits for a row while holding an address lock, and the same address in another workspace (a
  -- different row) sorts to the same position. (3) the workspace lock of E2 gate 6, last, as in E2. (4) skip locked.
  perform 1 from public.mailboxes mb
   where mb.workspace_id = c.workspace_id
     and mb.id in (select cm.mailbox_id from public.campaign_mailboxes cm where cm.campaign_id = c.id)
   order by mb.email
     for update;
  for b in select mb.* from public.mailboxes mb join public.campaign_mailboxes cm on cm.mailbox_id = mb.id
            where cm.campaign_id = c.id and mb.workspace_id = c.workspace_id order by mb.email loop
    perform pg_advisory_xact_lock(hashtextextended('email-address:' || b.email, 0));
  end loop;
  perform pg_advisory_xact_lock(hashtextextended('email-company-day:' || c.workspace_id::text, 0));
  select array_agg(mb.id order by mb.email) into v_usable
    from public.mailboxes mb join public.campaign_mailboxes cm on cm.mailbox_id = mb.id
   where cm.campaign_id = c.id and mb.workspace_id = c.workspace_id and (c.send_mode <> 'real' or mb.status = 'ok');
  if v_usable is null then
    return jsonb_build_object('outcome', 'mailbox_not_verified');
  end if;
  if not public.sender_profile_complete(c.workspace_id) then
    return jsonb_build_object('outcome', 'no_sender_profile');
  end if;
  -- per mailbox: calendar-day limit, rolling cap of 50, gap (0006 L185-198 and L210-217, same formulas and wait_until)
  foreach v_id in array v_usable loop
    select * into b from public.mailboxes where id = v_id;
    v_kind := null;
    -- daily: v_kind := 'daily_limit', v_wait := next_window_open(.., local_day_end(..)); else rolling: 'daily_limit',
    -- v_wait from v_oldest; else gap: 'gap', v_wait := v_last.claimed_at + gap   (bodies copied from 0006)
    if v_kind is null then
      v_free := v_free || b.id;
    else
      v_block_ids := v_block_ids || b.id; v_block_kinds := v_block_kinds || v_kind; v_block_waits := v_block_waits || v_wait;
    end if;
  end loop;
  if cardinality(v_free) = 0 and not ('gap' = any (v_block_kinds)) then   -- E2 order: the mailbox limit answers before the campaign limit
    return jsonb_build_object('outcome', 'daily_limit', 'wait_until', (select min(w) from unnest(v_block_waits) w));
  end if;
  -- [0006 L199-208 campaign_limit block, unchanged]
  if cardinality(v_free) = 0 then
    select u.k, u.w into v_kind, v_wait from unnest(v_block_kinds, v_block_waits) u(k, w) order by u.w limit 1;
    return jsonb_build_object('outcome', v_kind, 'wait_until', v_wait);
  end if;
```
  In the candidate select: `select x.*, p.mailbox_id as sticky into m`, and add `and (p.mailbox_id is null or p.mailbox_id = any (v_free))`. After `if m.id is null ...`, choose the mailbox:
```sql
  select mb.* into b from public.mailboxes mb
   where mb.id = coalesce(m.sticky, (
     select f.id from public.mailboxes f where f.id = any (v_free)
      order by public.address_claims_since(f.email, c.send_mode, v_day_start),
               (select max(l.claimed_at) from public.email_send_log l where l.mailbox_address = f.email and l.mode = c.send_mode) nulls first,
               f.id
      limit 1));
```
  After the `email_unsub_tokens` insert: `update public.email_prospects set mailbox_id = b.id where id = m.prospect_id and mailbox_id is null;`.
- [ ] Step 4: `npx vitest run tests/db` → all pass (rotation: 12; gates, email-rls, scheduler unchanged and green).
- [ ] Step 5: Checkpoint `npx vitest run` → 688 passed | 3 todo, 0 failed.

### Task 3: A person never changes mailbox (waits and outcomes)

**Files:** Modify `0007_rotation.sql` (claim select and the not-found path), `tests/db/rotation.test.ts`.
**Interfaces:** Consumes `v_usable`, `v_free`, `v_block_*`, `m.sticky` from Task 2. Produces the rotation rule of Global Constraints and the "blocked" outcome; test helper `answerReply(s: Seeded, sent: string, mailbox: string): Promise<string>`.

- [ ] Step 1: Add:
```ts
/** The prospect of `sent` replies (received on `mailbox`); a person writes and approves an answer. Returns its id. */
async function answerReply(s: Seeded, sent: string, mailbox: string): Promise<string> {
  const p = (await db.admin<{ id: string; email: string }>("select p.id, p.email from public.email_messages m join public.email_prospects p on p.id = m.prospect_id where m.id = $1", [sent]))[0];
  const reply = (await db.query<{ r: string }>(as(UUID_A), "select public.record_email_reply($1,$2,$3,$4,'Re: Quick question','Sounds good',$5,now(),'reply',null) as r", [p.id, mailbox, sent, p.email, `<r-${sent}@x.example>`]))[0].r;
  const a = (await db.query<{ id: string }>(as(UUID_A), "insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, reply_to_id, subject, body) values ($1,$2,$3,'reply',$4,'Re: Quick question','Hi, sure.') returning id", [ws, s.campaign, p.id, reply]))[0].id;
  await db.query(as(UUID_A), "select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')", [a]);
  return a;
}

describe("E3 a person never changes mailbox", () => {
  test("(d) removed from the campaign: the stuck follow-up waits, new prospects use the others, re-adding resumes it", async () => {
    const s = await seedCampaign(db, ws, "r3d", { n: 2 });
    const b = await addCampaignMailbox(db, ws, s.campaign, "r3db");
    await noGap(s.campaign);
    const first = await send(s.campaign);
    const p = await prospectOf(first.id!);
    const stuck = first.from === s.address ? s.mailbox : b.mailbox;
    await db.query(as(UUID_A), "delete from public.campaign_mailboxes where campaign_id = $1 and mailbox_id = $2", [s.campaign, stuck]);
    const step2 = await addStep(s, p, 2);
    expect((await send(s.campaign)).from).not.toBe(first.from);              // the new prospect, through the other one
    expect((await claim(s.campaign)).outcome).toBe("nothing_due");            // step 2 is not moved
    expect(await statusOf(step2)).toBe("approved");
    await db.query(as(UUID_A), "insert into public.campaign_mailboxes (campaign_id, mailbox_id) values ($1,$2)", [s.campaign, stuck]);
    expect(await send(s.campaign)).toMatchObject({ id: step2, from: first.from });
  });

  test("a deleted mailbox: its people wait (follow-ups and answers), new people go to the others", async () => {
    const s = await seedCampaign(db, ws, "r3x", { n: 2 });
    const b = await addCampaignMailbox(db, ws, s.campaign, "r3xb");
    await noGap(s.campaign);
    const first = await send(s.campaign);
    const p = await prospectOf(first.id!);
    const [gone, keep] = first.from === s.address ? [s.mailbox, b] : [b.mailbox, { mailbox: s.mailbox, address: s.address }];
    const step2 = await addStep(s, p, 2);
    await db.query(as(UUID_A), "delete from public.mailboxes where id = $1", [gone]);
    expect(await stickyOf(p)).toBeNull();
    expect((await send(s.campaign)).from).toBe(keep.address);
    expect((await claim(s.campaign)).outcome).toBe("nothing_due");
    expect(await statusOf(step2)).toBe("approved");
    const answer = await answerReply(s, first.id!, keep.mailbox);
    expect((await claim(s.campaign)).outcome).toBe("nothing_due");
    expect(await statusOf(answer)).toBe("approved");
  });

  test("only stuck messages are due and their mailbox is in its gap: the answer is that gap, not nothing_due", async () => {
    const s = await seedCampaign(db, ws, "r3g", { n: 1 });
    await addCampaignMailbox(db, ws, s.campaign, "r3gb");
    await set(s.campaign, "min_gap_minutes = 9, random_gap_minutes = 0");
    const first = await send(s.campaign);
    const step2 = await addStep(s, await prospectOf(first.id!), 2);
    const r = await claim(s.campaign);
    expect([r.outcome, iso(r.wait_until)]).toEqual(["gap", await gapEnd(first.from!)]);
    expect(await statusOf(step2)).toBe("approved");
  });
});
```
- [ ] Step 2: `npx vitest run tests/db/rotation.test.ts -t "never changes"` → FAIL: the deleted-mailbox test claims step 2 through the other mailbox (sticky null rotates); the gap test answers `nothing_due`. (`(d)` already passes after Task 2 and pins it.)
- [ ] Step 3: In the claim select replace the Task 2 mailbox clause and the ordering by:
```sql
     and (p.mailbox_id = any (v_usable)
          or (p.mailbox_id is null and not exists (
                select 1 from public.email_send_log l where l.prospect_id = x.prospect_id and l.mode = c.send_mode)))
   order by (p.mailbox_id is null or p.mailbox_id = any (v_free)) desc,
            (select min(u.w) from unnest(v_block_ids, v_block_waits) u(i, w) where u.i = p.mailbox_id) nulls first,
            (x.kind = 'reply') desc, x.due_at, x.step
```
  and select `(p.mailbox_id is null or p.mailbox_id = any (v_free)) as can_go` into `m`. Right after the `m.id is null` block:
```sql
  -- decision 6: the best due message is stuck to a blocked mailbox, so every due message is: its block is the earliest
  if not m.can_go then
    select u.k, u.w into v_kind, v_wait from unnest(v_block_ids, v_block_kinds, v_block_waits) u(i, k, w) where u.i = m.sticky;
    return jsonb_build_object('outcome', v_kind, 'wait_until', v_wait);
  end if;
```
- [ ] Step 4: `npx vitest run tests/db` → all pass (rotation: 15).
- [ ] Step 5: Checkpoint `npx vitest run` → 691 passed | 3 todo, 0 failed.

### Task 4: Real mode and the clock

**Files:** Modify `0007_rotation.sql` (append `set_campaign_send_mode`, `scheduler_due_work`, `scheduler_message`), `tests/db/rotation.test.ts`.
**Interfaces:** Produces `set_campaign_send_mode(p_campaign uuid, p_mode text) returns void` (0003 body; two changes below), `scheduler_due_work(p_run uuid) returns jsonb` (0005 body; `c.mailbox_id is not null` → `exists (select 1 from public.campaign_mailboxes cm where cm.campaign_id = c.id)`), `scheduler_message(p_run uuid, p_message uuid) returns jsonb` (0005 body + key `'mailbox_id', x.mailbox_id`).

- [ ] Step 1: Add:
```ts
describe("E3 real mode and the clock", () => {
  test("real mode with one verified and one unverified mailbox: the switch is allowed, only the verified one sends, rehearsal stickers are cleared", async () => {
    const s = await seedCampaign(db, ws, "r4r", { n: 2 });                    // A (first) stays unverified
    const b = await addCampaignMailbox(db, ws, s.campaign, "r4rb");
    await noGap(s.campaign);
    const reh = await send(s.campaign);
    expect((await db.try(as(UUID_A), "select public.set_campaign_send_mode($1,'real')", [s.campaign])).error?.message).toMatch(/verified mailbox/);
    await db.query(as(UUID_A), "select public.set_mailbox_verified($1, true, null)", [b.mailbox]);
    await db.query(as(UUID_A), "select public.set_campaign_send_mode($1,'real')", [s.campaign]);
    expect(await stickyOf(await prospectOf(reh.id!))).toBeNull();
    for (let i = 0; i < 2; i++) {
      const c = await claim(s.campaign);
      expect(await fromOf(c.message_id!)).toBe(b.address);
      await finish(c.message_id!, "sent");
    }
    await db.query(as(UUID_A), "select public.set_mailbox_verified($1, false, 'x')", [b.mailbox]);
    expect((await claim(s.campaign)).outcome).toBe("mailbox_not_verified");
  });

  test("the clock lists a campaign by its mailbox list and hands the claimed message's mailbox to the engine", async () => {
    await db.admin("update public.email_campaigns set status = 'paused' where status = 'active'");   // earlier campaigns out of the 20-slot list
    const s = await seedCampaign(db, ws, "r4c");
    const b = await addCampaignMailbox(db, ws, s.campaign, "r4cb");
    const empty = await seedCampaign(db, ws, "r4e");
    await db.query(as(UUID_A), "delete from public.campaign_mailboxes where campaign_id = $1", [empty.campaign]);
    await setSchedulerToken(db, TOKEN);
    const clock = anonWithToken(TOKEN);
    const run = (await db.query<{ r: { run_id: string } }>(clock, "select public.scheduler_begin_run() as r"))[0].r.run_id;
    const due = (await db.query<{ r: { campaign_ids: string[] } }>(clock, "select public.scheduler_due_work($1) as r", [run]))[0].r.campaign_ids;
    expect([due.includes(s.campaign), due.includes(empty.campaign)]).toEqual([true, false]);
    const c = (await db.query<{ r: Claim }>(clock, "select public.scheduler_claim_next_email($1,$2) as r", [run, s.campaign]))[0].r;
    const m = (await db.query<{ r: { mailbox_id: string } }>(clock, "select public.scheduler_message($1,$2) as r", [run, c.message_id]))[0].r;
    expect([s.mailbox, b.mailbox]).toContain(m.mailbox_id);
    await db.query(clock, "select public.scheduler_finish_email_send($1,$2,'dry_run',null)", [run, c.message_id]);
    await db.query(clock, "select public.scheduler_finish_run($1,'{}'::jsonb,null)", [run]);
  });
});
```
- [ ] Step 2: `npx vitest run tests/db/rotation.test.ts -t "real mode and the clock"` → FAIL: `R4: a verified mailbox is required` on the second switch (the first mailbox is unverified); `scheduler_message` has no `mailbox_id`.
- [ ] Step 3: `set_campaign_send_mode`: copy 0003 L1037-1124; replace the `c.mailbox_id is null or not exists (... b.id = c.mailbox_id ...)` test by `not exists (select 1 from public.campaign_mailboxes cm join public.mailboxes b on b.id = cm.mailbox_id where cm.campaign_id = c.id and b.workspace_id = c.workspace_id and b.status = 'ok')`; after the rehearsal-trail updates add `update public.email_prospects p set mailbox_id = null where p.campaign_id = c.id and p.mailbox_id is not null and not exists (select 1 from public.email_send_log l where l.prospect_id = p.id and l.mode = 'real');`. Repeat the 0003 revoke/grant lines for it, and the 0005 revoke/grant lines for the two scheduler functions. The scheduler bodies must not mention `public.mailboxes` (existing test).
- [ ] Step 4: `npx vitest run tests/db` → all pass (rotation: 17; `scheduler.test.ts` "no scheduler function can return the mailbox ciphertext" still green).
- [ ] Step 5: Checkpoint `npx vitest run` → 693 passed | 3 todo, 0 failed.

### Task 5: The engine sends with the message's mailbox

**Files:** Modify `src/lib/email/types.ts` (`MessageRow` + `mailbox_id: string | null`; `MESSAGE_COLUMNS` += `, mailbox_id`), `src/lib/email/store.ts` (`SendMessage` Pick += `"mailbox_id"`), `src/lib/email/engine.ts` (`sendStep` L232-242). Create `tests/engine/rotation.test.ts`.
**Interfaces:** Consumes `scheduler_message.mailbox_id` (Task 4), `email_messages.mailbox_id` stamped by the claim. Produces `sendStep(deps: SendDeps, campaignId: string, holder: string, origins: Origins, opts?: { messageId?: string }): Promise<SendStepResult>` (unchanged signature) reading `claimed.mailbox_id` for `getMailbox`, `creds` and `setMailboxVerified`; `campaign.mailbox_id` is no longer read by `sendStep`.

- [ ] Step 1: Write `tests/engine/rotation.test.ts`:
```ts
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { OutgoingEmail } from "@/lib/email/compose";
import { encryptSecret, mailboxAad } from "@/lib/email/crypto";
import { sendStep, type Origins, type SendDeps } from "@/lib/email/engine";
import type { MailCreds, SmtpTransport } from "@/lib/email/transport";
import { TestDb, as, UUID_A } from "../db/helpers";
import { addCampaignMailbox, createOwner, seedCampaign, type Seeded } from "../db/scheduler-seed";
import { SqlEmailStore } from "./email-sql-store";

// E3 on the send path: credentials and From come from the mailbox stamped on the claimed message (two real mailboxes, fake SMTP).
const KEY = randomBytes(32);
const PASS = "abcd efgh ijkl mnop";
const ORIGINS: Origins = { publicOrigin: "https://app.example.com", requestOrigin: "https://app.example.com" };
const HOLDER = "88888888-8888-4888-8888-888888888888";
class FakeSmtp implements SmtpTransport {
  sent: { creds: MailCreds; mail: OutgoingEmail }[] = [];
  fail: Error | null = null;
  async verify() {}
  async send(creds: MailCreds, mail: OutgoingEmail) {
    if (this.fail) throw this.fail;
    this.sent.push({ creds, mail });
    return { response: "250 OK" };
  }
}
let db: TestDb;
let ws: string;
let s: Seeded;
let b: { mailbox: string; address: string };
let smtp: FakeSmtp;
let deps: SendDeps;
const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(as(UUID_A), sql, params);
/** The next sequence step of a prospect, approved and due now. */
async function nextStep(prospect: string): Promise<string> {
  const [{ n }] = await q<{ n: number }>("select coalesce(max(step), 0) + 1 as n from public.email_messages where prospect_id = $1 and kind = 'sequence'", [prospect]);
  const id = (await q<{ id: string }>("insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body) values ($1,$2,$3,'sequence',$4,'Following up','Short follow-up.') returning id", [ws, s.campaign, prospect, n]))[0].id;
  await q("select public.set_email_approval(array[$1]::uuid[], public.test_versions(array[$1]::uuid[]), 'approve')", [id]);
  await db.admin("update public.email_messages set due_at = now() - interval '1 minute' where id = $1", [id]);
  return id;
}

beforeAll(async () => {
  db = await TestDb.create();
  ws = await createOwner(db);
  s = await seedCampaign(db, ws, "eng", { n: 2 });
  b = await addCampaignMailbox(db, ws, s.campaign, "engb");
  for (const [mb, address] of [[s.mailbox, s.address], [b.mailbox, b.address]]) {
    await db.admin("update public.mailboxes set secret_ciphertext = $2 where id = $1", [mb, encryptSecret(PASS, mailboxAad(ws, address), KEY)]);
    await q("select public.set_mailbox_verified($1, true, null)", [mb]);
  }
  await db.admin("update public.email_campaigns set min_gap_minutes = 0, random_gap_minutes = 0 where id = $1", [s.campaign]);
  await q("select public.set_campaign_send_mode($1,'real')", [s.campaign]);
  smtp = new FakeSmtp();
  deps = { store: new SqlEmailStore(db, UUID_A), smtp, key: KEY };
});
afterAll(async () => { await db.pg.close(); });

describe("E3 sendStep and the mailbox of the claim", () => {
  test("each real e-mail uses the credentials and From of its claimed mailbox; step 2 keeps the mailbox of step 1", async () => {
    const r1 = await sendStep(deps, s.campaign, HOLDER, ORIGINS);
    const r2 = await sendStep(deps, s.campaign, HOLDER, ORIGINS);
    expect([r1.outcome, r2.outcome]).toEqual(["sent", "sent"]);
    expect(new Set(smtp.sent.map((x) => x.creds.user))).toEqual(new Set([s.address, b.address]));
    for (const x of smtp.sent) expect(x).toMatchObject({ creds: { pass: PASS }, mail: { from: { address: x.creds.user } } });
    const [{ prospect_id }] = await q<{ prospect_id: string }>("select prospect_id from public.email_messages where id = $1", [r1.messageId]);
    const step2 = await nextStep(prospect_id);
    expect(await sendStep(deps, s.campaign, HOLDER, ORIGINS)).toEqual({ outcome: "sent", messageId: step2 });
    expect(smtp.sent[2].creds.user).toBe(smtp.sent[0].creds.user);
  });

  test("a refused password marks the mailbox of that message, not the campaign's first mailbox", async () => {
    const [{ id }] = await q<{ id: string }>("select id from public.email_prospects where campaign_id = $1 and mailbox_id = $2", [s.campaign, b.mailbox]);
    await nextStep(id);
    smtp.fail = Object.assign(new Error("Invalid login"), { code: "EAUTH" });
    expect(await sendStep(deps, s.campaign, HOLDER, ORIGINS)).toMatchObject({ outcome: "failed", error: "auth_failed", stop: true });
    smtp.fail = null;
    const st = await q<{ id: string; status: string }>("select id, status from public.mailboxes where id in ($1,$2)", [s.mailbox, b.mailbox]);
    expect(Object.fromEntries(st.map((r) => [r.id, r.status]))).toEqual({ [s.mailbox]: "ok", [b.mailbox]: "error" });
  });
});
```
- [ ] Step 2: `npx vitest run tests/engine/rotation.test.ts` → FAIL: every send uses `s.address` credentials (the campaign's first mailbox) while `From` is the claimed address; the second test marks `s.mailbox` as `error`.
- [ ] Step 3: Implement. In `sendStep` replace `campaign.mailbox_id` (L233 and L240) by `const mailboxId = claimed?.mailbox_id ?? null;` declared after `const claimed = ...`; `getMailbox(mailboxId)` when not null, else `throw new Error("mailbox gone")` as today. `fetchReplies` is already per mailbox (`sentRefs` by address): unchanged.
- [ ] Step 4: `npx vitest run tests/engine` → all pass (rotation: 2; `email-engine.test.ts` and `scheduler.test.ts` unchanged and green).
- [ ] Step 5: Checkpoint `npx tsc --noEmit && npx vitest run` → 0 type errors; 695 passed | 3 todo.

### Task 6: Campaign page: tick several mailboxes

**Files:** Create `src/lib/email/rotation.ts`, `tests/unit/email-rotation.test.ts`. Modify `src/lib/email/schedule.ts` (append), `src/app/(app)/email/actions.ts` (after `setDelays`), `src/components/email/forms.tsx` (after `DelaysForm`), `src/app/(app)/email/campanhas/[id]/page.tsx`, `src/messages/pt/email.ts` (`campaign`).
**Interfaces:** Produces `MAX_CAMPAIGN_MAILBOXES = 10`; `mailboxListChange(current: string[], next: string[]): { remove: string[]; add: string[] }`; `sentTodayByAddress(rows: { mailbox_address: string }[]): Record<string, number>`; `localDayStart(tz: string, at: Date): Date`; `setCampaignMailboxes(campaignId: string, mailboxIds: string[]): Promise<ActionResult>`; `CampaignMailboxesForm({ campaignId, options, selected }: { campaignId: string; options: { id: string; email: string; status: MailboxRow["status"]; sentToday: number }[]; selected: string[] })`; keys `t.email.campaign.mailboxes`, `.mailboxesHint`, `.sentToday`, `.saveMailboxes`, `.mailboxesError`.

- [ ] Step 1: Write `tests/unit/email-rotation.test.ts`:
```ts
import { describe, expect, test } from "vitest";
import { MAX_CAMPAIGN_MAILBOXES, mailboxListChange, sentTodayByAddress } from "@/lib/email/rotation";
import { localDayStart } from "@/lib/email/schedule";
import { fill, t } from "@/messages/pt";

describe("E3 campaign mailboxes on the screen", () => {
  test("mailboxListChange: removes what was unticked, adds what was ticked, in screen order, without duplicates", () => {
    expect(mailboxListChange(["a", "b", "c"], ["c", "d", "d", "e"])).toEqual({ remove: ["a", "b"], add: ["d", "e"] });
    expect(mailboxListChange([], ["x"])).toEqual({ remove: [], add: ["x"] });
    expect(MAX_CAMPAIGN_MAILBOXES).toBe(10);
  });
  test("sentTodayByAddress counts rows per sending address", () => {
    expect(sentTodayByAddress([{ mailbox_address: "a@x.example" }, { mailbox_address: "b@x.example" }, { mailbox_address: "a@x.example" }])).toEqual({ "a@x.example": 2, "b@x.example": 1 });
  });
  test("localDayStart matches public.local_day_start (DST days and Tokyo)", () => {
    expect(localDayStart("America/New_York", new Date("2026-03-08T12:00:00Z")).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(localDayStart("America/New_York", new Date("2026-11-01T12:00:00Z")).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(localDayStart("Asia/Tokyo", new Date("2026-11-13T20:00:00Z")).toISOString()).toBe("2026-11-13T15:00:00.000Z");
  });
  test("pt-BR texts", () => {
    expect(t.email.campaign.mailboxes).toBe("Caixas desta campanha");
    expect(fill(t.email.campaign.sentToday, { n: 3 })).toBe("3 hoje");
    expect(t.email.campaign.mailboxesError).toBe("Escolha de 1 a 10 caixas deste espaço.");
  });
});
```
- [ ] Step 2: `npx vitest run tests/unit/email-rotation.test.ts` → FAIL: `Cannot find module '@/lib/email/rotation'`.
- [ ] Step 3: Implement.
  - `rotation.ts`: no `server-only` import (pure); `mailboxListChange` keeps first occurrences of `next`, `remove` in `current` order.
  - `localDayStart`: local date of `at` in `tz` via `toLocaleDateString("en-CA", { timeZone: tz })`; `guess = Date.UTC(y, m - 1, d)`; `offset(t)` = wall clock of `t` in `tz` read as UTC minus `t`; result `guess - offset(guess - offset(guess))` (two passes: DST-safe).
  - Messages (`campaign`): `mailboxes: "Caixas desta campanha"`, `mailboxesHint: "Marque de 1 a 10 caixas. Cada pessoa fica sempre na caixa do primeiro e-mail; desmarcar uma caixa faz as pessoas dela esperarem."`, `sentToday: "{n} hoje"`, `saveMailboxes: "Salvar caixas"`, `mailboxesError: "Escolha de 1 a 10 caixas deste espaço."`.
  - `setCampaignMailboxes`: `sender()`; `uuid` check of the campaign; `z.array(uuid).min(1).max(MAX_CAMPAIGN_MAILBOXES)`; read `campaign_mailboxes.mailbox_id` of the campaign; `mailboxListChange`; delete `remove` (`.in("mailbox_id", remove)`) first, then insert each of `add` in order (one `await` each, so the order is the list order); any error → `err(M.campaign.mailboxesError)`; `refresh(`/email/campanhas/${campaignId}`, "/email")`; `ok(M.saved)`.
  - `CampaignMailboxesForm`: modelled on `DelaysForm` (`useTransition`, `router.refresh()`, status/alert span); one `<label>` per option with `<input type="checkbox">`, the address, `M.mailbox.statuses[status]` and `fill(M.campaign.sentToday, { n: sentToday })`; button `btn.ghost` with `M.campaign.saveMailboxes`; hint text below. No new styles.
  - `page.tsx`: add to the `Promise.all` `s.supabase.from("campaign_mailboxes").select("mailbox_id").eq("campaign_id", id).order("created_at", { ascending: true })` and `s.supabase.from("email_send_log").select("mailbox_address").eq("mode", campaign.send_mode).gt("claimed_at", localDayStart(campaign.timezone, new Date()).toISOString())`; `selected` = those ids; the header line (L60) shows the selected addresses joined by `" · "` or `M.send.outcomes.no_mailbox`; `realReady` = any selected mailbox with `status === "ok"` and `senderComplete(sender)`; render `CampaignMailboxesForm` (when `s.canSend && !archived`) inside the card that holds `DelaysForm`, under a `Label` `C.mailboxes`; render `FetchRepliesButton` with the selected mailboxes whose `status === "ok"` (the campaign's "Buscar respostas" reads every mailbox of the campaign).
- [ ] Step 4: `npx vitest run tests/unit` → all pass (email-rotation: 4).
- [ ] Step 5: Checkpoint `npx tsc --noEmit && npm run lint && npx vitest run` → 0 errors; 699 passed | 3 todo.

### Task 7: README and full check

**Files:** Modify `APP/README.md` L39, L65; add a section after "## Portões de envio (E2)".
**Interfaces:** none.

- [ ] Step 1: Failing check: `grep -n "0007_rotation" README.md` (expected after: L39, L65 and the new section) and `grep -n "Rodízio de caixas (E3)" README.md` (expected after: one line).
- [ ] Step 2: Run both greps; expected now: no output.
- [ ] Step 3: Edit README (Portuguese). L39: "de `0001` a `0007`" and "A `0007_rotation.sql` tem que estar aplicada **antes** de publicar esta versão do app." L65: "aplicar as migrações `0005_scheduler.sql`, `0006_gates.sql` e `0007_rotation.sql`". New section:
```md
## Rodízio de caixas (E3)
- **Várias caixas por campanha**: na página da campanha, marque de 1 a 10 caixas deste espaço. Cada caixa mostra quantos e-mails saíram dela hoje.
- **Quem recebe o 1º e-mail**: a caixa que menos enviou hoje (desde a meia-noite do fuso da campanha), entre as que podem enviar agora. Em envio real, só caixas verificadas. Caixa no limite do dia, no teto de 50 em 24 h ou no intervalo é pulada.
- **Caixa fixa por pessoa**: o 2º e 3º e-mails e as respostas saem sempre pela caixa do 1º e-mail, na mesma conversa. Se essa caixa for desmarcada, apagada, ou não estiver verificada em envio real, a pessoa **espera** (nunca muda de caixa). Marcar a caixa de novo faz ela voltar.
- **Limites**: o limite da campanha soma todas as caixas dela; o limite, o teto e o intervalo de cada caixa valem por endereço, somando todas as campanhas.
- **Envio real**: precisa de pelo menos uma caixa verificada. Ao passar de ensaio para real, as caixas escolhidas no ensaio são esquecidas. Trocar a primeira caixa de uma campanha em envio real volta a campanha para ensaio (como antes).
- `email_campaigns.mailbox_id` continua existindo e quer dizer "primeira caixa da campanha"; o banco mantém as duas coisas em sincronia.
- **Antes de publicar** esta versão do app, aplicar `0007_rotation.sql`: o envio lê a caixa gravada em cada e-mail.
```
- [ ] Step 4: Re-run the two greps → both found.
- [ ] Step 5: Checkpoint `npm run check` → typecheck, lint, tests (699 passed | 3 todo), build and bundle check green. Done when this passes with the 17 tests of `tests/db/rotation.test.ts`, the 2 of `tests/engine/rotation.test.ts` and the 4 of `tests/unit/email-rotation.test.ts`.
