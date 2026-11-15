-- 0026 (F4 Task 12, E5): the clock reads replies, with rules only (no AI on the clock), behind the SAME locks as its
-- real sending (0025):
--   server: SCHEDULER_REAL_SEND = "1" AND the mailbox key configured (the route builds the IMAP reader only then and the
--     store asks for reply mailboxes only in real mode);
--   database: clock_real_ready(ws) (C12 gate AND the owner's switch AND the emergency stop off), and the mailbox itself
--     'ok' with health 'ok', attached to an ACTIVE REAL campaign, with real mail sent from it in the last 30 days.
-- scheduler_reply_mailboxes(p_run): at most 5 such mailboxes per tick, least recently read first; each is stamped with
--   this run (mailboxes.clock_replies_run). Only a mailbox listed in THIS run can then be used:
-- scheduler_imap_secret(p_run, p_mailbox): { id, workspace_id, email, ciphertext } of a listed mailbox while it is still
--   readable (same rules, re-checked); else 42501 'mailbox not available'. The second (and last) scheduler function that
--   reads a ciphertext; useless without the server-only MAILBOX_ENC_KEY.
-- scheduler_reply_sent_refs(p_run, p_mailbox, p_since): our sent messages from that mailbox (30 days at most), to match
--   replies (replies.ts matchIncoming). Never a body.
-- scheduler_record_reply(p_run, ...the 10 args of record_email_reply..., p_rule_class): records one matched message for
--   a listed mailbox through record_email_reply_core (a reply stops the prospect's sequence, a bounce suppresses and
--   counts toward E4's auto pause through the 0024 trigger). p_rule_class (rule-based, set by the server's own rules,
--   never by the AI): 'unsubscribe' (suppresses, like set_reply_class) or 'out_of_office' (label only), for replies only.
--   Recording is NOT re-gated after the listing: it only stops or suppresses (the safe direction).
-- scheduler_mailbox_failed gains p_mailbox (default null): when p_message is null, a reply mailbox listed in this run
--   whose login failed (auth_failed / mailbox_secret / key_missing) is marked 'error' so the clock stops logging in.
-- record_email_reply and set_reply_class are re-created (0003 bodies, the latest) as wrappers around new internal cores
--   (same signatures, same grants). The 0012 auto-reply migration is NOT part of this (D1).
-- Depends on 0001-0025. Re-runnable.

-- ---------------------------------------------------------------- which run listed a mailbox for replies
alter table public.mailboxes add column if not exists clock_replies_run uuid;
alter table public.mailboxes add column if not exists clock_replies_at timestamptz;

-- ---------------------------------------------------------------- record_email_reply: core + wrapper (0003 body)
-- Internal (plain, no grant): only definer callers (record_email_reply, scheduler_record_reply).
create or replace function public.record_email_reply_core(
  p_prospect uuid,
  p_mailbox uuid,
  p_message uuid,
  p_from text,
  p_subject text,
  p_body text,
  p_rfc_id text,
  p_received_at timestamptz,
  p_kind text,
  p_bounced text
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  p record;
  v_id uuid;
  v_bounced text;
begin
  select * into p from public.email_prospects where id = p_prospect;
  if p.id is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not public.mailbox_in_workspace(p_mailbox, p.workspace_id) then
    raise exception 'mailbox not in workspace' using errcode = '42501';
  end if;
  if p_kind not in ('reply', 'bounce', 'possible_bounce') then
    raise exception 'invalid kind' using errcode = '22023';
  end if;
  v_bounced := case when p_kind = 'reply' then null else public.bounced_address_for(p.id, p_bounced, p.email) end;
  insert into public.email_replies (workspace_id, mailbox_id, campaign_id, prospect_id, message_id, from_address, subject,
                                    body_text, received_at, rfc_message_id, is_bounce, possible_bounce, bounced_address)
  values (p.workspace_id, p_mailbox, p.campaign_id, p.id,
          (select x.id from public.email_messages x where x.id = p_message and x.prospect_id = p.id),
          left(lower(coalesce(p_from, '')), 254), left(coalesce(p_subject, ''), 300), left(coalesce(p_body, ''), 20000),
          coalesce(p_received_at, now()), left(p_rfc_id, 500), p_kind = 'bounce', p_kind = 'possible_bounce', v_bounced)
  on conflict (workspace_id, rfc_message_id) do nothing
  returning id into v_id;
  if v_id is null then
    return null;
  end if;
  if p_kind = 'bounce' then
    perform public.apply_bounce(p.workspace_id, p.id, v_bounced);
  elsif p_kind = 'reply' then
    update public.email_prospects set status = 'replied', stop_reason = 'replied', replied_at = coalesce(replied_at, now())
     where id = p.id and status in ('active', 'skipped', 'done');
    perform public.cancel_pending_steps(p.id, 'replied');
  end if;
  return v_id;
end;
$$;
revoke all on function public.record_email_reply_core(uuid, uuid, uuid, text, text, text, text, timestamptz, text, text) from public, anon, authenticated;

create or replace function public.record_email_reply(
  p_prospect uuid,
  p_mailbox uuid,
  p_message uuid,
  p_from text,
  p_subject text,
  p_body text,
  p_rfc_id text,
  p_received_at timestamptz,
  p_kind text,
  p_bounced text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  select p.workspace_id into v_ws from public.email_prospects p where p.id = p_prospect;
  if v_ws is null or not public.is_workspace_sender(v_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return public.record_email_reply_core(p_prospect, p_mailbox, p_message, p_from, p_subject, p_body, p_rfc_id, p_received_at, p_kind, p_bounced);
end;
$$;
revoke all on function public.record_email_reply(uuid, uuid, uuid, text, text, text, text, timestamptz, text, text) from public, anon;
grant execute on function public.record_email_reply(uuid, uuid, uuid, text, text, text, text, timestamptz, text, text) to authenticated;

-- ---------------------------------------------------------------- set_reply_class: core + wrapper (0003 body)
create or replace function public.set_reply_class_core(p_reply uuid, p_class text, p_source text, p_reason text, p_model text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_email text;
begin
  select * into r from public.email_replies where id = p_reply;
  if r.id is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_source not in ('ai', 'human') then
    raise exception 'invalid source' using errcode = '22023';
  end if;
  update public.email_replies
     set classification = p_class, class_source = p_source, class_reason = left(p_reason, 300), class_model = left(p_model, 60)
   where id = r.id;
  if p_class = 'unsubscribe' and r.prospect_id is not null then
    -- the prospect's address and the address that asked (when it is a real address of theirs)
    select p.email into v_email from public.email_prospects p where p.id = r.prospect_id;
    insert into public.suppressions (workspace_id, kind, value, reason, note)
    select r.workspace_id, 'address', a.v, 'asked_to_stop', 'pediu para parar na resposta'
      from (select distinct v from unnest(array[v_email, case when not r.is_bounce and not r.possible_bounce then r.from_address end]) as v) a
     where a.v is not null and public.is_email_address(a.v)
    on conflict (workspace_id, kind, value) do nothing;
    update public.email_prospects set status = 'stopped', stop_reason = 'asked_to_stop'
     where id = r.prospect_id and status in ('active', 'skipped', 'replied', 'done');
    perform public.cancel_pending_steps(r.prospect_id, 'asked_to_stop');
    update public.email_messages set status = 'cancelled', cancel_reason = 'asked_to_stop'
     where prospect_id = r.prospect_id and kind = 'reply' and status in ('draft', 'approved', 'rejected');
  end if;
end;
$$;
revoke all on function public.set_reply_class_core(uuid, text, text, text, text) from public, anon, authenticated;

create or replace function public.set_reply_class(p_reply uuid, p_class text, p_source text, p_reason text, p_model text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  select r.workspace_id into v_ws from public.email_replies r where r.id = p_reply;
  if v_ws is null or not public.is_workspace_sender(v_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform public.set_reply_class_core(p_reply, p_class, p_source, p_reason, p_model);
end;
$$;
revoke all on function public.set_reply_class(uuid, text, text, text, text) from public, anon;
grant execute on function public.set_reply_class(uuid, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------- may the clock read this mailbox now?
-- Internal (plain, no grant). The same locks as the clock's real sending, plus: the mailbox works ('ok', health 'ok'),
-- it is on an active real campaign, and it really sent mail in the last 30 days (else there is nothing to match).
create or replace function public.clock_reply_mailbox_ok(p_mailbox uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
      from public.mailboxes b
     where b.id = p_mailbox
       and b.status = 'ok' and b.health_status = 'ok'
       and public.clock_real_ready(b.workspace_id)
       and exists (select 1 from public.email_campaigns c
                    where c.workspace_id = b.workspace_id and c.status = 'active' and c.send_mode = 'real'
                      and (c.mailbox_id = b.id
                           or exists (select 1 from public.campaign_mailboxes cm where cm.campaign_id = c.id and cm.mailbox_id = b.id)))
       and exists (select 1 from public.email_messages x
                    where x.workspace_id = b.workspace_id and lower(x.from_address) = lower(b.email)
                      and x.status = 'sent' and x.send_mode = 'real' and x.sent_at > now() - interval '30 days')
  );
$$;
revoke all on function public.clock_reply_mailbox_ok(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- the mailboxes the clock reads in this run
create or replace function public.scheduler_reply_mailboxes(p_run uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not public.scheduler_holds_lease(p_run) then
    raise exception 'lease not held' using errcode = '55000';
  end if;
  perform public.scheduler_renew_lease(p_run);
  with picked as (
    select b.id
      from public.mailboxes b
     where public.clock_reply_mailbox_ok(b.id)
     order by b.clock_replies_at nulls first, b.id
     limit 5
  ), stamped as (
    update public.mailboxes b set clock_replies_run = p_run, clock_replies_at = now()
      from picked where b.id = picked.id
    returning b.id, b.workspace_id, b.email, b.clock_replies_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'workspace_id', s.workspace_id, 'email', s.email) order by s.id), '[]'::jsonb)
    into v from stamped s;
  return jsonb_build_object('mailboxes', v);
end;
$$;

-- ---------------------------------------------------------------- the secret of one listed mailbox
create or replace function public.scheduler_imap_secret(p_run uuid, p_mailbox uuid)
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
    from public.mailboxes b
   where b.id = p_mailbox and b.clock_replies_run = p_run and public.clock_reply_mailbox_ok(b.id);
  if r.id is null or r.secret_ciphertext is null then
    raise exception 'mailbox not available' using errcode = '42501';
  end if;
  return jsonb_build_object('id', r.id, 'workspace_id', r.workspace_id, 'email', r.email, 'ciphertext', r.secret_ciphertext);
end;
$$;

-- ---------------------------------------------------------------- what we sent from it (to match replies)
create or replace function public.scheduler_reply_sent_refs(p_run uuid, p_mailbox uuid, p_since timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b record;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not public.scheduler_holds_lease(p_run) then
    raise exception 'lease not held' using errcode = '55000';
  end if;
  select m.id, m.workspace_id, m.email into b
    from public.mailboxes m
   where m.id = p_mailbox and m.clock_replies_run = p_run and public.clock_reply_mailbox_ok(m.id);
  if b.id is null then
    raise exception 'mailbox not available' using errcode = '42501';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('message_id', t.id, 'prospect_id', t.prospect_id, 'rfc_message_id', t.rfc_message_id,
                                                 'to_address', t.to_address, 'sent_at', t.sent_at) order by t.sent_at), '[]'::jsonb)
      from (select x.id, x.prospect_id, x.rfc_message_id, x.to_address, x.sent_at
              from public.email_messages x
             where x.workspace_id = b.workspace_id and lower(x.from_address) = lower(b.email)
               and x.status = 'sent' and x.rfc_message_id is not null
               and x.sent_at >= greatest(coalesce(p_since, now()), now() - interval '30 days')
             order by x.sent_at desc
             limit 5000) t
  );
end;
$$;

-- ---------------------------------------------------------------- recording one matched message
create or replace function public.scheduler_record_reply(
  p_run uuid,
  p_prospect uuid,
  p_mailbox uuid,
  p_message uuid,
  p_from text,
  p_subject text,
  p_body text,
  p_rfc_id text,
  p_received_at timestamptz,
  p_kind text,
  p_bounced text,
  p_rule_class text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not public.scheduler_holds_lease(p_run) then
    raise exception 'lease not held' using errcode = '55000';
  end if;
  if not exists (select 1 from public.mailboxes b where b.id = p_mailbox and b.clock_replies_run = p_run) then
    raise exception 'mailbox not available' using errcode = '42501';
  end if;
  if p_rule_class is not null and (p_kind is distinct from 'reply' or p_rule_class not in ('unsubscribe', 'out_of_office')) then
    raise exception 'invalid rule class' using errcode = '22023';
  end if;
  -- the core checks the prospect and that the mailbox is in its workspace
  v_id := public.record_email_reply_core(p_prospect, p_mailbox, p_message, p_from, p_subject, p_body, p_rfc_id, p_received_at, p_kind, p_bounced);
  if v_id is not null and p_rule_class is not null then
    -- rule labels go through the same path as the screen's (source 'ai' = a suggestion a person can change, as the
    -- engine's header rule did before); 'unsubscribe' suppresses (the safe direction)
    perform public.set_reply_class_core(v_id, p_rule_class, 'ai',
      case p_rule_class when 'unsubscribe' then 'Pediu para sair (regra).' else 'Resposta automática (cabeçalho).' end, null);
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- a broken mailbox (0025 body + reply mailboxes)
drop function if exists public.scheduler_mailbox_failed(uuid, uuid, text);
create or replace function public.scheduler_mailbox_failed(p_run uuid, p_message uuid, p_code text, p_mailbox uuid default null)
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
  if p_message is not null then
    -- a real message of this run, still being sent or just failed by it (the engine records the failure first)
    select x.mailbox_id into v_mb
      from public.email_messages x
     where x.id = p_message and x.claim_holder = p_run and x.send_mode = 'real' and x.status in ('sending', 'failed')
       and x.mailbox_id is not null;
  else
    -- 0026: a mailbox this run listed for replies, whose login failed
    select b.id into v_mb from public.mailboxes b where b.id = p_mailbox and b.clock_replies_run = p_run;
  end if;
  if v_mb is null then
    raise exception 'mailbox not available' using errcode = '42501';
  end if;
  update public.mailboxes b
     set status = 'error', verified_at = null, last_error = p_code
   where b.id = v_mb;
end;
$$;

-- ---------------------------------------------------------------- grants: only anon (the public key), each refuses without the token
revoke all on function public.scheduler_reply_mailboxes(uuid) from public, anon, authenticated;
revoke all on function public.scheduler_imap_secret(uuid, uuid) from public, anon, authenticated;
revoke all on function public.scheduler_reply_sent_refs(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.scheduler_record_reply(uuid, uuid, uuid, uuid, text, text, text, text, timestamptz, text, text, text) from public, anon, authenticated;
revoke all on function public.scheduler_mailbox_failed(uuid, uuid, text, uuid) from public, anon, authenticated;

grant execute on function public.scheduler_reply_mailboxes(uuid) to anon;
grant execute on function public.scheduler_imap_secret(uuid, uuid) to anon;
grant execute on function public.scheduler_reply_sent_refs(uuid, uuid, timestamptz) to anon;
grant execute on function public.scheduler_record_reply(uuid, uuid, uuid, uuid, text, text, text, text, timestamptz, text, text, text) to anon;
grant execute on function public.scheduler_mailbox_failed(uuid, uuid, text, uuid) to anon;
