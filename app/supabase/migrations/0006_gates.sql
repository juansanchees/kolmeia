-- 0006 Gates (E2 "Portoes novos"): the four sending gates that were still missing, as settings plus helpers.
-- This part adds the campaign settings and the plain SQL helpers; the claim body that uses them comes after.
--
--   * Send window in the campaign's own time zone: ISO weekday in send_days and window_start <= local time < window_end.
--   * Campaign daily limit counted from local midnight of the campaign's time zone (DST-safe: 23 h and 25 h days).
--   * Gap between two e-mails of one mailbox: min_gap_minutes + a random 0..random_gap_minutes (default 9 + 5 min).
--   * One person per company per local day (company_key below).
--
-- Clients may read the new columns and may not write them (0003 grants column-level INSERT/UPDATE only for older
-- columns, so nothing is granted here). No SECURITY DEFINER function is added. Both claim wrappers of 0005 are untouched.

-- ---------------------------------------------------------------- time zone check
-- Runs inside a check constraint as the inserting client (like is_email_address), so authenticated may execute it.
create or replace function public.is_iana_timezone(p_tz text) returns boolean
language plpgsql immutable set search_path = '' as $$
begin
  if p_tz is null or (p_tz <> 'UTC' and p_tz !~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+)+$') then return false; end if;
  perform timestamptz '2000-01-01 00:00:00+00' at time zone p_tz;   -- Postgres must know the zone
  return true;
exception when others then return false;
end $$;
revoke all on function public.is_iana_timezone(text) from public, anon;
grant execute on function public.is_iana_timezone(text) to authenticated;

-- ---------------------------------------------------------------- campaign settings
alter table public.email_campaigns
  add column if not exists timezone text not null default 'America/New_York' constraint email_campaigns_timezone check (public.is_iana_timezone(timezone)),
  add column if not exists window_start time not null default '09:00',
  add column if not exists window_end time not null default '18:00',
  add column if not exists send_days smallint[] not null default '{1,2,3,4,5}'
    constraint email_campaigns_send_days check (cardinality(send_days) between 1 and 7 and send_days <@ '{1,2,3,4,5,6,7}'::smallint[]),
  add column if not exists daily_limit integer not null default 30 constraint email_campaigns_daily_limit check (daily_limit between 1 and 500),
  add column if not exists min_gap_minutes integer not null default 9 constraint email_campaigns_min_gap check (min_gap_minutes between 0 and 120),
  add column if not exists random_gap_minutes integer not null default 5 constraint email_campaigns_random_gap check (random_gap_minutes between 0 and 60);
alter table public.email_campaigns
  add constraint email_campaigns_window check (window_start < window_end);

-- ---------------------------------------------------------------- helpers (plain SQL, explicit instant)
-- local midnight -> instant (DST-safe: the arithmetic is done on the local wall clock)
create or replace function public.local_day_start(p_tz text, p_at timestamptz) returns timestamptz
language sql stable set search_path = '' as $$
  select date_trunc('day', p_at at time zone p_tz) at time zone p_tz;
$$;
create or replace function public.local_day_end(p_tz text, p_at timestamptz) returns timestamptz
language sql stable set search_path = '' as $$
  select (date_trunc('day', p_at at time zone p_tz) + interval '1 day') at time zone p_tz;
$$;

create or replace function public.in_send_window(p_tz text, p_start time, p_end time, p_days smallint[], p_at timestamptz) returns boolean
language sql stable set search_path = '' as $$
  select extract(isodow from p_at at time zone p_tz)::smallint = any (p_days)
     and (p_at at time zone p_tz)::time >= p_start and (p_at at time zone p_tz)::time < p_end;
$$;

-- one person per company: research company, else business e-mail domain, else the company name
create or replace function public.company_key(p_candidate uuid, p_email text, p_company text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(p_candidate::text,
    case when split_part(lower(p_email), '@', 2) not in ('', 'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
      'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
      'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'cox.net', 'charter.net', 'msn.com',
      'ymail.com', 'mail.com', 'gmx.com') then split_part(lower(p_email), '@', 2) end,
    lower(btrim(p_company)));
$$;

-- The first instant strictly after p_after that is inside the window on an allowed weekday (p_after itself when it is
-- already inside). Looks at most 8 days ahead; NULL when nothing is found (cannot happen: send_days is never empty).
create or replace function public.next_window_open(p_tz text, p_start time, p_end time, p_days smallint[], p_after timestamptz) returns timestamptz
language plpgsql stable set search_path = '' as $$
declare
  d integer;
  v_date date;
  v_at timestamptz;
begin
  if public.in_send_window(p_tz, p_start, p_end, p_days, p_after) then return p_after; end if;
  for d in 0..8 loop
    v_date := (p_after at time zone p_tz)::date + d;
    if extract(isodow from v_date)::smallint = any (p_days) then
      v_at := (v_date + p_start) at time zone p_tz;   -- local wall clock -> instant (DST-safe)
      if v_at > p_after then return v_at; end if;
    end if;
  end loop;
  return null;
end $$;

-- every send-log row of the campaign in that mode since p_since (mirrors address_claims_since: every result, strict >)
create or replace function public.campaign_claims_since(p_campaign uuid, p_mode text, p_since timestamptz) returns integer
language sql stable set search_path = '' as $$
  select count(*)::integer from public.email_send_log l where l.campaign_id = p_campaign and l.mode = p_mode and l.claimed_at > p_since;
$$;

revoke all on function public.local_day_start(text, timestamptz) from public, anon, authenticated;
revoke all on function public.local_day_end(text, timestamptz) from public, anon, authenticated;
revoke all on function public.in_send_window(text, time, time, smallint[], timestamptz) from public, anon, authenticated;
revoke all on function public.company_key(uuid, text, text) from public, anon, authenticated;
revoke all on function public.next_window_open(text, time, time, smallint[], timestamptz) from public, anon, authenticated;
revoke all on function public.campaign_claims_since(uuid, text, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------- gap checks (E2 gate 5)
-- The stored gap is min_gap_minutes*60 + 0..random_gap_minutes*60 seconds: 0 (no gap) up to 120+60 min = 10800 s.
alter table public.email_messages drop constraint if exists email_messages_gap;
alter table public.email_messages add constraint email_messages_gap check (next_gap_seconds between 0 and 10800);
alter table public.email_send_log drop constraint if exists email_send_log_gap;
alter table public.email_send_log add constraint email_send_log_gap check (gap_seconds between 0 and 10800);

-- ---------------------------------------------------------------- claim body (copy of 0005 + E2 gates, added task by task)
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
begin
  select * into c from public.email_campaigns where id = p_campaign;
  -- the wrappers check who may call; the scheduler path is limited to one send mode (answers like a campaign that is not active)
  if c.id is null or (p_only_mode is not null and c.send_mode is distinct from p_only_mode) then
    return jsonb_build_object('outcome', 'not_active');
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
  if c.mailbox_id is null then
    return jsonb_build_object('outcome', 'no_mailbox');
  end if;
  -- the row lock serializes every claim on this mailbox (two tabs, two campaigns); the advisory lock does the
  -- same for the same address connected in another workspace
  select * into b from public.mailboxes where id = c.mailbox_id and workspace_id = c.workspace_id for update;
  if b.id is null then
    return jsonb_build_object('outcome', 'no_mailbox');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('email-address:' || b.email, 0));
  -- E2 gate 6: one lock per workspace, so two mailboxes cannot both pick a person of the same company
  perform pg_advisory_xact_lock(hashtextextended('email-company-day:' || c.workspace_id::text, 0));
  if c.send_mode = 'real' and b.status <> 'ok' then
    return jsonb_build_object('outcome', 'mailbox_not_verified');
  end if;
  if not public.sender_profile_complete(c.workspace_id) then
    return jsonb_build_object('outcome', 'no_sender_profile');
  end if;

  -- R2 / E2 gate 4: daily limit of the mailbox, counted from the append-only log by sending address, across workspaces,
  -- from local midnight of the campaign's time zone (removing and re-adding a mailbox, retrying a failure or deleting
  -- a campaign never gives a slot back)
  v_limit := least(b.daily_limit, 50);
  if public.address_claims_since(b.email, c.send_mode, v_day_start) >= v_limit then
    return jsonb_build_object('outcome', 'daily_limit', 'wait_until',
      public.next_window_open(c.timezone, c.window_start, c.window_end, c.send_days, public.local_day_end(c.timezone, now())));
  end if;
  -- the hard cap of 50 per sending address stays rolling: two campaigns in distant zones on one mailbox have different
  -- calendar days, but never more than 50 claims in any 24 hours. Frees up when the 50th most recent claim leaves the window.
  if public.address_claims_since(b.email, c.send_mode, now() - interval '24 hours') >= 50 then
    select l.claimed_at into v_oldest from public.email_send_log l
     where l.mailbox_address = lower(b.email) and l.mode = c.send_mode and l.claimed_at > now() - interval '24 hours'
     order by l.claimed_at desc offset 49 limit 1;
    return jsonb_build_object('outcome', 'daily_limit', 'wait_until',
      public.next_window_open(c.timezone, c.window_start, c.window_end, c.send_days, v_oldest + interval '24 hours'));
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
  -- R2 / E2 gate 5: gap (min + random minutes of the campaign) after the previous claim from this address
  select l.claimed_at, l.gap_seconds into v_last
    from public.email_send_log l
   where l.mailbox_address = b.email and l.mode = c.send_mode
   order by l.claimed_at desc
   limit 1;
  if v_last.claimed_at is not null and v_last.claimed_at + make_interval(secs => v_last.gap_seconds) > now() then
    return jsonb_build_object('outcome', 'gap', 'wait_until', v_last.claimed_at + make_interval(secs => v_last.gap_seconds));
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

  select x.* into m
    from public.email_messages x
    join public.email_prospects p on p.id = x.prospect_id
   where x.campaign_id = c.id
     and (p_message is null or x.id = p_message)
     and x.status = 'approved' and x.approved_by is not null and x.approved_at is not null   -- R1
     and x.approved_to is not null
     and x.approved_to = public.message_target(x.kind, x.reply_to_id, p.email)               -- R1: approved address
     and x.due_at is not null and x.due_at <= now()
     and p.email is not null                                                                 -- R18
     and not public.is_suppressed(c.workspace_id, p.email)                                   -- R3
     and not public.is_suppressed(c.workspace_id, x.approved_to)
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
   order by (x.kind = 'reply') desc, x.due_at, x.step
   limit 1
   for update of x skip locked;
  if m.id is null then
    -- a reply looked due but the select could not take it: say what held sequence steps back, not "nothing due"
    if v_held is not null then
      return jsonb_build_object('outcome', v_held, 'wait_until', v_held_wait);
    end if;
    return jsonb_build_object('outcome', 'nothing_due');
  end if;

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
  return jsonb_build_object('outcome', 'claimed', 'message_id', m.id);
end;
$$;
revoke all on function public.claim_next_email_core(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
