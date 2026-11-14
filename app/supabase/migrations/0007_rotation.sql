-- 0007 Rotation (E3 "Rodizio de caixas"): a campaign may send through several mailboxes (up to 10) and each person
-- stays on one mailbox for every later step and every answer.
--
-- This part adds the join table, the sticky column and the compatibility sync; the claim body that uses them comes after.
--
--   * public.campaign_mailboxes is the source of truth for which mailboxes a campaign sends through.
--   * public.email_campaigns.mailbox_id (0003) stays as the compatibility "first mailbox": the earliest row of the list (lowest seq).
--     Two write paths exist and both keep working: the list (new screen) and the old column (campaign creation form,
--     older tests, admin fixtures). One plain function, sync_campaign_mailboxes(), serves two triggers.
--   * public.email_prospects.mailbox_id is the sticky mailbox of a person. Clients read it and never write it.
--
-- No SECURITY DEFINER function is added: the guard and the sync run as the caller, who holds exactly the grants they need
-- (insert (campaign_id, mailbox_id) on the list, update (mailbox_id) on campaigns). 0001-0006 are not edited.

-- ---------------------------------------------------------------- table
create table if not exists public.campaign_mailboxes (
  campaign_id uuid not null references public.email_campaigns (id) on delete cascade,
  -- cascade replaces 0003's "set null" (a primary-key column cannot be null): the link goes, the campaign stays
  mailbox_id uuid not null references public.mailboxes (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  created_at timestamptz not null default now(),
  -- list order: a monotonic number that cannot tie (a timestamp can, inside one clock tick); only the database writes it
  seq bigint generated always as identity,
  primary key (campaign_id, mailbox_id)
);
create index if not exists campaign_mailboxes_mailbox_idx on public.campaign_mailboxes (mailbox_id);

-- the list starts as the first mailbox every campaign already has (before the triggers exist)
insert into public.campaign_mailboxes (campaign_id, mailbox_id, workspace_id, created_at)
select c.id, c.mailbox_id, c.workspace_id, c.created_at
  from public.email_campaigns c
  join public.mailboxes b on b.id = c.mailbox_id and b.workspace_id = c.workspace_id
 order by c.created_at, c.id
on conflict do nothing;

-- ---------------------------------------------------------------- creation order of messages
-- created_at is the transaction clock and ties (two messages made or approved in one tick, or one statement). The claim
-- needs a final key that reflects creation order and cannot tie: a database-written identity number. Clients never write
-- it (insert is column-level on email_messages, and the column is GENERATED ALWAYS).
alter table public.email_messages add column if not exists seq bigint generated always as identity;

-- ---------------------------------------------------------------- sticky column
alter table public.email_prospects
  add column if not exists mailbox_id uuid references public.mailboxes (id) on delete set null;

-- ---------------------------------------------------------------- functions (plain, run as the caller)
create or replace function public.guard_campaign_mailbox()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  -- the lock serializes two people adding a mailbox to the same campaign (the cap below stays true)
  select c.workspace_id into v_ws from public.email_campaigns c where c.id = new.campaign_id for update;
  if v_ws is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not public.mailbox_in_workspace(new.mailbox_id, v_ws) then
    raise exception 'mailbox not in this workspace' using errcode = '42501';
  end if;
  if (select count(*) from public.campaign_mailboxes cm where cm.campaign_id = new.campaign_id) >= 10 then
    raise exception 'a campaign has at most 10 mailboxes' using errcode = '23514';
  end if;
  new.workspace_id := v_ws;
  new.created_at := clock_timestamp();   -- plain timestamp; the order of the list is seq (identity), which cannot tie
  return new;
end;
$$;

create or replace function public.sync_campaign_mailboxes()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_camp uuid;
begin
  if tg_table_name = 'email_campaigns' then
    -- the old column was written: put its mailbox in the list (insert first, delete second)
    if new.mailbox_id is not null then
      insert into public.campaign_mailboxes (campaign_id, mailbox_id)
      select new.id, new.mailbox_id
       where not exists (select 1 from public.campaign_mailboxes cm where cm.campaign_id = new.id and cm.mailbox_id = new.mailbox_id);
    end if;
    if tg_op = 'UPDATE' and old.mailbox_id is not null and old.mailbox_id is distinct from new.mailbox_id then
      delete from public.campaign_mailboxes cm where cm.campaign_id = new.id and cm.mailbox_id = old.mailbox_id;
    end if;
  else
    -- the list changed: the old column follows (first = earliest row) only when it is empty or no longer in the list
    v_camp := coalesce(new.campaign_id, old.campaign_id);
    update public.email_campaigns c set mailbox_id = f.first
      from (select (select cm.mailbox_id from public.campaign_mailboxes cm
                     where cm.campaign_id = v_camp order by cm.seq limit 1) as first) f
     where c.id = v_camp and c.mailbox_id is distinct from f.first
       and (c.mailbox_id is null
            or not exists (select 1 from public.campaign_mailboxes cm where cm.campaign_id = v_camp and cm.mailbox_id = c.mailbox_id));
  end if;
  return null;
end;
$$;

-- people without a sticky mailbox: the mailbox of their latest claimed message, else the latest send-log row of the
-- campaign's current mode mapped to the workspace's mailbox with that address. Returns the rows changed.
create or replace function public.backfill_prospect_mailboxes()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  n integer;
begin
  update public.email_prospects p
     set mailbox_id = s.mb
    from (
      select q.id, coalesce(
        (select x.mailbox_id from public.email_messages x
          where x.prospect_id = q.id and x.mailbox_id is not null order by x.claimed_at desc nulls last limit 1),
        (select b.id from public.email_send_log l
           join public.email_campaigns c on c.id = q.campaign_id
           join public.mailboxes b on b.workspace_id = q.workspace_id and b.email = l.mailbox_address
          where l.prospect_id = q.id and l.mode = c.send_mode order by l.claimed_at desc limit 1)) as mb
        from public.email_prospects q
       where q.mailbox_id is null
    ) s
   where p.id = s.id and s.mb is not null;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------- triggers
drop trigger if exists guard_campaign_mailbox on public.campaign_mailboxes;
create trigger guard_campaign_mailbox before insert on public.campaign_mailboxes
  for each row execute function public.guard_campaign_mailbox();
drop trigger if exists sync_campaign_mailbox_list on public.email_campaigns;
create trigger sync_campaign_mailbox_list after insert or update of mailbox_id on public.email_campaigns
  for each row execute function public.sync_campaign_mailboxes();
drop trigger if exists sync_campaign_first_mailbox on public.campaign_mailboxes;
create trigger sync_campaign_first_mailbox after insert or delete on public.campaign_mailboxes
  for each row execute function public.sync_campaign_mailboxes();

-- ---------------------------------------------------------------- grants, RLS
revoke all on function public.guard_campaign_mailbox() from public, anon, authenticated;
revoke all on function public.sync_campaign_mailboxes() from public, anon, authenticated;
revoke all on function public.backfill_prospect_mailboxes() from public, anon, authenticated;

revoke all on table public.campaign_mailboxes from public, anon, authenticated;
grant select, delete on table public.campaign_mailboxes to authenticated;
grant insert (campaign_id, mailbox_id) on table public.campaign_mailboxes to authenticated;

alter table public.campaign_mailboxes enable row level security;
alter table public.campaign_mailboxes force row level security;

drop policy if exists campaign_mailboxes_select on public.campaign_mailboxes;
create policy campaign_mailboxes_select on public.campaign_mailboxes
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists campaign_mailboxes_insert on public.campaign_mailboxes;
create policy campaign_mailboxes_insert on public.campaign_mailboxes
  for insert to authenticated
  with check (public.is_workspace_sender(workspace_id) and public.mailbox_in_workspace(mailbox_id, workspace_id));
drop policy if exists campaign_mailboxes_delete on public.campaign_mailboxes;
create policy campaign_mailboxes_delete on public.campaign_mailboxes
  for delete to authenticated using (public.is_workspace_sender(workspace_id));

-- people already sent: stick them to the mailbox they used
select public.backfill_prospect_mailboxes();

-- ---------------------------------------------------------------- claim with rotation (E3)
-- Copy of the 0006 claim; the single mailbox became the campaign's list (campaign_mailboxes), see the lock order below.
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
   where mb.id = any (v_ids) and (c.send_mode <> 'real' or mb.status = 'ok');
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
    v_limit := least(b.daily_limit, 50);
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
  return jsonb_build_object('outcome', 'claimed', 'message_id', m.id);
end;
$$;
revoke all on function public.claim_next_email_core(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- real mode and the clock (E3)
-- set_campaign_send_mode: 0003 body; (1) the verified-mailbox test reads the campaign's list, (2) rehearsal stickers are cleared.
create or replace function public.set_campaign_send_mode(p_campaign uuid, p_mode text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record;
begin
  select * into c from public.email_campaigns where id = p_campaign for update;
  if c.id is null or not public.is_workspace_sender(c.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_mode = 'dry_run' then
    update public.email_campaigns set send_mode = 'dry_run', real_enabled_by = null, real_enabled_at = null where id = c.id;
    return;
  end if;
  if p_mode <> 'real' then
    raise exception 'invalid mode' using errcode = '22023';
  end if;
  if c.send_mode = 'real' then
    return;
  end if;
  if c.status = 'archived' then
    raise exception 'an archived campaign does not send' using errcode = '55000';
  end if;
  if not public.is_workspace_owner(c.workspace_id) then
    raise exception 'R4: only an owner can turn on real sending' using errcode = '42501';
  end if;
  if not public.sender_profile_complete(c.workspace_id) then
    raise exception 'R4: legal name, postal address and sender name are required' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.campaign_mailboxes cm
      join public.mailboxes b on b.id = cm.mailbox_id
     where cm.campaign_id = c.id and b.workspace_id = c.workspace_id and b.status = 'ok'
  ) then
    raise exception 'R4: a verified mailbox is required' using errcode = '23514';
  end if;
  if exists (select 1 from public.email_messages m where m.campaign_id = c.id and m.status = 'sending') then
    raise exception 'a send is in progress; try again in a minute' using errcode = '55000';
  end if;
  update public.email_campaigns
     set send_mode = 'real', real_enabled_by = auth.uid(), real_enabled_at = now()
   where id = c.id;

  -- the rehearsal trail: back to the queue (approval kept only if nothing changed since it was given)
  with t as (
    select x.id,
           (x.approved_by is not null and x.approved_at is not null and x.approved_to is not null
            and x.approved_digest = public.message_digest(x.subject, x.body)
            and x.approved_to = public.message_target(x.kind, x.reply_to_id, p.email)) as keep
      from public.email_messages x
      join public.email_prospects p on p.id = x.prospect_id
     where x.campaign_id = c.id and x.status = 'dry_run'
  ), upd as (
    update public.email_messages x
       set status = case when t.keep then 'approved' else 'draft' end,
           approved_by = case when t.keep then x.approved_by end,
           approved_at = case when t.keep then x.approved_at end,
           approved_to = case when t.keep then x.approved_to end,
           approved_digest = case when t.keep then x.approved_digest end,
           mailbox_id = null, from_address = null, to_address = null, send_mode = null, claimed_at = null,
           claimed_by = null, claim_holder = null, claim_expires_at = null, next_gap_seconds = null,
           rfc_message_id = null, sent_at = null, error = null
      from t
     where x.id = t.id
    returning x.id, x.workspace_id, t.keep
  )
  insert into public.email_approvals (workspace_id, message_id, user_id, action)
  select upd.workspace_id, upd.id, auth.uid(), 'unapprove' from upd where not upd.keep;

  -- E3: mailboxes given during rehearsal never bind real mail; people who already have a real send keep theirs
  update public.email_prospects p set mailbox_id = null
   where p.campaign_id = c.id and p.mailbox_id is not null
     and not exists (select 1 from public.email_send_log l where l.prospect_id = p.id and l.mode = 'real');

  update public.email_prospects p
     set status = 'active'
   where p.campaign_id = c.id and p.status = 'done'
     and not exists (
       select 1 from public.email_messages s
        where s.prospect_id = p.id and s.kind = 'sequence' and s.step = 3 and s.status = 'sent'
     );

  update public.email_messages x
     set due_at = case
           when x.kind = 'reply' or x.step = 1 then now()
           else (select greatest(now(), public.add_business_days(s1.sent_at, case x.step when 2 then c.step2_delay_days else c.step3_delay_days end))
                   from public.email_messages s1
                  where s1.prospect_id = x.prospect_id and s1.kind = 'sequence' and s1.step = 1 and s1.status = 'sent')
         end
   where x.campaign_id = c.id and x.status in ('draft', 'approved', 'rejected');
end;
$$;

-- scheduler_due_work: 0005 body; a campaign counts when its list is not empty.
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
       where c.status = 'active' and c.send_mode = 'dry_run'
         and exists (select 1 from public.campaign_mailboxes cm where cm.campaign_id = c.id)
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

-- scheduler_message: 0005 body plus the mailbox stamped on the claimed message.
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
                              'in_reply_to', x.in_reply_to, 'mailbox_id', x.mailbox_id)
      from public.email_messages x
     where x.id = p_message and x.status = 'sending' and x.claim_holder = p_run and x.send_mode = 'dry_run'
  );
end;
$$;

revoke all on function public.set_campaign_send_mode(uuid, text) from public, anon;
grant execute on function public.set_campaign_send_mode(uuid, text) to authenticated;
revoke all on function public.scheduler_due_work(uuid) from public, anon, authenticated;
revoke all on function public.scheduler_message(uuid, uuid) from public, anon, authenticated;
grant execute on function public.scheduler_due_work(uuid) to anon;
grant execute on function public.scheduler_message(uuid, uuid) to anon;
