-- 0028 Fase 2 "dados mais confiáveis": e-mail quality (7), e-mail cascade provenance (6). NL search (8) needs no table.
--   * email_checks: one quality verdict per workspace e-mail and how it was reached. method 'mx' (the free syntax + DNS
--     check: domain_ok | unknown | invalid) is written by senders through RLS; method 'verifier' (the paid slot:
--     verified | catch_all | unknown | invalid) only through record_verifier_verdict, which no client role may call,
--     so the browser can never mark an address verified. The closer reads none (she never sees the badge).
--   * lead_fields.source += 'pattern': e-mail GUESSES built from the contact's name and the site's domain. Senders
--     insert them directly (RLS: only field 'email', source 'pattern', status 'unverified'). A guess is never a fact:
--     it does not raise the level, is not a display value, and never enters a campaign unless the verifier said
--     'verified'.
--   * email_sendable(): the campaign rule. add_leads_to_campaign (0023 body) skips invalid and unverified-guess
--     addresses and falls back to the next one; a BEFORE INSERT/UPDATE trigger on email_prospects drops an invalid
--     address from any other path (import_list_into_campaign of 0003, a typed address, future ones) so the prospect
--     stays "sem e-mail"; claim_next_email_core (0024 body) never claims a message to an address checked invalid later.
--   * ai_calls_task += 'lead_search' (the natural-language search's LLM layer, in the user's session ledger).
-- Depends on 0001-0027. Re-runnable.

-- ---------------------------------------------------------------- email_checks
create table if not exists public.email_checks (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text not null constraint email_checks_email check (char_length(email) between 3 and 254 and email = lower(btrim(email))),
  status text not null constraint email_checks_status check (status in ('verified', 'domain_ok', 'catch_all', 'unknown', 'invalid')),
  method text not null constraint email_checks_method check (method in ('mx', 'verifier')),
  detail text constraint email_checks_detail check (detail is null or char_length(detail) <= 200),
  checked_by uuid,
  checked_at timestamptz not null default now(),
  primary key (workspace_id, email)
);

-- Who and when are the database's, never the client's.
create or replace function public.stamp_email_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.checked_by := auth.uid();
  new.checked_at := now();
  return new;
end;
$$;
drop trigger if exists stamp_email_check on public.email_checks;
create trigger stamp_email_check before insert or update on public.email_checks
  for each row execute function public.stamp_email_check();

revoke all on table public.email_checks from public, anon, authenticated;
grant select on table public.email_checks to authenticated;
grant insert (workspace_id, email, status, method, detail) on table public.email_checks to authenticated;
-- PostgREST's upsert sets every column it sends, the key included; RLS keeps both rows inside the sender's workspaces.
grant update (workspace_id, email, status, method, detail) on table public.email_checks to authenticated;
alter table public.email_checks enable row level security;
alter table public.email_checks force row level security;
drop policy if exists email_checks_select on public.email_checks;
create policy email_checks_select on public.email_checks
  for select to authenticated using (public.is_workspace_sender(workspace_id));
-- Clients write only the free check's verdicts, and never overwrite a verifier's.
drop policy if exists email_checks_insert on public.email_checks;
create policy email_checks_insert on public.email_checks
  for insert to authenticated
  with check (public.is_workspace_sender(workspace_id) and method = 'mx' and status in ('domain_ok', 'unknown', 'invalid'));
drop policy if exists email_checks_update on public.email_checks;
create policy email_checks_update on public.email_checks
  for update to authenticated
  using (public.is_workspace_sender(workspace_id) and method = 'mx')
  with check (public.is_workspace_sender(workspace_id) and method = 'mx' and status in ('domain_ok', 'unknown', 'invalid'));

-- The paid verifier's verdict. Server-side only: no client role may execute it (revoked below), so a verdict can only
-- come from a server path that does not run as the user (none is wired yet: no vendor is configured).
create or replace function public.record_verifier_verdict(p_ws uuid, p_email text, p_status text, p_verifier text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('verified', 'catch_all', 'unknown', 'invalid') then
    raise exception 'bad status' using errcode = '22023';
  end if;
  insert into public.email_checks (workspace_id, email, status, method, detail)
  values (p_ws, lower(btrim(p_email)), p_status, 'verifier', left(p_verifier, 200))
  on conflict (workspace_id, email) do update set status = excluded.status, method = 'verifier', detail = excluded.detail;
end;
$$;
revoke all on function public.record_verifier_verdict(uuid, text, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- lead_fields: 'pattern' guesses
alter table public.lead_fields drop constraint if exists lead_fields_source;
alter table public.lead_fields add constraint lead_fields_source check (source in
  ('import', 'site', 'places', 'ai', 'research', 'apify_maps', 'apollo', 'apify_contact', 'pattern'));
-- A guess is unverified and can never be confirmed: only the verifier's email_checks row makes it usable.
alter table public.lead_fields drop constraint if exists lead_fields_pattern_unverified;
alter table public.lead_fields add constraint lead_fields_pattern_unverified check (source <> 'pattern' or (field = 'email' and status <> 'confirmed'));

grant insert (workspace_id, lead_id, field, value, source, source_ref, status, excerpt) on table public.lead_fields to authenticated;
drop policy if exists lead_fields_insert_pattern on public.lead_fields;
create policy lead_fields_insert_pattern on public.lead_fields
  for insert to authenticated
  with check (field = 'email' and source = 'pattern' and status = 'unverified' and public.is_workspace_sender(workspace_id));

-- ---------------------------------------------------------------- the campaign rule
-- An address may go into a campaign unless a check said 'invalid'; a guess only after the verifier said 'verified'.
-- Internal (plain, no grant): called by the definer functions and the trigger below.
create or replace function public.email_sendable(p_ws uuid, p_email text, p_source text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select not exists (select 1 from public.email_checks k where k.workspace_id = p_ws and k.email = p_email and k.status = 'invalid')
     and (p_source is distinct from 'pattern'
          or exists (select 1 from public.email_checks k
                      where k.workspace_id = p_ws and k.email = p_email and k.status = 'verified' and k.method = 'verifier'));
$$;
revoke all on function public.email_sendable(uuid, text, text) from public, anon, authenticated;

-- Any path that inserts a prospect or changes its address: an address checked 'invalid' is dropped (the prospect stays "sem e-mail"), and so
-- is an invalid suggestion. Runs after guard_email_prospect (trigger names fire in alphabetical order).
-- Definer: a person's UPDATE runs this as 'authenticated', which may not execute email_sendable (it would let a
-- client probe another workspace's checks); the function only reads the row's own workspace.
create or replace function public.strip_invalid_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is not null and not public.email_sendable(new.workspace_id, lower(btrim(new.email)), null) then
    new.email := null;
    new.email_source := null;
    new.email_source_url := null;
    new.email_source_ref := null;
  end if;
  if new.suggested_email is not null and not public.email_sendable(new.workspace_id, lower(btrim(new.suggested_email)), null) then
    new.suggested_email := null;
    new.suggested_email_url := null;
  end if;
  return new;
end;
$$;
revoke all on function public.strip_invalid_email() from public, anon, authenticated;
drop trigger if exists strip_invalid_email on public.email_prospects;
create trigger strip_invalid_email before insert or update of email, suggested_email on public.email_prospects
  for each row execute function public.strip_invalid_email();

-- ---------------------------------------------------------------- claim_next_email_core (0024 body + email_sendable)
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
     and public.email_sendable(c.workspace_id, p.email, null)                                -- 0028: never an address checked invalid
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

-- ---------------------------------------------------------------- add_leads_to_campaign (0023 body + email_sendable)
create or replace function public.add_leads_to_campaign(p_campaign uuid, p_leads uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record;
  l record;
  e record;
  v_name text;
  v_contact text;
  v_title text;
  v_status text;
  v_added integer := 0;
  v_no_email integer := 0;
  v_blocked integer := 0;
  v_other integer := 0;
  v_suppressed integer := 0;
  v_already integer := 0;
begin
  select * into c from public.email_campaigns where id = p_campaign;
  if auth.uid() is null or c.id is null or not public.is_workspace_sender(c.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_leads), 0) > 500 then
    raise exception 'at most 500 leads at a time' using errcode = '22023';
  end if;
  if c.status = 'archived' then
    raise exception 'campaign archived' using errcode = '55000';
  end if;

  for l in
    select x.id, x.best_candidate_id
      from public.leads x
     where x.workspace_id = c.workspace_id
       and x.id in (select distinct u from unnest(coalesce(p_leads, '{}'::uuid[])) u)
     order by x.id
  loop
    perform pg_advisory_xact_lock(hashtextextended('lead-campaign:' || l.id::text, 0));
    if public.lead_blocks_email(l.id) then
      v_blocked := v_blocked + 1;
      continue;
    end if;
    if exists (select 1 from public.lead_campaign_locks k where k.lead_id = l.id and k.campaign_id <> c.id) then
      v_other := v_other + 1;
      continue;
    end if;
    if exists (select 1 from public.email_prospects p where p.campaign_id = c.id and p.lead_id = l.id) then
      v_already := v_already + 1;
      continue;
    end if;
    select lower(btrim(f.value)) as email, f.source || ':' || coalesce(f.source_ref, f.id::text) as ref into e
      from public.lead_fields f
     where f.lead_id = l.id and f.workspace_id = c.workspace_id and f.field = 'email' and f.status <> 'refuted'
       and public.is_email_address(lower(btrim(f.value)))
       and public.email_sendable(c.workspace_id, lower(btrim(f.value)), f.source)
     order by (f.status = 'confirmed') desc, f.seen_at desc, f.id
     limit 1;
    if e.email is null then
      v_no_email := v_no_email + 1;
      continue;
    end if;
    if public.is_suppressed(c.workspace_id, e.email) then
      v_suppressed := v_suppressed + 1;
      continue;
    end if;
    v_name := public.best_lead_field(l.id, 'name');
    if v_name is null then
      select k.name into v_name from public.research_candidates k where k.id = l.best_candidate_id and k.workspace_id = c.workspace_id;
    end if;
    v_name := left(btrim(coalesce(nullif(btrim(v_name), ''), split_part(e.email, '@', 2))), 200);
    v_contact := left(btrim(regexp_replace(public.best_lead_field(l.id, 'contact_name'), '[\r\n]+', ' ', 'g')), 120);
    v_title := left(btrim(regexp_replace(public.best_lead_field(l.id, 'contact_title'), '[\r\n]+', ' ', 'g')), 120);
    insert into public.email_prospects (workspace_id, campaign_id, lead_id, company_name, contact_name, contact_title,
                                        email, email_source, email_source_ref)
    values (c.workspace_id, c.id, l.id, v_name, nullif(v_contact, ''), nullif(v_title, ''), e.email, 'lead', left(e.ref, 2000))
    returning status into v_status;
    if v_status = 'active' then
      v_added := v_added + 1;
    else
      v_other := v_other + 1;
    end if;
  end loop;

  -- D6: a lead added after the approval goes out with the approved text (no new examples, no new approval).
  -- The result keeps 0021's keys.
  if v_added > 0 then
    perform public.queue_approved_sequence(c.id);
  end if;

  return jsonb_build_object('added', v_added, 'no_email', v_no_email, 'blocked', v_blocked,
                            'in_other_campaign', v_other, 'suppressed', v_suppressed, 'already', v_already);
end;
$$;

revoke all on function public.add_leads_to_campaign(uuid, uuid[]) from public, anon;
grant execute on function public.add_leads_to_campaign(uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------- a guess is not a fact
-- lead_level (0014 body): an e-mail guess does not make a lead level 1.
create or replace function public.lead_level(p_lead uuid)
returns smallint
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (select 1 from public.lead_fields f where f.lead_id = p_lead and f.field = 'active_project' and f.status = 'confirmed')
      or exists (
        select 1
          from public.research_candidates c
          join public.research_checks k on k.candidate_id = c.id and k.kind = 'has_work' and k.result = 'ok'
         where c.lead_id = p_lead and c.temperature in ('very_hot', 'hot') and c.second_pass is distinct from 'refuted'
           and exists (select 1 from public.research_evidence e where e.check_id = k.id)
      ) then 4
    when (exists (select 1 from public.lead_fields f where f.lead_id = p_lead and f.field = 'contact_name' and f.status = 'confirmed')
          and exists (select 1 from public.lead_fields f where f.lead_id = p_lead and f.field = 'contact_title' and f.status = 'confirmed'))
      or exists (
        select 1
          from public.research_candidates c
          join public.research_checks k on k.candidate_id = c.id and k.kind = 'decision_maker' and k.result = 'ok'
         where c.lead_id = p_lead and btrim(coalesce(c.ask_for_name, '')) <> '' and c.second_pass is distinct from 'refuted'
           and exists (select 1 from public.research_evidence e where e.check_id = k.id)
      ) then 3
    when exists (select 1 from public.lead_fields f where f.lead_id = p_lead and f.field = 'website' and f.status = 'confirmed')
     and exists (select 1 from public.lead_fields f where f.lead_id = p_lead and f.field = 'address' and f.status = 'confirmed') then 2
    when exists (select 1 from public.lead_fields f where f.lead_id = p_lead and f.field in ('phone', 'email') and f.status <> 'refuted'
                       and f.source <> 'pattern') then 1
    else 0
  end::smallint;
$$;

-- lead_contact_values (0027 body): the list and its counts never show a guess as the lead's e-mail.
create or replace function public.lead_contact_values(p_ws uuid)
returns table (lead_id uuid, level smallint, origin_kind text, contacted boolean, city text, phone text, email text)
language sql
stable
security invoker
set search_path = ''
as $$
  select l.id, l.level, l.origin_kind, l.first_contacted_at is not null,
         nullif(btrim(case when l.best_candidate_id is not null then c.city else fc.value end), ''),
         nullif(btrim(case when l.best_candidate_id is not null then c.phone else fp.value end), ''),
         nullif(btrim(case when l.best_candidate_id is not null then c.public_email else fe.value end), '')
    from public.leads l
    left join public.research_candidates c on c.id = l.best_candidate_id
    left join lateral (select f.value from public.lead_fields f
                        where l.best_candidate_id is null and f.lead_id = l.id and f.field = 'city' and f.status <> 'refuted'
                        order by f.seen_at, f.created_at, f.id limit 1) fc on true
    left join lateral (select f.value from public.lead_fields f
                        where l.best_candidate_id is null and f.lead_id = l.id and f.field = 'phone' and f.status <> 'refuted'
                        order by f.seen_at, f.created_at, f.id limit 1) fp on true
    left join lateral (select f.value from public.lead_fields f
                        where l.best_candidate_id is null and f.lead_id = l.id and f.field = 'email' and f.status <> 'refuted'
                          and f.source <> 'pattern'
                        order by f.seen_at, f.created_at, f.id limit 1) fe on true
   where l.workspace_id = p_ws
     -- the list skips a lead whose best candidate the caller cannot see; so do the counts
     and (l.best_candidate_id is null or c.id is not null);
$$;

revoke all on function public.lead_level(uuid) from public, anon, authenticated;
revoke all on function public.lead_contact_values(uuid) from public, anon;
grant execute on function public.lead_contact_values(uuid) to authenticated;

-- ---------------------------------------------------------------- AI task: natural-language lead search
alter table public.ai_calls drop constraint if exists ai_calls_task;
alter table public.ai_calls add constraint ai_calls_task check (
  task in ('research_questions', 'research_plan', 'research_discover', 'research_collect', 'research_verify',
           'research_second_pass', 'classify', 'email_draft', 'email_classify', 'email_reply_draft',
           'email_closer_brief', 'qualify_light', 'qualify_deep', 'qualify_places', 'profile_learn', 'email_sequence',
           'lead_search')
);
