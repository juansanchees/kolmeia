-- 0022 The lead status is the truth (F4 Task 3, C2).
--   * A lead that must not get e-mail (lead_blocks_email of 0021: discarded, do_not_call, and D5 with_closer, meeting,
--     won, lost) stops every campaign it is in: its prospects in active|skipped|done -> stopped, their waiting steps
--     cancelled. stop_reason / cancel_reason: 'do_not_call', 'lead_discarded', else 'lead_status' (D5).
--     The prospects are found by email_prospects.lead_id AND through the research candidate (older rows, or a candidate
--     linked to a lead after the import). Forward only: un-discarding the lead restarts nothing.
--   * claim_next_email_core (click and clock share it): re-created from the 0007 body (the newest; 0018 only wraps it
--     in claim_next_email with the C12 check, which stays as it is). Changes: (1) the campaign row is taken FOR SHARE
--     first, so a claim and set_campaign_send_mode ("go real", FOR UPDATE) never interleave (E3 review, 40P01);
--     (2) the R3 sweep also cancels waiting messages of blocked leads and stops their prospects; (3) the candidate
--     select skips blocked leads. Outcome codes unchanged.
-- Depends on 0001-0021. Re-runnable.

-- ---------------------------------------------------------------- stop reason
alter table public.email_prospects drop constraint if exists email_prospects_stop_reason;
alter table public.email_prospects
  add constraint email_prospects_stop_reason check (
    stop_reason in ('unsubscribed', 'bounced', 'suppressed', 'asked_to_stop', 'replied', 'in_other_campaign',
                    'lead_discarded', 'do_not_call', 'lead_status')
  );

-- Why a lead gets no e-mail (only meaningful when lead_blocks_email is true). Internal (plain, no grant).
create or replace function public.lead_stop_reason(p_lead uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select case when l.do_not_call then 'do_not_call' when l.status = 'discarded' then 'lead_discarded' else 'lead_status' end
    from public.leads l
   where l.id = p_lead;
$$;
revoke all on function public.lead_stop_reason(uuid) from public, anon, authenticated;

-- The lead a prospect belongs to: its own lead_id, else its research candidate's lead. Internal (plain, no grant).
create or replace function public.prospect_lead(p_lead uuid, p_candidate uuid, p_ws uuid)
returns uuid
language sql
stable
set search_path = ''
as $$
  select coalesce(p_lead, (select k.lead_id from public.research_candidates k where k.id = p_candidate and k.workspace_id = p_ws));
$$;
revoke all on function public.prospect_lead(uuid, uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- C2 trigger
-- Definer: whoever changes the lead (sdr, closer, log_call, an import) must stop prospects they may not write.
create or replace function public.stop_email_on_lead_block()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  p record;
begin
  if not public.lead_blocks_email(new.id) then
    return null;
  end if;
  v_reason := public.lead_stop_reason(new.id);
  for p in
    select x.id
      from public.email_prospects x
      left join public.research_candidates k on k.id = x.candidate_id and k.workspace_id = x.workspace_id
     where x.workspace_id = new.workspace_id
       and (x.lead_id = new.id or k.lead_id = new.id)
       and x.status in ('active', 'skipped', 'done')
     order by x.id
       for update of x
  loop
    update public.email_prospects set status = 'stopped', stop_reason = v_reason where id = p.id;
    perform public.cancel_pending_steps(p.id, v_reason);
  end loop;
  return null;
end;
$$;
revoke all on function public.stop_email_on_lead_block() from public, anon, authenticated;

drop trigger if exists stop_email_on_lead_block on public.leads;
create trigger stop_email_on_lead_block
  after update of status, do_not_call on public.leads
  for each row when (old.status is distinct from new.status or old.do_not_call is distinct from new.do_not_call)
  execute function public.stop_email_on_lead_block();

-- ---------------------------------------------------------------- the shared claim (0007 body + C2 + campaign FOR SHARE)
-- Not definer (as in 0005-0007): only the definer wrappers call it. claim_next_email (0018, with the C12 check) and
-- scheduler_claim_next_email (0005, dry_run only) are not re-created and keep calling this function.
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

  -- 0022 C2: waiting messages of a lead that must not get e-mail are cancelled and its prospects stopped (the lead's
  -- trigger does this at once; this sweep covers anything that slipped past it, e.g. a prospect linked afterwards)
  with blocked as (
    select x.id, x.prospect_id, public.lead_stop_reason(public.prospect_lead(p.lead_id, p.candidate_id, p.workspace_id)) as reason
      from public.email_messages x
      join public.email_prospects p on p.id = x.prospect_id
     where x.campaign_id = c.id and x.status in ('draft', 'approved', 'rejected')
       and public.lead_blocks_email(public.prospect_lead(p.lead_id, p.candidate_id, p.workspace_id))
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
     and not public.lead_blocks_email(public.prospect_lead(p.lead_id, p.candidate_id, p.workspace_id))   -- C2 (0022)
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
