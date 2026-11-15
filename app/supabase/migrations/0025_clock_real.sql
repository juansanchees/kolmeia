-- 0025 (F4 Task 11, decision D4): the clock may send REAL mail, only behind both locks.
--   Lock 1 (database, per workspace) = clock_real_ready(ws): the C12 gate (public.c12_ready, 0018: the owner's 7-item
--     checklist) AND the owner's own switch workspace_settings.clock_real_enabled (default false; set_clock_real, owner
--     only, turning it on needs the gate open) AND the emergency stop off (workspace_settings.sending_paused, 0024).
--     The owner's switch lives in the database so that the clock token alone (a leak) can never claim real work.
--   Lock 2 (server): env SCHEDULER_REAL_SEND = "1" (absent by default) AND the mailbox key configured. The route reads it
--     once (realClockEnabled) and passes p_real = true to scheduler_due_work / scheduler_claim_next_email only then;
--     with p_real false (the default, and every caller of 0005) the clock stays what 0005 made it: rehearsal only.
--   A real-mode campaign is claimed by the clock only when p_real AND clock_real_ready; everything else is claimed with
--   p_only_mode = 'dry_run' as before (a real campaign answers 'not_active', nothing touched).
--   The claim itself is claim_next_email_core of 0024 (not re-created): campaign FOR SHARE, the stop lock and check,
--   C2 lead gate, mailbox health, ramp, E2/E3 rules. The clock still never claims answers to replies (p_only_mode not null).
--
-- scheduler_mailbox_secret(p_run, p_message): the ONLY scheduler function that reads public.mailboxes' ciphertext. It
--   returns { id, workspace_id, email, ciphertext } of the mailbox stamped on ONE message that this run holds
--   ('sending', claim_holder = p_run), in real mode, from a mailbox 'ok' with health 'ok' whose address is the message's
--   From, in a workspace whose gate is open and whose stop is off. Anything else: 42501. The ciphertext is useless
--   without the server-only MAILBOX_ENC_KEY (decrypted in memory by the engine, never logged) and its AES-GCM additional
--   data binds it to this workspace and address.
-- scheduler_sending_paused(p_run, p_workspace): read again by the engine right before SMTP; true when the stop is on OR
--   the workspace's real lock closed in between (gate revoked, owner switch off). Only for a workspace with a message
--   this run holds (else true: fail closed).
-- scheduler_mailbox_failed(p_run, p_message, p_code): after a real send of this run failed because the mailbox itself
--   is broken (auth_failed / mailbox_secret / key_missing), marks that mailbox 'error' so the next claims skip it
--   (no Gmail AUTH retried every tick, no queue burnt). A person re-tests it ("Testar caixa").
--
-- Re-created from their LATEST bodies (scheduler_due_work and scheduler_message: 0007; the rest: 0005), same grants:
-- due_work and the claim gain p_real boolean default false (the old signatures are dropped so a call with the old
-- arguments still resolves, to the new default); campaign / message / prospect / sender / finish accept a real message
-- the run holds (campaign, message, prospect and sender only while the gate is open). Depends on 0001-0024. Re-runnable.

-- ---------------------------------------------------------------- the owner's switch (lock 1, part 2)
alter table public.workspace_settings add column if not exists clock_real_enabled boolean not null default false;
alter table public.workspace_settings add column if not exists clock_real_set_at timestamptz;
alter table public.workspace_settings add column if not exists clock_real_set_by uuid references auth.users (id) on delete set null;
-- (select on workspace_settings is granted on the whole table in 0002; insert/update stay limited to the AI-cap
-- columns, so the switch moves only through set_clock_real)

-- May the clock send real mail for this workspace now? Internal (plain, no grant).
create or replace function public.clock_real_ready(p_ws uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.c12_ready(p_ws)
     and coalesce((select s.clock_real_enabled and not s.sending_paused from public.workspace_settings s where s.workspace_id = p_ws), false);
$$;
revoke all on function public.clock_real_ready(uuid) from public, anon, authenticated;

-- The owner lets the clock send real mail for this workspace (on needs the C12 gate open), or stops it.
create or replace function public.set_clock_real(p_ws uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_ws is null or p_on is null or not public.is_workspace_owner(p_ws) then
    raise exception 'D4: only an owner can switch the clock''s real sending' using errcode = '42501';
  end if;
  if p_on and not public.c12_ready(p_ws) then
    raise exception 'C12: the owner''s checklist is not complete; real sending is blocked' using errcode = '23514';
  end if;
  insert into public.workspace_settings (workspace_id, clock_real_enabled, clock_real_set_at, clock_real_set_by)
  values (p_ws, p_on, now(), auth.uid())
  on conflict (workspace_id) do update
     set clock_real_enabled = excluded.clock_real_enabled, clock_real_set_at = excluded.clock_real_set_at,
         clock_real_set_by = excluded.clock_real_set_by;
end;
$$;
revoke all on function public.set_clock_real(uuid, boolean) from public, anon;
grant execute on function public.set_clock_real(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------- the work list
drop function if exists public.scheduler_due_work(uuid);
create or replace function public.scheduler_due_work(p_run uuid, p_real boolean default false)
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
  -- 0025: a real campaign is listed only when the server switch is on (p_real) and clock_real_ready (gate, owner, stop).
  select coalesce(jsonb_agg(t.id order by t.tried nulls first, t.first_due, t.id), '[]'::jsonb) into v_ids
    from (
      select c.id, c.scheduler_tried_at as tried, min(x.due_at) as first_due
        from public.email_campaigns c
        join public.email_messages x on x.campaign_id = c.id
       where c.status = 'active'
         and (c.send_mode = 'dry_run'
              or (p_real is true and c.send_mode = 'real' and public.clock_real_ready(c.workspace_id)))
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

-- ---------------------------------------------------------------- the claim
-- Same claim as a person's click, as no person (claimed_by stays null; the holder is the run). p_only_mode = the
-- campaign's mode only when the switch is on and the gate is open for a real campaign; otherwise 'dry_run' (0005).
drop function if exists public.scheduler_claim_next_email(uuid, uuid);
create or replace function public.scheduler_claim_next_email(p_run uuid, p_campaign uuid, p_real boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mode text;
  v_ws uuid;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not public.scheduler_holds_lease(p_run) then
    raise exception 'lease not held' using errcode = '55000';
  end if;
  perform public.scheduler_renew_lease(p_run);
  select c.send_mode, c.workspace_id into v_mode, v_ws from public.email_campaigns c where c.id = p_campaign;
  if p_real is true and v_mode = 'real' then
    -- C12 gate and the owner's switch; the core re-reads the mode under FOR SHARE (a switch back to rehearsal in
    -- between answers not_active) and checks the stop under its lock
    if not public.clock_real_ready(v_ws) then
      return jsonb_build_object('outcome', 'not_active');
    end if;
    return public.claim_next_email_core(p_campaign, p_run, null, null, 'real');
  end if;
  return public.claim_next_email_core(p_campaign, p_run, null, null, 'dry_run');
end;
$$;

-- ---------------------------------------------------------------- finishing (0005 body; real accepted for a message this run holds)
-- Never gated: a real e-mail that left must be recorded as sent even if the gate closed during SMTP.
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
  if m.status is distinct from 'sending' or m.claim_holder is distinct from p_run or m.send_mode not in ('dry_run', 'real') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- the core checks that the result matches the mode (a rehearsal never ends as 'sent')
  perform public.finish_email_send_core(p_message, p_run, p_result, p_error);
end;
$$;

-- ---------------------------------------------------------------- read-only helpers (0005/0007 bodies + real while the gate is open)
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
     where c.id = p_campaign
       and (c.send_mode = 'dry_run' or (c.send_mode = 'real' and public.c12_ready(c.workspace_id)))
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
                              'in_reply_to', x.in_reply_to, 'mailbox_id', x.mailbox_id)
      from public.email_messages x
     where x.id = p_message and x.status = 'sending' and x.claim_holder = p_run
       and (x.send_mode = 'dry_run' or (x.send_mode = 'real' and public.c12_ready(x.workspace_id)))
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
                    where x.prospect_id = p.id and x.status = 'sending' and x.claim_holder = p_run
                      and (x.send_mode = 'dry_run' or (x.send_mode = 'real' and public.c12_ready(x.workspace_id))))
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
                    where x.workspace_id = sp.workspace_id and x.status = 'sending' and x.claim_holder = p_run
                      and (x.send_mode = 'dry_run' or (x.send_mode = 'real' and public.c12_ready(x.workspace_id))))
  );
end;
$$;

-- ---------------------------------------------------------------- the stop switch, read again right before SMTP
create or replace function public.scheduler_sending_paused(p_run uuid, p_workspace uuid)
returns boolean
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
  -- only a workspace with a message this run holds; anything else answers "stopped"
  if not exists (select 1 from public.email_messages x
                  where x.workspace_id = p_workspace and x.status = 'sending' and x.claim_holder = p_run) then
    return true;
  end if;
  return coalesce((select s.sending_paused from public.workspace_settings s where s.workspace_id = p_workspace), false)
      or (exists (select 1 from public.email_messages x
                   where x.workspace_id = p_workspace and x.status = 'sending' and x.claim_holder = p_run and x.send_mode = 'real')
          and not public.clock_real_ready(p_workspace));
end;
$$;

-- ---------------------------------------------------------------- the one mailbox secret the clock may read
create or replace function public.scheduler_mailbox_secret(p_run uuid, p_message uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not public.scheduler_holds_lease(p_run) then
    raise exception 'lease not held' using errcode = '55000';
  end if;
  select b.id, b.workspace_id, b.email, b.secret_ciphertext into r
    from public.email_messages x
    join public.mailboxes b on b.id = x.mailbox_id and b.workspace_id = x.workspace_id
   where x.id = p_message
     and x.status = 'sending' and x.claim_holder = p_run and x.send_mode = 'real'
     and lower(b.email) = lower(x.from_address)
     and b.status = 'ok' and b.health_status = 'ok'
     and public.clock_real_ready(x.workspace_id);
  if r.id is null or r.secret_ciphertext is null then
    -- same code as a refused token, its own message: the store tells "this mailbox, not now" from "token refused"
    raise exception 'mailbox not available' using errcode = '42501';
  end if;
  return jsonb_build_object('id', r.id, 'workspace_id', r.workspace_id, 'email', r.email, 'ciphertext', r.secret_ciphertext);
end;
$$;

-- ---------------------------------------------------------------- a broken mailbox stops being used by the clock
create or replace function public.scheduler_mailbox_failed(p_run uuid, p_message uuid, p_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mb uuid;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not public.scheduler_holds_lease(p_run) then
    raise exception 'lease not held' using errcode = '55000';
  end if;
  if p_code is null or p_code not in ('auth_failed', 'mailbox_secret', 'key_missing') then
    raise exception 'invalid code' using errcode = '22023';
  end if;
  -- a real message of this run, still being sent or just failed by it (the engine records the failure first)
  select x.mailbox_id into v_mb
    from public.email_messages x
   where x.id = p_message and x.claim_holder = p_run and x.send_mode = 'real' and x.status in ('sending', 'failed')
     and x.mailbox_id is not null;
  if v_mb is null then
    raise exception 'mailbox not available' using errcode = '42501';
  end if;
  update public.mailboxes b
     set status = 'error', verified_at = null, last_error = p_code
   where b.id = v_mb;
end;
$$;

-- ---------------------------------------------------------------- grants: only anon (the public key), each refuses without the token
revoke all on function public.scheduler_due_work(uuid, boolean) from public, anon, authenticated;
revoke all on function public.scheduler_claim_next_email(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.scheduler_finish_email_send(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.scheduler_campaign(uuid, uuid) from public, anon, authenticated;
revoke all on function public.scheduler_message(uuid, uuid) from public, anon, authenticated;
revoke all on function public.scheduler_prospect(uuid, uuid) from public, anon, authenticated;
revoke all on function public.scheduler_sender(uuid, uuid) from public, anon, authenticated;
revoke all on function public.scheduler_sending_paused(uuid, uuid) from public, anon, authenticated;
revoke all on function public.scheduler_mailbox_secret(uuid, uuid) from public, anon, authenticated;
revoke all on function public.scheduler_mailbox_failed(uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.scheduler_due_work(uuid, boolean) to anon;
grant execute on function public.scheduler_claim_next_email(uuid, uuid, boolean) to anon;
grant execute on function public.scheduler_finish_email_send(uuid, uuid, text, text) to anon;
grant execute on function public.scheduler_campaign(uuid, uuid) to anon;
grant execute on function public.scheduler_message(uuid, uuid) to anon;
grant execute on function public.scheduler_prospect(uuid, uuid) to anon;
grant execute on function public.scheduler_sender(uuid, uuid) to anon;
grant execute on function public.scheduler_sending_paused(uuid, uuid) to anon;
grant execute on function public.scheduler_mailbox_secret(uuid, uuid) to anon;
grant execute on function public.scheduler_mailbox_failed(uuid, uuid, text) to anon;
