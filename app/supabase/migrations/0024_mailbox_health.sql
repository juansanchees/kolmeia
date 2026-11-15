-- 0024 E4 (F4 Task 10): mailbox health, warm-up ramp, emergency stop. Values: D7 (decided by the orchestrator, to confirm).
--   * Warm-up ramp: a mailbox sends real mail at most ramp_start + ramp_step x (business days since ramp_started_at)
--     a day, never above its daily_limit (R2: 1..50). The first real claim of the mailbox starts the ramp. Rehearsal
--     (dry_run) ignores the ramp. Business days are counted in UTC (Mon-Fri), like add_business_days of 0003.
--   * Health: when a bounce is recorded for a real e-mail of a mailbox, the mailbox pauses itself (paused_bounce) once
--     it has >= 3 bounces AND bounces >= 5 % of its real sends in the last 30 days. A paused mailbox is not usable in any
--     mode; the campaign goes on through its other mailboxes (people stuck to the paused one wait, as with a mailbox
--     that is not ok). Only an owner clears the pause; bounces before the clearing no longer count.
--   * Emergency stop: workspace_settings.sending_paused. Any sender (owner or sdr) turns it on; only an owner turns it
--     off. While on, claim_next_email_core answers 'sending_paused' before anything else: no claim of any kind (click,
--     a chosen approved message, an answer to a reply, the clock; rehearsal and real). The test-to-self of a mailbox
--     (claim_test_email, D8) is not a campaign send and is not stopped.
--   * claim_next_email_core: re-created from the 0022 body (campaign FOR SHARE first, C2 sweep/select, E3 rotation,
--     outcome codes) with three changes: (1) after the campaign row, a shared advisory lock on the workspace's stop
--     switch and the 'sending_paused' check (set_sending_paused takes the same lock exclusively, so pressing stop waits
--     for claims in flight and every claim after it sees the switch); (2) a usable mailbox also needs
--     health_status = 'ok'; (3) the daily limit is mailbox_effective_limit. The C12 check stays in claim_next_email
--     (0018), which is not re-created; the scheduler claim (0005) stays pinned to dry_run.
-- Depends on 0001-0022. Re-runnable.

-- ---------------------------------------------------------------- mailbox columns
alter table public.mailboxes add column if not exists ramp_enabled boolean not null default true;
alter table public.mailboxes add column if not exists ramp_start integer not null default 5;
alter table public.mailboxes add column if not exists ramp_step integer not null default 3;
alter table public.mailboxes add column if not exists ramp_started_at timestamptz;
alter table public.mailboxes add column if not exists health_status text not null default 'ok';
alter table public.mailboxes add column if not exists paused_reason text;
alter table public.mailboxes add column if not exists paused_at timestamptz;
-- bounces recorded before an owner cleared the pause no longer count
alter table public.mailboxes add column if not exists pause_cleared_at timestamptz;

alter table public.mailboxes drop constraint if exists mailboxes_ramp_start;
alter table public.mailboxes add constraint mailboxes_ramp_start check (ramp_start between 1 and 50);
alter table public.mailboxes drop constraint if exists mailboxes_ramp_step;
alter table public.mailboxes add constraint mailboxes_ramp_step check (ramp_step between 0 and 20);
alter table public.mailboxes drop constraint if exists mailboxes_health_status;
alter table public.mailboxes add constraint mailboxes_health_status check (health_status in ('ok', 'paused_bounce'));
alter table public.mailboxes drop constraint if exists mailboxes_paused_reason_len;
alter table public.mailboxes add constraint mailboxes_paused_reason_len check (char_length(paused_reason) <= 300);

-- read only for clients (the screen shows them); written by the claim, the bounce trigger and clear_mailbox_pause
grant select (ramp_enabled, ramp_start, ramp_step, ramp_started_at, health_status, paused_reason, paused_at, pause_cleared_at)
  on table public.mailboxes to authenticated;

-- ---------------------------------------------------------------- emergency stop column
alter table public.workspace_settings add column if not exists sending_paused boolean not null default false;
alter table public.workspace_settings add column if not exists sending_paused_at timestamptz;
alter table public.workspace_settings add column if not exists sending_paused_by uuid references auth.users (id) on delete set null;
-- (select on workspace_settings is granted on the whole table in 0002; insert/update stay limited to the AI-cap
-- columns, so the switch moves only through set_sending_paused)

-- ---------------------------------------------------------------- ramp
-- Mon-Fri days after p_from up to and including p_to (UTC calendar days). Internal (plain, no grant).
create or replace function public.business_days_between(p_from timestamptz, p_to timestamptz)
returns integer
language sql
immutable
set search_path = ''
as $$
  select count(*)::integer
    from generate_series((p_from at time zone 'UTC')::date + 1, (p_to at time zone 'UTC')::date, interval '1 day') d
   where extract(isodow from d) < 6;
$$;
revoke all on function public.business_days_between(timestamptz, timestamptz) from public, anon, authenticated;

-- How many e-mails the mailbox may send today in this mode: real with the ramp on = the ramp (day 0 until the first real
-- claim starts it), capped by daily_limit; otherwise daily_limit. The claim also caps at 50. Internal (plain, no grant).
create or replace function public.mailbox_effective_limit(p_mailbox uuid, p_mode text)
returns integer
language sql
stable
set search_path = ''
as $$
  select case
           when p_mode = 'real' and b.ramp_enabled then
             least(b.daily_limit,
                   b.ramp_start + b.ramp_step * coalesce(public.business_days_between(b.ramp_started_at, now()), 0))
           else b.daily_limit
         end
    from public.mailboxes b
   where b.id = p_mailbox;
$$;
revoke all on function public.mailbox_effective_limit(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- health: auto pause on bounces
-- Re-reads one mailbox's bounces and pauses it when D7 says so. Internal (plain, no grant): called by the trigger below.
create or replace function public.check_mailbox_bounces(p_mailbox uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  b record;
  v_since timestamptz;
  v_bounces integer;
  v_sends integer;
begin
  select * into b from public.mailboxes where id = p_mailbox for update;
  if b.id is null or b.health_status <> 'ok' then
    return;
  end if;
  v_since := greatest(now() - interval '30 days', coalesce(b.pause_cleared_at, '-infinity'::timestamptz));
  -- a bounce belongs to the mailbox that sent the bounced e-mail (else the mailbox that received the report)
  select count(*) into v_bounces
    from public.email_replies r
    left join public.email_messages m on m.id = r.message_id
   where r.is_bounce and r.created_at > v_since
     and coalesce(m.mailbox_id, r.mailbox_id) = b.id
     and (m.id is null or m.send_mode = 'real');
  select count(*) into v_sends
    from public.email_send_log l
   where l.mailbox_address = lower(b.email) and l.mode = 'real' and l.result = 'sent'
     and l.claimed_at > now() - interval '30 days';
  if v_bounces >= 3 and v_bounces * 100 >= v_sends * 5 then
    update public.mailboxes
       set health_status = 'paused_bounce', paused_at = now(),
           paused_reason = format('%s devoluções em %s envios reais (30 dias)', v_bounces, v_sends)
     where id = b.id;
  end if;
end;
$$;
revoke all on function public.check_mailbox_bounces(uuid) from public, anon, authenticated;

-- Definer: a bounce is recorded by record_email_reply or confirm_possible_bounce (both definer) for any sender of the
-- workspace; the mailbox row it pauses is owner-writable only.
create or replace function public.pause_mailbox_on_bounces()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mailbox uuid;
begin
  if not new.is_bounce or (tg_op = 'UPDATE' and old.is_bounce) then
    return null;
  end if;
  select coalesce(m.mailbox_id, new.mailbox_id) into v_mailbox
    from (select 1) one left join public.email_messages m on m.id = new.message_id;
  if v_mailbox is not null then
    perform public.check_mailbox_bounces(v_mailbox);
  end if;
  return null;
end;
$$;
revoke all on function public.pause_mailbox_on_bounces() from public, anon, authenticated;

drop trigger if exists pause_mailbox_on_bounces on public.email_replies;
create trigger pause_mailbox_on_bounces
  after insert or update of is_bounce on public.email_replies
  for each row when (new.is_bounce)
  execute function public.pause_mailbox_on_bounces();

-- An owner looked at the bounces and puts the mailbox back to work.
create or replace function public.clear_mailbox_pause(p_mailbox uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b record;
begin
  select * into b from public.mailboxes where id = p_mailbox for update;
  if b.id is null or auth.uid() is null or not public.is_workspace_owner(b.workspace_id) then
    raise exception 'E4: only an owner can clear a mailbox pause' using errcode = '42501';
  end if;
  update public.mailboxes
     set health_status = 'ok', paused_reason = null, paused_at = null, pause_cleared_at = now()
   where id = b.id;
end;
$$;
revoke all on function public.clear_mailbox_pause(uuid) from public, anon;
grant execute on function public.clear_mailbox_pause(uuid) to authenticated;

-- ---------------------------------------------------------------- emergency stop
-- "Parar todos os envios": any sender turns it on; only an owner turns it off. The exclusive advisory lock waits for
-- claims in flight (they hold it shared) so no claim that starts after this returns can miss the switch.
create or replace function public.set_sending_paused(p_ws uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_ws is null or p_on is null or not public.is_workspace_sender(p_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not p_on and not public.is_workspace_owner(p_ws) then
    raise exception 'E4: only an owner can turn sending back on' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('email-sending-paused:' || p_ws::text, 0));
  insert into public.workspace_settings (workspace_id, sending_paused, sending_paused_at, sending_paused_by)
  values (p_ws, p_on, case when p_on then now() end, case when p_on then auth.uid() end)
  on conflict (workspace_id) do update
     set sending_paused = excluded.sending_paused,
         sending_paused_at = case when excluded.sending_paused and public.workspace_settings.sending_paused
                                  then public.workspace_settings.sending_paused_at else excluded.sending_paused_at end,
         sending_paused_by = case when excluded.sending_paused and public.workspace_settings.sending_paused
                                  then public.workspace_settings.sending_paused_by else excluded.sending_paused_by end;
end;
$$;
revoke all on function public.set_sending_paused(uuid, boolean) from public, anon;
grant execute on function public.set_sending_paused(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------- the screen's usage line (0003 body + the real limit)
create or replace function public.mailbox_usage(p_mailbox uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b record;
  v_since timestamptz := now() - interval '24 hours';
  v_next timestamptz;
begin
  select * into b from public.mailboxes where id = p_mailbox;
  if b.id is null or not public.is_workspace_member(b.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select max(l.claimed_at + make_interval(secs => l.gap_seconds)) into v_next
    from public.email_send_log l
   where l.mailbox_address = b.email and l.mode in ('real', 'dry_run') and l.claimed_at > now() - interval '1 hour';
  return jsonb_build_object(
    'real', public.address_claims_since(b.email, 'real', v_since),
    'dry_run', public.address_claims_since(b.email, 'dry_run', v_since),
    'test', public.address_claims_since(b.email, 'test', v_since),
    'limit', least(b.daily_limit, 50),
    'real_limit', least(public.mailbox_effective_limit(b.id, 'real'), 50),
    'test_limit', 5,
    'next_at', case when v_next > now() then v_next end);
end;
$$;
revoke all on function public.mailbox_usage(uuid) from public, anon;
grant execute on function public.mailbox_usage(uuid) to authenticated;

-- ---------------------------------------------------------------- the shared claim (0022 body + E4)
-- Not definer (as in 0005-0022): only the definer wrappers call it.
create or replace function public.claim_next_email_core(p_campaign uuid, p_holder uuid, p_message uuid, p_actor uuid, p_only_mode text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  c record;
  b record;
  m record;
  v_limit integer;
  v_day_start timestamptz;
  v_last record;
  v_token text;
  v_rfc text;
  v_gap integer;
  v_seq_open boolean;
  v_reply_due boolean;
  v_held text;
  v_held_wait timestamptz;
  v_oldest timestamptz;
  v_usable uuid[];
  v_ids uuid[];
  v_free uuid[] := '{}';
  v_block_ids uuid[] := '{}';
  v_block_kinds text[] := '{}';
  v_block_waits timestamptz[] := '{}';
  v_kind text;
  v_wait timestamptz;
  v_id uuid;
begin
  -- 0022: the campaign row FOR SHARE first; set_campaign_send_mode takes it FOR UPDATE, so "go real" waits for the claim
  -- (and the claim for it) instead of interleaving with the mailbox locks below (E3 review: rehearsal sticker / 40P01).
  select * into c from public.email_campaigns where id = p_campaign for share;
  -- the wrappers check who may call; the scheduler path is limited to one send mode (answers like a campaign that is not active)
  if c.id is null or (p_only_mode is not null and c.send_mode is distinct from p_only_mode) then
    return jsonb_build_object('outcome', 'not_active');
  end if;
  -- 0024 E4 emergency stop: before anything else, for every kind of claim (click, chosen message, reply, clock; any
  -- mode). Shared lock: claims never wait for each other; set_sending_paused (exclusive) waits for claims in flight.
  perform pg_advisory_xact_lock_shared(hashtextextended('email-sending-paused:' || c.workspace_id::text, 0));
  if coalesce((select s.sending_paused from public.workspace_settings s where s.workspace_id = c.workspace_id), false) then
    return jsonb_build_object('outcome', 'sending_paused');
  end if;

  -- A claim that never reported back (tab closed mid-send): its result is unknown. Never resent automatically
  -- (R9); a person checks the Gmail "Sent" folder and decides (retry_failed_email with confirmation).
  with stale as (
    update public.email_messages
       set status = 'failed', error = 'interrupted', claim_expires_at = null
     where workspace_id = c.workspace_id and status = 'sending' and claim_expires_at < now()
    returning id, claim_holder
  )
  update public.email_send_log l
     set result = 'unknown', error = 'interrupted', finished_at = now()
    from stale s
   where l.message_id = s.id and l.holder = s.claim_holder and l.result = 'pending';

  if p_message is null and c.status <> 'active' then
    return jsonb_build_object('outcome', 'not_active');
  end if;
  -- E2 gate 3: sequence steps only inside the campaign's window (its own time zone); answers to replies are exempt
  v_seq_open := public.in_send_window(c.timezone, c.window_start, c.window_end, c.send_days, now());
  v_reply_due := p_only_mode is null and exists (
    select 1 from public.email_messages r
     where r.campaign_id = c.id and r.kind = 'reply' and r.status = 'approved' and r.due_at <= now());
  if p_message is null and not v_seq_open then
    v_held_wait := public.next_window_open(c.timezone, c.window_start, c.window_end, c.send_days, now());
    if not v_reply_due then
      return jsonb_build_object('outcome', 'outside_window', 'wait_until', v_held_wait);
    end if;
    v_held := 'outside_window';
  end if;
  v_day_start := public.local_day_start(c.timezone, now());
  -- E3 lock order (E2 generalised; cannot deadlock): (1) all mailbox rows of the campaign in ONE statement, by address.
  -- Rows belong to one workspace and every claim of that workspace sorts them the same way, so two campaigns sharing
  -- mailboxes lock them in the same order. This same statement is the ONLY read of the campaign's mailbox list: the ids
  -- it returns are the candidates for the rest of the claim (a row committed later is not a candidate, so no counter is
  -- ever read without its row lock and address lock). (2) address advisory locks, ascending, taken only after every row
  -- lock: a claim never waits for a row while holding an address lock, and the same address in another workspace (a
  -- different row) sorts to the same position. (3) the workspace lock of E2 gate 6, last, as in E2. (4) skip locked.
  select array_agg(s.id order by s.email) into v_ids
    from (select mb.id, mb.email
            from public.mailboxes mb
            join public.campaign_mailboxes cm on cm.mailbox_id = mb.id
           where cm.campaign_id = c.id and mb.workspace_id = c.workspace_id
           order by mb.email
             for update of mb) s;
  if v_ids is null then
    return jsonb_build_object('outcome', 'no_mailbox');
  end if;
  for b in select mb.email from public.mailboxes mb where mb.id = any (v_ids) order by mb.email loop
    perform pg_advisory_xact_lock(hashtextextended('email-address:' || b.email, 0));
  end loop;
  perform pg_advisory_xact_lock(hashtextextended('email-company-day:' || c.workspace_id::text, 0));
  select array_agg(mb.id order by mb.email) into v_usable
    from public.mailboxes mb
   where mb.id = any (v_ids) and (c.send_mode <> 'real' or mb.status = 'ok')
     and mb.health_status = 'ok';                                             -- 0024 E4: paused on bounces, in any mode
  if v_usable is null then
    return jsonb_build_object('outcome', 'mailbox_not_verified');
  end if;
  if not public.sender_profile_complete(c.workspace_id) then
    return jsonb_build_object('outcome', 'no_sender_profile');
  end if;

  -- per mailbox (R2 / E2 gates 4 and 5): calendar-day limit, rolling cap of 50, gap. Counted from the append-only log by
  -- sending address, across workspaces and campaigns, from local midnight of the campaign's time zone (removing and
  -- re-adding a mailbox, retrying a failure or deleting a campaign never gives a slot back).
  foreach v_id in array v_usable loop
    select * into b from public.mailboxes where id = v_id;
    v_kind := null;
    v_limit := least(public.mailbox_effective_limit(b.id, c.send_mode), 50);   -- 0024 E4: warm-up ramp (real only)
    if public.address_claims_since(b.email, c.send_mode, v_day_start) >= v_limit then
      v_kind := 'daily_limit';
      v_wait := public.next_window_open(c.timezone, c.window_start, c.window_end, c.send_days, public.local_day_end(c.timezone, now()));
    elsif public.address_claims_since(b.email, c.send_mode, now() - interval '24 hours') >= 50 then
      -- the hard cap of 50 per sending address stays rolling: frees up when the 50th most recent claim leaves the window
      select l.claimed_at into v_oldest from public.email_send_log l
       where l.mailbox_address = lower(b.email) and l.mode = c.send_mode and l.claimed_at > now() - interval '24 hours'
       order by l.claimed_at desc offset 49 limit 1;
      v_kind := 'daily_limit';
      v_wait := public.next_window_open(c.timezone, c.window_start, c.window_end, c.send_days, v_oldest + interval '24 hours');
    else
      select l.claimed_at, l.gap_seconds into v_last
        from public.email_send_log l
       where l.mailbox_address = b.email and l.mode = c.send_mode
       order by l.claimed_at desc
       limit 1;
      if v_last.claimed_at is not null and v_last.claimed_at + make_interval(secs => v_last.gap_seconds) > now() then
        v_kind := 'gap';
        v_wait := v_last.claimed_at + make_interval(secs => v_last.gap_seconds);
      end if;
    end if;
    if v_kind is null then
      v_free := v_free || b.id;
    else
      v_block_ids := v_block_ids || b.id; v_block_kinds := v_block_kinds || v_kind; v_block_waits := v_block_waits || v_wait;
    end if;
  end loop;
  if cardinality(v_free) = 0 and not ('gap' = any (v_block_kinds)) then   -- E2 order: the mailbox limit answers before the campaign limit
    return jsonb_build_object('outcome', 'daily_limit', 'wait_until', (select min(w) from unnest(v_block_waits) w));
  end if;
  -- E2 gate 4: the campaign's own limit, same calendar day; answers to replies are exempt
  if p_message is null and v_seq_open
     and public.campaign_claims_since(c.id, c.send_mode, v_day_start) >= c.daily_limit then
    v_seq_open := false;
    v_held_wait := public.next_window_open(c.timezone, c.window_start, c.window_end, c.send_days, public.local_day_end(c.timezone, now()));
    if not v_reply_due then
      return jsonb_build_object('outcome', 'campaign_limit', 'wait_until', v_held_wait);
    end if;
    v_held := 'campaign_limit';
  end if;
  -- every usable mailbox is in its gap or at a limit: the earliest wait wins
  if cardinality(v_free) = 0 then
    select u.k, u.w into v_kind, v_wait from unnest(v_block_kinds, v_block_waits) u(k, w) order by u.w limit 1;
    return jsonb_build_object('outcome', v_kind, 'wait_until', v_wait);
  end if;

  -- R3: waiting messages to suppressed addresses/domains are cancelled and their prospects stopped
  with hit as (
    select x.id, x.prospect_id
      from public.email_messages x
      join public.email_prospects p on p.id = x.prospect_id
     where x.campaign_id = c.id and x.status in ('draft', 'approved', 'rejected')
       and ((p.email is not null and public.is_suppressed(c.workspace_id, p.email))
            or (x.approved_to is not null and public.is_suppressed(c.workspace_id, x.approved_to)))
  ), stop_p as (
    update public.email_prospects p
       set status = 'stopped', stop_reason = coalesce(p.stop_reason, 'suppressed')
     where p.id in (select prospect_id from hit) and p.status in ('active', 'skipped', 'done')
  )
  update public.email_messages x
     set status = 'cancelled', cancel_reason = 'suppressed'
   where x.id in (select id from hit);

  -- 0022 C2: waiting messages of a lead that must not get e-mail are cancelled and its prospects stopped (the lead's
  -- trigger does this at once; this sweep covers anything that slipped past it, e.g. a prospect linked afterwards)
  with blocked as (
    select x.id, x.prospect_id, public.lead_stop_reason(public.prospect_lead(p.lead_id, p.candidate_id, p.workspace_id)) as reason
      from public.email_messages x
      join public.email_prospects p on p.id = x.prospect_id
     where x.campaign_id = c.id and x.status in ('draft', 'approved', 'rejected')
       and public.lead_blocks_message(public.prospect_lead(p.lead_id, p.candidate_id, p.workspace_id), x.kind)
  ), stop_b as (
    update public.email_prospects p
       set status = 'stopped', stop_reason = coalesce(p.stop_reason, bl.reason)
      from blocked bl
     where p.id = bl.prospect_id and p.status in ('active', 'skipped', 'done')
  )
  update public.email_messages x
     set status = 'cancelled', cancel_reason = bl.reason
    from blocked bl
   where x.id = bl.id;

  select x.*, p.mailbox_id as sticky, (p.mailbox_id is null or p.mailbox_id = any (v_free)) as can_go into m
    from public.email_messages x
    join public.email_prospects p on p.id = x.prospect_id
   where x.campaign_id = c.id
     and (p_message is null or x.id = p_message)
     and x.status = 'approved' and x.approved_by is not null and x.approved_at is not null   -- R1
     and x.approved_to is not null
     and x.approved_to = public.message_target(x.kind, x.reply_to_id, p.email)               -- R1: approved address
     and x.due_at is not null and x.due_at <= now()
     -- E3: a person stays on one mailbox. Only a person with no sticky mailbox AND no send-log row in this mode may be
     -- given one by rotation (a deleted sticky mailbox nulls the column, but the person already wrote: they wait).
     and (p.mailbox_id = any (v_usable)
          or (p.mailbox_id is null and not exists (
                select 1 from public.email_send_log l where l.prospect_id = x.prospect_id and l.mode = c.send_mode)))
     and p.email is not null                                                                 -- R18
     and not public.is_suppressed(c.workspace_id, p.email)                                   -- R3
     and not public.is_suppressed(c.workspace_id, x.approved_to)
     and not public.lead_blocks_message(public.prospect_lead(p.lead_id, p.candidate_id, p.workspace_id), x.kind)   -- C2 (0022)
     and (
       (p_message is null and v_seq_open and c.status = 'active' and x.kind = 'sequence' and p.status = 'active' and (
          x.step = 1 or exists (
            -- a follow-up needs the previous step really sent; a rehearsed step only counts in rehearsal
            select 1 from public.email_messages prev
             where prev.prospect_id = x.prospect_id and prev.kind = 'sequence' and prev.step = x.step - 1
               and (prev.status = 'sent' or (c.send_mode = 'dry_run' and prev.status = 'dry_run'))))
          and not exists (
            -- E2 gate 6: another person of the same company already has a claim today (same workspace, same send mode).
            -- Reads the append-only log, which retries and edits never touch, and only results that mean an e-mail went
            -- out, is going out right now or was rehearsed (a failed or interrupted claim does not block the company).
            -- A NULL key never equals another key, so a prospect without a usable key is never blocked.
            select 1 from public.email_send_log l
              left join public.email_messages om on om.id = l.message_id
              left join public.email_prospects op on op.id = l.prospect_id
             where l.workspace_id = c.workspace_id and l.mode = c.send_mode and l.claimed_at > v_day_start
               and l.prospect_id <> x.prospect_id and l.result in ('pending', 'sent', 'dry_run')
               and coalesce(om.kind, 'sequence') = 'sequence'
               and public.company_key(op.candidate_id, l.to_address, op.company_name)
                 = public.company_key(p.candidate_id, x.approved_to, p.company_name)))
       -- answers to replies are a person's job: the clock (p_only_mode not null) never claims them
       or (p_only_mode is null and x.kind = 'reply' and p.status in ('replied', 'handed_off'))
     )
   order by (p.mailbox_id is null or p.mailbox_id = any (v_free)) desc,
            (select min(u.w) from unnest(v_block_ids, v_block_waits) u(i, w) where u.i = p.mailbox_id) nulls first,
            (x.kind = 'reply') desc, x.due_at, x.step, x.seq
   limit 1
   for update of x skip locked;
  if m.id is null then
    -- a reply looked due but the select could not take it: say what held sequence steps back, not "nothing due"
    if v_held is not null then
      return jsonb_build_object('outcome', v_held, 'wait_until', v_held_wait);
    end if;
    return jsonb_build_object('outcome', 'nothing_due');
  end if;
  -- decision 6: the best due message is stuck to a blocked mailbox, so every due message is: its block is the earliest
  if not m.can_go then
    select u.k, u.w into v_kind, v_wait from unnest(v_block_ids, v_block_kinds, v_block_waits) u(i, k, w) where u.i = m.sticky;
    return jsonb_build_object('outcome', v_kind, 'wait_until', v_wait);
  end if;

  -- E3: the person's own mailbox, else the free one with the fewest claims today (ties: oldest last claim)
  select mb.* into b from public.mailboxes mb
   where mb.id = coalesce(m.sticky, (
     select f.id from public.mailboxes f where f.id = any (v_free)
      order by public.address_claims_since(f.email, c.send_mode, v_day_start),
               (select max(l.claimed_at) from public.email_send_log l where l.mailbox_address = f.email and l.mode = c.send_mode) nulls first,
               f.id
      limit 1));

  select p.unsub_token into v_token from public.email_prospects p where p.id = m.prospect_id;
  v_rfc := '<' || replace(gen_random_uuid()::text, '-', '') || '@' || split_part(b.email, '@', 2) || '>';
  v_gap := c.min_gap_minutes * 60 + floor(random() * (c.random_gap_minutes * 60 + 1))::integer;
  update public.email_messages x
     set status = 'sending',
         mailbox_id = b.id,
         from_address = b.email,
         to_address = m.approved_to,
         send_mode = c.send_mode,
         claimed_at = now(),
         claimed_by = p_actor,
         claim_holder = p_holder,
         claim_expires_at = now() + interval '120 seconds',
         next_gap_seconds = v_gap,
         rfc_message_id = v_rfc
   where x.id = m.id;
  insert into public.email_send_log (workspace_id, campaign_id, prospect_id, message_id, mailbox_address, mode, to_address,
                                     unsub_token, claimed_by, holder, gap_seconds, smtp_message_id)
  values (c.workspace_id, c.id, m.prospect_id, m.id, b.email, c.send_mode, m.approved_to,
          v_token, p_actor, p_holder, v_gap, v_rfc);
  insert into public.email_unsub_tokens (token, workspace_id, prospect_id)
  values (v_token, c.workspace_id, m.prospect_id)
  on conflict (token) do nothing;
  update public.email_prospects set mailbox_id = b.id where id = m.prospect_id and mailbox_id is null;
  -- 0024 E4: the first real claim of a mailbox starts its warm-up ramp
  if c.send_mode = 'real' and b.ramp_started_at is null then
    update public.mailboxes set ramp_started_at = now() where id = b.id and ramp_started_at is null;
  end if;
  return jsonb_build_object('outcome', 'claimed', 'message_id', m.id);
end;
$$;
revoke all on function public.claim_next_email_core(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
