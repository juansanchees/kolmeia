-- 0005 Scheduler (E1 "Relogio"): a clock that sends approved e-mails of REHEARSAL (dry_run) campaigns with no user session.
--
-- Who calls it: an external scheduler (Supabase pg_cron + pg_net, see supabase/manual/scheduler_cron.sql) posts to
-- /api/scheduler/tick every 5 minutes. The route holds no secret: it forwards the caller's bearer token to the
-- database as the request header x-scheduler-token, and the database compares its sha256 with scheduler_state.
-- A null hash means the clock is off: every scheduler_* function refuses (fail closed).
--
-- Hard limits, enforced here and not in the app:
--   * SEND ONLY: nothing here reads replies or touches a mailbox password. No function below returns the mailbox ciphertext.
--   * DRY RUN ONLY: the scheduler claim answers 'not_active' for any campaign that is not in dry_run mode.
--   * No sending rule changes: claim_next_email / finish_email_send keep their signatures, grants and behaviour; their
--     bodies moved, unchanged, into internal *_core functions (no client grants) that the user path and the scheduler
--     path both call.
--   * Only the anon role (the public key the route already uses) may call scheduler_*; logged-in users get 'permission denied'.
--   * Nothing in the heartbeat table can hold an address, subject, body or raw error text (error is a short code).

-- ---------------------------------------------------------------- state and heartbeat
create table if not exists public.scheduler_state (
  id smallint primary key constraint scheduler_state_single check (id = 1),
  -- sha256 hex of the 64-hex-char token the scheduler sends. Null = clock off.
  token_sha256 text constraint scheduler_state_token check (token_sha256 ~ '^[0-9a-f]{64}$'),
  -- one tick at a time: the run that holds the lease and until when
  lease_run uuid,
  lease_until timestamptz
);
insert into public.scheduler_state (id) values (1) on conflict (id) do nothing;

create table if not exists public.scheduler_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text not null constraint scheduler_runs_outcome check (outcome in ('running', 'ok', 'error', 'busy')),
  campaigns integer not null default 0,
  sent integer not null default 0,
  failed integer not null default 0,
  -- a short code only (never a raw message): R10
  error text constraint scheduler_runs_error check (error ~ '^[a-z0-9_:]{1,60}$')
);
create index if not exists scheduler_runs_started_idx on public.scheduler_runs (started_at desc);

alter table public.scheduler_state enable row level security;
alter table public.scheduler_state force row level security;
alter table public.scheduler_runs enable row level security;
alter table public.scheduler_runs force row level security;
-- no policies: nobody reads or writes these tables except through the definer functions below
revoke all on table public.scheduler_state from public, anon, authenticated;
revoke all on table public.scheduler_runs from public, anon, authenticated;

-- Fairness marker: when the clock last put this campaign in its work list. Clients have no write access to it (0003 grants
-- UPDATE on email_campaigns only for name, status, mailbox_id and the two delay columns; INSERT only for the listed columns).
alter table public.email_campaigns add column if not exists scheduler_tried_at timestamptz;

-- ---------------------------------------------------------------- refactor: the sending rules move, unchanged, into *_core
-- p_actor: the person who claimed (auth.uid() on the user path, null on the scheduler path).
-- p_only_mode: when not null, a campaign in another send mode answers 'not_active' before anything is touched.
-- Not SECURITY DEFINER: they run with the rights of the definer function that calls them.
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
  v_oldest timestamptz;
  v_last record;
  v_token text;
  v_rfc text;
  v_gap integer;
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
  if c.send_mode = 'real' and b.status <> 'ok' then
    return jsonb_build_object('outcome', 'mailbox_not_verified');
  end if;
  if not public.sender_profile_complete(c.workspace_id) then
    return jsonb_build_object('outcome', 'no_sender_profile');
  end if;

  -- R2: daily limit, rolling 24 h, counted from the append-only log by sending address, across workspaces
  -- (removing and re-adding a mailbox, retrying a failure or deleting a campaign never gives a slot back)
  v_limit := least(b.daily_limit, 50);
  if public.address_claims_since(b.email, c.send_mode, now() - interval '24 hours') >= v_limit then
    select min(l.claimed_at) into v_oldest from public.email_send_log l
     where l.mailbox_address = b.email and l.mode = c.send_mode and l.claimed_at > now() - interval '24 hours';
    return jsonb_build_object('outcome', 'daily_limit', 'wait_until', v_oldest + interval '24 hours');
  end if;
  -- R2: random 60-180 s gap after the previous claim from this address
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
       (p_message is null and c.status = 'active' and x.kind = 'sequence' and p.status = 'active' and (
          x.step = 1 or exists (
            -- a follow-up needs the previous step really sent; a rehearsed step only counts in rehearsal
            select 1 from public.email_messages prev
             where prev.prospect_id = x.prospect_id and prev.kind = 'sequence' and prev.step = x.step - 1
               and (prev.status = 'sent' or (c.send_mode = 'dry_run' and prev.status = 'dry_run')))))
       -- answers to replies are a person's job: the clock (p_only_mode not null) never claims them
       or (p_only_mode is null and x.kind = 'reply' and p.status in ('replied', 'handed_off'))
     )
   order by (x.kind = 'reply') desc, x.due_at, x.step
   limit 1
   for update of x skip locked;
  if m.id is null then
    return jsonb_build_object('outcome', 'nothing_due');
  end if;

  select p.unsub_token into v_token from public.email_prospects p where p.id = m.prospect_id;
  v_rfc := '<' || replace(gen_random_uuid()::text, '-', '') || '@' || split_part(b.email, '@', 2) || '>';
  v_gap := 60 + floor(random() * 121)::integer;
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

create or replace function public.finish_email_send_core(p_message uuid, p_holder uuid, p_result text, p_error text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  m record;
  c record;
begin
  select * into m from public.email_messages where id = p_message for update;
  if m.id is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if m.status <> 'sending' or m.claim_holder is distinct from p_holder then
    raise exception 'message is not claimed by this holder' using errcode = '55000';
  end if;
  if p_result not in ('sent', 'dry_run', 'failed')
     or (p_result = 'sent' and m.send_mode <> 'real')
     or (p_result = 'dry_run' and m.send_mode <> 'dry_run') then
    raise exception 'result does not match the send mode' using errcode = '22023';
  end if;
  update public.email_messages
     set status = p_result,
         sent_at = case when p_result = 'failed' then null else now() end,
         error = case when p_result = 'failed' then left(coalesce(p_error, 'failed'), 300) end,
         claim_expires_at = null
   where id = m.id;
  update public.email_send_log l
     set result = p_result,
         error = case when p_result = 'failed' then left(coalesce(p_error, 'failed'), 300) end,
         finished_at = now()
   where l.message_id = m.id and l.holder = p_holder and l.result = 'pending';
  if p_result = 'failed' or m.kind <> 'sequence' then
    return;
  end if;
  select * into c from public.email_campaigns where id = m.campaign_id;
  if m.step = 1 then
    update public.email_messages
       set due_at = public.add_business_days(now(), case step when 2 then c.step2_delay_days else c.step3_delay_days end)
     where prospect_id = m.prospect_id and kind = 'sequence' and step in (2, 3) and status in ('draft', 'approved', 'rejected');
  elsif m.step = 3 then
    update public.email_prospects set status = 'done' where id = m.prospect_id and status = 'active';
  end if;
end;
$$;


revoke all on function public.claim_next_email_core(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.finish_email_send_core(uuid, uuid, text, text) from public, anon, authenticated;

-- Same signatures, same grants, same checks as 0003: thin wrappers for the logged-in user.
create or replace function public.claim_next_email(p_campaign uuid, p_holder uuid, p_message uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select c.workspace_id into v_ws from public.email_campaigns c where c.id = p_campaign;
  if v_ws is null or not public.is_workspace_sender(v_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return public.claim_next_email_core(p_campaign, p_holder, p_message, auth.uid(), null);
end;
$$;

create or replace function public.finish_email_send(p_message uuid, p_holder uuid, p_result text, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  select m.workspace_id into v_ws from public.email_messages m where m.id = p_message;
  if v_ws is null or not public.is_workspace_sender(v_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform public.finish_email_send_core(p_message, p_holder, p_result, p_error);
end;
$$;

revoke all on function public.claim_next_email(uuid, uuid, uuid) from public, anon;
revoke all on function public.finish_email_send(uuid, uuid, text, text) from public, anon;
grant execute on function public.claim_next_email(uuid, uuid, uuid) to authenticated;
grant execute on function public.finish_email_send(uuid, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------- scheduler functions
-- Is the caller holding the token? Reads the header PostgREST exposes. Null hash, missing header or wrong token: false.
create or replace function public.scheduler_authorized()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hash text;
  v_token text;
  v_n integer;
begin
  select s.token_sha256 into v_hash from public.scheduler_state s where s.id = 1;
  if v_hash is null then
    return false;
  end if;
  begin
    -- header names reach PostgREST in any case; exactly one matching key, else refuse
    select count(*), min(h.value) into v_n, v_token
      from json_each_text(current_setting('request.headers', true)::json) h
     where lower(h.key) = 'x-scheduler-token';
  exception when others then
    return false;
  end;
  if v_n is distinct from 1 then
    return false;
  end if;
  if v_token is null or v_token !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  return encode(sha256(convert_to(v_token, 'UTF8')), 'hex') = v_hash;
end;
$$;

-- Does this run hold the open lease?
create or replace function public.scheduler_holds_lease(p_run uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.scheduler_state s
     where s.id = 1 and s.lease_run is not null and s.lease_run = p_run and s.lease_until > now()
  );
$$;

-- Pushes the lease of the open run 120 s forward (called by every function that does work for the run).
create or replace function public.scheduler_renew_lease(p_run uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.scheduler_state set lease_until = now() + interval '120 seconds' where id = 1 and lease_run = p_run;
$$;

create or replace function public.scheduler_begin_run()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
  v_run uuid;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.scheduler_runs where started_at < now() - interval '30 days';
  select * into s from public.scheduler_state where id = 1 for update;
  if s.lease_until is not null and s.lease_until > now() then
    insert into public.scheduler_runs (outcome, finished_at) values ('busy', now()) returning id into v_run;
    return jsonb_build_object('run_id', v_run, 'busy', true);
  end if;
  -- a run whose lease ran out without reporting (crash, timeout) is closed as an error
  update public.scheduler_runs set outcome = 'error', error = 'lease_expired', finished_at = now() where outcome = 'running';
  insert into public.scheduler_runs (outcome) values ('running') returning id into v_run;
  update public.scheduler_state set lease_run = v_run, lease_until = now() + interval '120 seconds' where id = 1;
  return jsonb_build_object('run_id', v_run, 'busy', false);
end;
$$;

-- Campaigns with something to send now: active, rehearsal mode, a mailbox, a complete sender profile, at least one approved sequence step due.
-- Fair: least recently listed first (scheduler_tried_at), then oldest due; the 20 returned are stamped.
create or replace function public.scheduler_due_work(p_run uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids jsonb;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not public.scheduler_holds_lease(p_run) then
    raise exception 'lease not held' using errcode = '55000';
  end if;
  perform public.scheduler_renew_lease(p_run);
  -- Fair order: campaigns the clock has not listed yet (or listed longest ago) first, then oldest due. Only sequence
  -- steps count (the clock never claims answers), and a workspace without a complete sender profile is skipped.
  select coalesce(jsonb_agg(t.id order by t.tried nulls first, t.first_due, t.id), '[]'::jsonb) into v_ids
    from (
      select c.id, c.scheduler_tried_at as tried, min(x.due_at) as first_due
        from public.email_campaigns c
        join public.email_messages x on x.campaign_id = c.id
       where c.status = 'active' and c.send_mode = 'dry_run' and c.mailbox_id is not null
         and public.sender_profile_complete(c.workspace_id)
         and x.kind = 'sequence' and x.status = 'approved' and x.due_at is not null and x.due_at <= now()
       group by c.id, c.scheduler_tried_at
       order by c.scheduler_tried_at nulls first, min(x.due_at), c.id
       limit 20
    ) t;
  update public.email_campaigns c set scheduler_tried_at = now()
   where c.id in (select (j #>> '{}')::uuid from jsonb_array_elements(v_ids) j);
  return jsonb_build_object('campaign_ids', v_ids);
end;
$$;

-- Same claim as a person's click, as no person (claimed_by stays null; the holder is the run) and only for dry_run.
create or replace function public.scheduler_claim_next_email(p_run uuid, p_campaign uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not public.scheduler_holds_lease(p_run) then
    raise exception 'lease not held' using errcode = '55000';
  end if;
  perform public.scheduler_renew_lease(p_run);
  return public.claim_next_email_core(p_campaign, p_run, null, null, 'dry_run');
end;
$$;

create or replace function public.scheduler_finish_email_send(p_run uuid, p_message uuid, p_result text, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not public.scheduler_holds_lease(p_run) then
    raise exception 'lease not held' using errcode = '55000';
  end if;
  select x.status, x.claim_holder, x.send_mode into m from public.email_messages x where x.id = p_message;
  if m.status is distinct from 'sending' or m.claim_holder is distinct from p_run or m.send_mode is distinct from 'dry_run' then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform public.finish_email_send_core(p_message, p_run, p_result, p_error);
end;
$$;

-- Read-only helpers for building the outgoing rehearsal message. Each returns only the columns the engine reads.
-- A campaign: only active rehearsal campaigns (what due_work lists), plus the campaign of a message this run holds.
create or replace function public.scheduler_campaign(p_run uuid, p_campaign uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not public.scheduler_holds_lease(p_run) then
    raise exception 'lease not held' using errcode = '55000';
  end if;
  return (
    select jsonb_build_object('id', c.id, 'workspace_id', c.workspace_id, 'status', c.status, 'send_mode', c.send_mode, 'mailbox_id', c.mailbox_id)
      from public.email_campaigns c
     where c.id = p_campaign and c.send_mode = 'dry_run'
       and (c.status = 'active' or exists (
         select 1 from public.email_messages x where x.campaign_id = c.id and x.status = 'sending' and x.claim_holder = p_run))
  );
end;
$$;

create or replace function public.scheduler_message(p_run uuid, p_message uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not public.scheduler_holds_lease(p_run) then
    raise exception 'lease not held' using errcode = '55000';
  end if;
  return (
    select jsonb_build_object('id', x.id, 'workspace_id', x.workspace_id, 'campaign_id', x.campaign_id, 'prospect_id', x.prospect_id,
                              'kind', x.kind, 'status', x.status, 'send_mode', x.send_mode, 'from_address', x.from_address,
                              'to_address', x.to_address, 'subject', x.subject, 'body', x.body, 'rfc_message_id', x.rfc_message_id,
                              'in_reply_to', x.in_reply_to)
      from public.email_messages x
     where x.id = p_message and x.status = 'sending' and x.claim_holder = p_run and x.send_mode = 'dry_run'
  );
end;
$$;

create or replace function public.scheduler_prospect(p_run uuid, p_prospect uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not public.scheduler_holds_lease(p_run) then
    raise exception 'lease not held' using errcode = '55000';
  end if;
  return (
    select jsonb_build_object('id', p.id, 'unsub_token', p.unsub_token)
      from public.email_prospects p
     where p.id = p_prospect
       and exists (select 1 from public.email_messages x
                    where x.prospect_id = p.id and x.status = 'sending' and x.claim_holder = p_run and x.send_mode = 'dry_run')
  );
end;
$$;

create or replace function public.scheduler_sender(p_run uuid, p_workspace uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not public.scheduler_holds_lease(p_run) then
    raise exception 'lease not held' using errcode = '55000';
  end if;
  return (
    select jsonb_build_object('legal_name', sp.legal_name, 'postal_address', sp.postal_address, 'sender_name', sp.sender_name)
      from public.sender_profiles sp
     where sp.workspace_id = p_workspace
       and exists (select 1 from public.email_messages x
                    where x.workspace_id = sp.workspace_id and x.status = 'sending' and x.claim_holder = p_run and x.send_mode = 'dry_run')
  );
end;
$$;

-- Closes the run: counts, outcome, clears the lease, prunes heartbeat rows older than 30 days.
create or replace function public.scheduler_finish_run(p_run uuid, p_counts jsonb, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.scheduler_runs r
     set outcome = case when p_error is null then 'ok' else 'error' end,
         campaigns = case when jsonb_typeof(p_counts -> 'campaigns') = 'number' then least(greatest((p_counts ->> 'campaigns')::numeric, 0), 1000)::integer else 0 end,
         sent = case when jsonb_typeof(p_counts -> 'sent') = 'number' then least(greatest((p_counts ->> 'sent')::numeric, 0), 1000)::integer else 0 end,
         failed = case when jsonb_typeof(p_counts -> 'failed') = 'number' then least(greatest((p_counts ->> 'failed')::numeric, 0), 1000)::integer else 0 end,
         error = p_error,
         finished_at = now()
   where r.id = p_run and r.outcome = 'running';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'run is not open' using errcode = '55000';
  end if;
  update public.scheduler_state set lease_run = null, lease_until = null where id = 1 and lease_run = p_run;
  delete from public.scheduler_runs where started_at < now() - interval '30 days';
end;
$$;

-- Internal helpers: no client can call them. Only anon (the public key) may call the scheduler_* entry points,
-- and each of those refuses without the token.
revoke all on function public.scheduler_authorized() from public, anon, authenticated;
revoke all on function public.scheduler_holds_lease(uuid) from public, anon, authenticated;
revoke all on function public.scheduler_renew_lease(uuid) from public, anon, authenticated;
revoke all on function public.scheduler_begin_run() from public, anon, authenticated;
revoke all on function public.scheduler_due_work(uuid) from public, anon, authenticated;
revoke all on function public.scheduler_claim_next_email(uuid, uuid) from public, anon, authenticated;
revoke all on function public.scheduler_finish_email_send(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.scheduler_campaign(uuid, uuid) from public, anon, authenticated;
revoke all on function public.scheduler_message(uuid, uuid) from public, anon, authenticated;
revoke all on function public.scheduler_prospect(uuid, uuid) from public, anon, authenticated;
revoke all on function public.scheduler_sender(uuid, uuid) from public, anon, authenticated;
revoke all on function public.scheduler_finish_run(uuid, jsonb, text) from public, anon, authenticated;

grant execute on function public.scheduler_begin_run() to anon;
grant execute on function public.scheduler_due_work(uuid) to anon;
grant execute on function public.scheduler_claim_next_email(uuid, uuid) to anon;
grant execute on function public.scheduler_finish_email_send(uuid, uuid, text, text) to anon;
grant execute on function public.scheduler_campaign(uuid, uuid) to anon;
grant execute on function public.scheduler_message(uuid, uuid) to anon;
grant execute on function public.scheduler_prospect(uuid, uuid) to anon;
grant execute on function public.scheduler_sender(uuid, uuid) to anon;
grant execute on function public.scheduler_finish_run(uuid, jsonb, text) to anon;
