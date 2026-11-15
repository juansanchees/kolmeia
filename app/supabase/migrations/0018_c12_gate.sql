-- 0018 C12: real sending needs the owner's checklist (spec 2026-11-14-kolmeia-3-areas-design.md, decision C12 and §8).
-- Seven items per workspace: mailboxes, separate sending domain, SPF, DKIM, DMARC, warm-up, physical address (CAN-SPAM).
-- Each item is a person's approval: an owner of the workspace writes a short evidence note (e.g. "MXToolbox SPF pass 15/11")
-- and approves it. Nothing here looks up DNS or claims anything was verified automatically.
-- Every workspace starts NOT ready, so rehearsal (dry_run) stays the only mode until the owner completes the list.
-- Enforced twice: set_campaign_send_mode refuses 'real', and claim_next_email (the only claim a person reaches; the
-- scheduler claim is pinned to dry_run in 0005) refuses a real claim. sendTestToSelf (claim_test_email) is untouched:
-- it only sends to the user's own mailbox.

-- ---------------------------------------------------------------- the checklist
create table if not exists public.c12_approvals (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  item text not null,
  evidence text not null,
  approved_by uuid not null references auth.users (id) on delete cascade,
  approved_at timestamptz not null default now(),
  primary key (workspace_id, item),
  constraint c12_approvals_item check (item in ('mailboxes', 'sending_domain_separate', 'spf', 'dkim', 'dmarc', 'warmup', 'physical_address')),
  constraint c12_approvals_evidence check (char_length(btrim(evidence)) between 3 and 300 and evidence !~ '[\r\n]')
);

revoke all on table public.c12_approvals from public, anon, authenticated;
grant select on table public.c12_approvals to authenticated;

alter table public.c12_approvals enable row level security;
alter table public.c12_approvals force row level security;

-- owners and sdrs read the list (the campaign page shows it); closers and other workspaces do not. No write policy:
-- the only way in is approve_c12_item below.
drop policy if exists c12_approvals_select on public.c12_approvals;
create policy c12_approvals_select on public.c12_approvals
  for select to authenticated using (public.is_workspace_sender(workspace_id));

-- All 7 items approved. Internal (no grant): called from the security definer functions below.
create or replace function public.c12_ready(p_ws uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select count(*) = 7 from public.c12_approvals a
   where a.workspace_id = p_ws
     and a.item in ('mailboxes', 'sending_domain_separate', 'spf', 'dkim', 'dmarc', 'warmup', 'physical_address');
$$;
revoke all on function public.c12_ready(uuid) from public, anon, authenticated;

-- An owner approves one item with a note. Re-approving replaces the note, the person and the time.
create or replace function public.approve_c12_item(p_workspace uuid, p_item text, p_evidence text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_workspace is null or not public.is_workspace_owner(p_workspace) then
    raise exception 'C12: only an owner can approve the checklist' using errcode = '42501';
  end if;
  if p_item is null or p_item not in ('mailboxes', 'sending_domain_separate', 'spf', 'dkim', 'dmarc', 'warmup', 'physical_address') then
    raise exception 'C12: invalid item' using errcode = '22023';
  end if;
  if p_evidence is null or char_length(btrim(p_evidence)) not between 3 and 300 or p_evidence ~ '[\r\n]' then
    raise exception 'C12: an evidence note (3 to 300 characters, one line) is required' using errcode = '22023';
  end if;
  insert into public.c12_approvals (workspace_id, item, evidence, approved_by, approved_at)
  values (p_workspace, p_item, btrim(p_evidence), auth.uid(), now())
  on conflict (workspace_id, item) do update
     set evidence = excluded.evidence, approved_by = excluded.approved_by, approved_at = excluded.approved_at;
end;
$$;
revoke all on function public.approve_c12_item(uuid, text, text) from public, anon;
grant execute on function public.approve_c12_item(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------- the switch to real (copy of 0007_rotation.sql:436, plus the C12 check)
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
  if not public.c12_ready(c.workspace_id) then
    raise exception 'C12: the owner''s checklist (mailboxes, domain, SPF/DKIM/DMARC, warm-up, address) is not complete' using errcode = '23514';
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
revoke all on function public.set_campaign_send_mode(uuid, text) from public, anon;
grant execute on function public.set_campaign_send_mode(uuid, text) to authenticated;

-- ---------------------------------------------------------------- the person's claim (copy of 0005_scheduler.sql:254, plus the C12 check)
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
  -- C12 (defence in depth): a campaign already in real mode does not claim while the checklist is incomplete
  if exists (select 1 from public.email_campaigns c where c.id = p_campaign and c.send_mode = 'real')
     and not public.c12_ready(v_ws) then
    raise exception 'C12: the owner''s checklist is not complete; real sending is blocked' using errcode = '23514';
  end if;
  return public.claim_next_email_core(p_campaign, p_holder, p_message, auth.uid(), null);
end;
$$;
revoke all on function public.claim_next_email(uuid, uuid, uuid) from public, anon;
grant execute on function public.claim_next_email(uuid, uuid, uuid) to authenticated;
