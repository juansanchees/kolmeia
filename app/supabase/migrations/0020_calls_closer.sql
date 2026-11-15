-- 0020 Calls and closer (F5).
-- Part A (Task 1): the closer joins by an invite link, owner/sdr hand any lead to her, won/lost by hand.
--   T-A1 workspace_invites: one row per invite (closer only), bound to an e-mail, 7 days, one use, revocable. The
--        token is 64 hex characters returned once by create_workspace_invite; only its sha256 is stored, and no
--        client can select token_hash (column grant). The app sends no e-mail: the owner sends the link himself.
--   T-A2 create / revoke (owner only), invite_preview (any signed-in user holding the token), accept (same e-mail,
--        before expiry, not revoked, not used, and only for a user without a workspace: no workspace picker, C11).
--        Accept errors are P0001 with the message 'expired', 'wrong_email' or 'has_workspace'.
--   T-A3 list_workspace_people: owner/sdr see every member with a label (the accepted invite's name, else the role).
--   T-A4 release_member_leads: removing a member puts her leads back to unassigned (owner_id null, status unchanged).
--   T-A5 lead columns (handed_off_at/by, closer_brief, do_not_call, do_not_call_at) and hand_off_lead: owner/sdr hand
--        a lead to a closer of the same workspace with a checked brief; status with_closer (meeting is kept).
--        Assignment has one source of truth: leads.owner_id (0009/0017 policies unchanged).
--   T-A6 set_lead_status: won/lost by a sender, or by the assigned closer while she is a member; never from discarded.
-- Depends on 0001-0019. Re-runnable.

-- ---------------------------------------------------------------- role helper
-- True when p_user is a closer member of ws. Internal (definer RPCs only): clients cannot probe other users' roles.
create or replace function public.is_workspace_closer(ws uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
     where m.workspace_id = ws and m.user_id = p_user and m.role = 'closer'
  );
$$;

-- ---------------------------------------------------------------- T-A1 invites
create table if not exists public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null
    constraint workspace_invites_name_len check (char_length(btrim(name)) between 1 and 80),
  email text not null
    constraint workspace_invites_email check (public.is_email_address(email)),
  role public.workspace_role not null default 'closer'
    constraint workspace_invites_role check (role = 'closer'),
  token_hash text not null
    constraint workspace_invites_token_hash_key unique
    constraint workspace_invites_token_hash_hex check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_by uuid references auth.users (id) on delete set null,
  accepted_at timestamptz,
  revoked_at timestamptz
);

create index if not exists workspace_invites_ws_idx on public.workspace_invites (workspace_id, created_at desc);

revoke all on table public.workspace_invites from public, anon, authenticated;
grant select (id, workspace_id, name, email, role, expires_at, created_by, created_at, accepted_by, accepted_at, revoked_at)
  on table public.workspace_invites to authenticated;

alter table public.workspace_invites enable row level security;
alter table public.workspace_invites force row level security;

drop policy if exists workspace_invites_select on public.workspace_invites;
create policy workspace_invites_select on public.workspace_invites
  for select to authenticated using (public.is_workspace_owner(workspace_id));

-- ---------------------------------------------------------------- T-A2 create / revoke / preview / accept
create or replace function public.create_workspace_invite(p_ws uuid, p_name text, p_email text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_token text;
begin
  if auth.uid() is null or p_ws is null or not public.is_workspace_owner(p_ws) then
    raise exception 'only the owner invites' using errcode = '42501';
  end if;
  if char_length(v_name) not between 1 and 80 or not public.is_email_address(v_email) then
    raise exception 'invalid name or e-mail' using errcode = '22023';
  end if;
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.workspace_invites (workspace_id, name, email, role, token_hash, expires_at, created_by)
  values (p_ws, v_name, v_email, 'closer', encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), now() + interval '7 days', auth.uid());
  return v_token;
end;
$$;

create or replace function public.revoke_workspace_invite(p_invite uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  select i.workspace_id into v_ws from public.workspace_invites i where i.id = p_invite;
  if v_ws is null or not public.is_workspace_owner(v_ws) then
    raise exception 'only the owner revokes' using errcode = '42501';
  end if;
  update public.workspace_invites
     set revoked_at = now()
   where id = p_invite and accepted_at is null and revoked_at is null;
end;
$$;

-- Unknown token: no row. Only the workspace name, the invite e-mail and whether it can still be accepted.
create or replace function public.invite_preview(p_token text)
returns table (workspace_name text, email text, valid boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  return query
    select w.name, i.email, (i.accepted_at is null and i.revoked_at is null and i.expires_at > now())
      from public.workspace_invites i
      join public.workspaces w on w.id = i.workspace_id
     where i.token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
end;
$$;

create or replace function public.accept_workspace_invite(p_token text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_inv public.workspace_invites%rowtype;
  v_email text;
begin
  if v_uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  select * into v_inv
    from public.workspace_invites i
   where i.token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
   for update;
  if v_inv.id is null or v_inv.accepted_at is not null or v_inv.revoked_at is not null or v_inv.expires_at <= now() then
    raise exception 'expired';
  end if;
  -- Only a confirmed e-mail counts: a sign-up that has not confirmed (or a path that sets email unverified) cannot
  -- claim a leaked link.
  select lower(btrim(u.email)) into v_email from auth.users u where u.id = v_uid and u.email_confirmed_at is not null;
  if v_email is null or v_email <> v_inv.email then
    raise exception 'wrong_email';
  end if;
  -- Same lock as create_workspace (0004): two accepts (two invites, two workspaces) or an accept racing a
  -- create_workspace for this user run one after the other, so has_workspace sees the other's row.
  -- create_workspace itself still lets a member own up to 3 workspaces (0004 rule, unchanged; C11 gap, known).
  perform pg_advisory_xact_lock(hashtext('public.create_workspace'), hashtext(v_uid::text));
  if exists (select 1 from public.workspace_members m where m.user_id = v_uid) then
    raise exception 'has_workspace';
  end if;
  insert into public.workspace_members (workspace_id, user_id, role) values (v_inv.workspace_id, v_uid, v_inv.role);
  update public.workspace_invites set accepted_by = v_uid, accepted_at = now() where id = v_inv.id;
  return v_inv.workspace_id;
end;
$$;

-- ---------------------------------------------------------------- T-A3 people
create or replace function public.list_workspace_people(p_ws uuid)
returns table (user_id uuid, role public.workspace_role, label text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_ws is null or not public.is_workspace_sender(p_ws) then
    raise exception 'owner or sdr only' using errcode = '42501';
  end if;
  return query
    select m.user_id, m.role,
           coalesce((select i.name from public.workspace_invites i
                      where i.workspace_id = m.workspace_id and i.accepted_by = m.user_id
                      order by i.accepted_at desc limit 1), m.role::text)
      from public.workspace_members m
     where m.workspace_id = p_ws
     order by m.created_at, m.user_id;
end;
$$;

-- ---------------------------------------------------------------- T-A4 a removed member's leads go back to unassigned
-- Task 2 adds the call-agent pause to this same function.
create or replace function public.release_member_leads()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.leads
     set owner_id = null, updated_at = now()
   where workspace_id = old.workspace_id and owner_id = old.user_id;
  return null;
end;
$$;

drop trigger if exists release_member_leads on public.workspace_members;
create trigger release_member_leads
  after delete on public.workspace_members
  for each row execute function public.release_member_leads();

-- ---------------------------------------------------------------- T-A5 lead columns and hand-off
alter table public.leads
  add column if not exists handed_off_at timestamptz,
  add column if not exists handed_off_by uuid references auth.users (id) on delete set null,
  add column if not exists closer_brief jsonb,
  add column if not exists do_not_call boolean not null default false,
  add column if not exists do_not_call_at timestamptz;

-- Adding columns to leads invalidates cached plans. find_lead (0011) has OR conditions on nullable parameters, and a
-- generic plan cached for it scans every lead_fields row of the workspace per call (an import of 5,000 rows slowed
-- from seconds to minutes in tests). Plan it with the real values every time; nothing else about it changes.
alter function public.find_lead(uuid, text, text, text, uuid) set plan_cache_mode = force_custom_plan;

alter table public.leads drop constraint if exists leads_closer_brief;
alter table public.leads add constraint leads_closer_brief check (public.is_closer_brief(closer_brief));

create or replace function public.hand_off_lead(p_lead uuid, p_closer uuid, p_brief jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  v_status text;
begin
  select l.workspace_id, l.status into v_ws, v_status from public.leads l where l.id = p_lead for update;
  if v_ws is null or not public.is_workspace_sender(v_ws) then
    raise exception 'owner or sdr only' using errcode = '42501';
  end if;
  if p_closer is null or not public.is_workspace_closer(v_ws, p_closer) then
    raise exception 'not a closer of this workspace' using errcode = '22023';
  end if;
  if p_brief is null or not public.is_closer_brief(p_brief) then
    raise exception 'invalid brief' using errcode = '22023';
  end if;
  if v_status in ('won', 'lost', 'discarded') then
    raise exception 'lead is closed' using errcode = '55000';
  end if;
  update public.leads
     set owner_id = p_closer,
         status = case when status = 'meeting' then 'meeting' else 'with_closer' end,
         handed_off_at = now(),
         handed_off_by = auth.uid(),
         closer_brief = p_brief,
         updated_at = now()
   where id = p_lead;
end;
$$;

-- ---------------------------------------------------------------- T-A6 won / lost by hand
create or replace function public.set_lead_status(p_lead uuid, p_status text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  v_status text;
  v_owner uuid;
begin
  if p_status is null or p_status not in ('won', 'lost') then
    raise exception 'only won or lost' using errcode = '22023';
  end if;
  select l.workspace_id, l.status, l.owner_id into v_ws, v_status, v_owner from public.leads l where l.id = p_lead for update;
  if v_ws is null
     or not (public.is_workspace_sender(v_ws) or (v_owner = auth.uid() and public.is_workspace_member(v_ws))) then
    raise exception 'sender or the assigned closer only' using errcode = '42501';
  end if;
  if v_status = 'discarded' then
    raise exception 'lead is discarded' using errcode = '55000';
  end if;
  update public.leads set status = p_status, updated_at = now() where id = p_lead;
end;
$$;

-- ---------------------------------------------------------------- privileges (part A)
revoke all on function public.is_workspace_closer(uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_member_leads() from public, anon, authenticated;
revoke all on function public.create_workspace_invite(uuid, text, text) from public, anon;
revoke all on function public.revoke_workspace_invite(uuid) from public, anon;
revoke all on function public.invite_preview(text) from public, anon;
revoke all on function public.accept_workspace_invite(text) from public, anon;
revoke all on function public.list_workspace_people(uuid) from public, anon;
revoke all on function public.hand_off_lead(uuid, uuid, jsonb) from public, anon;
revoke all on function public.set_lead_status(uuid, text) from public, anon;
grant execute on function public.create_workspace_invite(uuid, text, text) to authenticated;
grant execute on function public.revoke_workspace_invite(uuid) to authenticated;
grant execute on function public.invite_preview(text) to authenticated;
grant execute on function public.accept_workspace_invite(text) to authenticated;
grant execute on function public.list_workspace_people(uuid) to authenticated;
grant execute on function public.hand_off_lead(uuid, uuid, jsonb) to authenticated;
grant execute on function public.set_lead_status(uuid, text) to authenticated;

-- -- part B
-- (Task 2 appends here: call_logs, call agent, daily list.)
-- Part B (Task 2): the call log, the call agent and the daily call list.
--   T-B1 call_logs: one row per call, written only by log_call. recorded is always false (no recording feature: MA
--        needs every party's consent, spec §9). No SMS anywhere. Read by owner/sdr, and by the assigned closer for
--        her leads (lead_visible_to_assignee). log_call: owner/sdr or the lead's closer; the phone comes from the lead
--        (lead_phone), never from the client; next_step_at within now-1 day .. now+180 days; the lead status follows
--        lead_status_after_call (pinned by tests/fixtures/call-status-vectors.ts, mirrored by statusAfterCall).
--   T-B2 do_not_call (C2): the lead is lost and flagged forever (no list, no manual add); its active e-mail prospects
--        stop (asked_to_stop) and their pending steps are cancelled. A last call can still be recorded.
--   T-B3 lead_callable: one SQL rule for "can this lead be on a call list today for this caller".
--   T-B4 guard_agent (0010 body, nothing removed): a call agent leaves draft only with a valid config
--        (call_agent_config_ok), then only Ligar/Pausar; Ligar re-checks the config (the caller is still a member).
--        The config is frozen after draft (A6). No agent_runs and no clock for call agents: lists are built on demand.
--   T-B5 call_list_items: the list of one call agent for one New York day (call_day). build_call_list adds up to
--        per_day leads (rows added by hand do not count), in order: callbacks due, temperature, level, age. Building
--        assigns the lead to the caller (owner_id, the one assignment source) and moves new to call_list.
--        add_to_call_list: owner/sdr add one callable lead to today's list by hand.
--   T-B6 release_member_leads (part A) also pauses the running call agents whose caller was removed.

-- ---------------------------------------------------------------- T-B1 helpers
create or replace function public.call_day()
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone 'America/New_York')::date;
$$;

-- won and discarded never change; meeting_booked -> meeting; not_interested and do_not_call -> lost; any other
-- outcome moves new to call_list. Same table as statusAfterCall (src/lib/calls/view.ts).
create or replace function public.lead_status_after_call(p_status text, p_outcome text)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select case
           when p_status in ('won', 'discarded') then p_status
           when p_outcome = 'meeting_booked' then 'meeting'
           when p_outcome in ('not_interested', 'do_not_call') then 'lost'
           when p_status = 'new' then 'call_list'
           else p_status
         end;
$$;

-- The number to call: the best candidate's phone when it is a real number, else the newest non-refuted phone field.
create or replace function public.lead_phone(p_lead uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select c.phone
       from public.leads l
       join public.research_candidates c on c.id = l.best_candidate_id
      where l.id = p_lead and public.company_phone_key(c.phone) is not null),
    (select f.value
       from public.lead_fields f
      where f.lead_id = p_lead and f.field = 'phone' and f.status <> 'refuted' and f.key is not null
      order by f.seen_at desc, f.created_at desc, f.id
      limit 1)
  );
$$;

-- In an active e-mail campaign: status in_campaign, or an active prospect of one of its candidates (F4 extends this).
create or replace function public.lead_in_active_campaign(p_lead uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.leads l where l.id = p_lead and l.status = 'in_campaign')
      or exists (
        select 1
          from public.email_prospects p
          join public.research_candidates c on c.id = p.candidate_id
         where c.lead_id = p_lead and p.status = 'active'
      );
$$;

-- ---------------------------------------------------------------- T-B1 call_logs
create table if not exists public.call_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid not null,
  agent_id uuid references public.agents (id) on delete set null,
  called_by uuid references auth.users (id) on delete set null,
  called_at timestamptz not null default now(),
  phone_used text not null
    constraint call_logs_phone_used_len check (char_length(phone_used) between 1 and 40),
  outcome text not null
    constraint call_logs_outcome check (outcome in ('no_answer', 'voicemail', 'gatekeeper', 'talked', 'meeting_booked',
                                                    'not_interested', 'wrong_number', 'do_not_call')),
  spoke_to text not null default ''
    constraint call_logs_spoke_to_len check (char_length(spoke_to) <= 120),
  notes text not null default ''
    constraint call_logs_notes_len check (char_length(notes) <= 500),
  next_step text not null default ''
    constraint call_logs_next_step_len check (char_length(next_step) <= 200),
  next_step_at timestamptz,
  recorded boolean not null default false
    constraint call_logs_never_recorded check (recorded = false),
  created_at timestamptz not null default now()
);
-- Plain FK on purpose (like 0014/0016): a composite FK on leads (id, workspace_id) would block re-running 0011, which
-- drops and re-adds that key. Only definer functions write here, and they take workspace_id from the lead itself.
alter table public.call_logs drop constraint if exists call_logs_lead_ws_fkey;
alter table public.call_logs drop constraint if exists call_logs_lead_fkey;
alter table public.call_logs
  add constraint call_logs_lead_fkey foreign key (lead_id) references public.leads (id) on delete cascade;
create index if not exists call_logs_lead_idx on public.call_logs (lead_id, called_at desc);

revoke all on table public.call_logs from public, anon, authenticated;
grant select on table public.call_logs to authenticated;
alter table public.call_logs enable row level security;
alter table public.call_logs force row level security;
drop policy if exists call_logs_select on public.call_logs;
create policy call_logs_select on public.call_logs
  for select to authenticated
  using (public.is_workspace_sender(workspace_id) or public.lead_visible_to_assignee(lead_id, workspace_id));

-- ---------------------------------------------------------------- T-B3 who can be called today
create or replace function public.lead_callable(p_lead uuid, p_caller uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lead public.leads%rowtype;
  v_key text;
  v_last public.call_logs%rowtype;
begin
  select * into v_lead from public.leads l where l.id = p_lead;
  if v_lead.id is null or v_lead.do_not_call or v_lead.status not in ('new', 'call_list')
     or (v_lead.owner_id is not null and v_lead.owner_id is distinct from p_caller) then
    return false;
  end if;
  v_key := public.company_phone_key(public.lead_phone(p_lead));
  if v_key is null or public.lead_in_active_campaign(p_lead) then
    return false;
  end if;
  select * into v_last from public.call_logs k where k.lead_id = p_lead order by k.called_at desc, k.created_at desc, k.id desc limit 1;
  if v_last.id is null then
    return true;
  end if;
  if exists (select 1 from public.call_logs k
              where k.lead_id = p_lead and (k.called_at at time zone 'America/New_York')::date = public.call_day()) then
    return false;
  end if;
  -- a wrong number comes back only with another phone (whatever was logged on it later); a callback only once due
  if exists (select 1 from public.call_logs k
              where k.lead_id = p_lead and k.outcome = 'wrong_number' and public.company_phone_key(k.phone_used) = v_key) then
    return false;
  end if;
  return v_last.next_step_at is null or v_last.next_step_at <= now();
end;
$$;

-- ---------------------------------------------------------------- T-B1/T-B2 log_call
create or replace function public.log_call(p_lead uuid, p_agent uuid, p_outcome text, p_spoke_to text, p_notes text,
                                           p_next_step text, p_next_step_at timestamptz)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_ws uuid;
  v_status text;
  v_owner uuid;
  v_phone text;
  v_new text;
  p record;
begin
  if v_uid is null or p_lead is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('call:' || p_lead::text, 0));
  select l.workspace_id, l.status, l.owner_id into v_ws, v_status, v_owner from public.leads l where l.id = p_lead for update;
  if v_ws is null
     or not (public.is_workspace_sender(v_ws) or (v_owner = v_uid and public.is_workspace_member(v_ws))) then
    raise exception 'sender or the assigned closer only' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('no_answer', 'voicemail', 'gatekeeper', 'talked', 'meeting_booked',
                                            'not_interested', 'wrong_number', 'do_not_call') then
    raise exception 'unknown outcome' using errcode = '22023';
  end if;
  -- the agent, when named: a call agent of this workspace, not archived, whose caller is the user (any one for a sender)
  if p_agent is not null and not exists (
       select 1 from public.agents a
        where a.id = p_agent and a.workspace_id = v_ws and a.type = 'call' and a.archived_at is null
          and (public.is_workspace_sender(v_ws) or public.call_agent_caller(a.id) = v_uid)) then
    raise exception 'not a call agent of this caller' using errcode = '22023';
  end if;
  if p_next_step_at is not null and (p_next_step_at < now() - interval '1 day' or p_next_step_at > now() + interval '180 days') then
    raise exception 'next step date out of range' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_spoke_to, ''))) > 120 or char_length(btrim(coalesce(p_notes, ''))) > 500
     or char_length(btrim(coalesce(p_next_step, ''))) > 200 then
    raise exception 'text too long' using errcode = '22023';
  end if;
  v_phone := public.lead_phone(p_lead);
  -- "do not call" is always recordable: with no phone left, the number of the newest call
  if v_phone is null and p_outcome = 'do_not_call' then
    select k.phone_used into v_phone from public.call_logs k
     where k.lead_id = p_lead order by k.called_at desc, k.created_at desc, k.id desc limit 1;
  end if;
  if v_phone is null then
    raise exception 'no phone' using errcode = '55000';
  end if;

  insert into public.call_logs (workspace_id, lead_id, agent_id, called_by, phone_used, outcome, spoke_to, notes, next_step, next_step_at)
  values (v_ws, p_lead, p_agent, v_uid, v_phone, p_outcome, btrim(coalesce(p_spoke_to, '')), btrim(coalesce(p_notes, '')),
          btrim(coalesce(p_next_step, '')), p_next_step_at);

  v_new := public.lead_status_after_call(v_status, p_outcome);
  if p_outcome = 'do_not_call' then
    update public.leads
       set status = v_new, do_not_call = true, do_not_call_at = coalesce(do_not_call_at, now()), updated_at = now()
     where id = p_lead;
    -- lock order: messages (by id) before prospects, as the claim core and the 0022 trigger do (no deadlock)
    perform 1
      from public.email_messages m
     where m.prospect_id in (
             select x.id from public.email_prospects x
               join public.research_candidates c on c.id = x.candidate_id
              where c.lead_id = p_lead and x.workspace_id = v_ws and x.status = 'active')
     order by m.id
       for update;
    for p in
      select x.id
        from public.email_prospects x
        join public.research_candidates c on c.id = x.candidate_id
       where c.lead_id = p_lead and x.workspace_id = v_ws and x.status = 'active'
       for update of x
    loop
      update public.email_prospects set status = 'stopped', stop_reason = 'asked_to_stop' where id = p.id;
      perform public.cancel_pending_steps(p.id, 'do_not_call');
    end loop;
  elsif v_new is distinct from v_status then
    update public.leads set status = v_new, updated_at = now() where id = p_lead;
  end if;
  return v_new;
end;
$$;

-- ---------------------------------------------------------------- T-B4 call agent config and guard_agent
-- Keys exact: caller_id (a member of the workspace, any role), per_day 1..50, min_level 0..4, temperatures (distinct,
-- from very_hot/hot/warm/cold; [] = any). Callable by clients because guard_agent runs as the client, but it answers
-- only for owner/sdr of p_ws, so nobody probes another workspace's members with it.
create or replace function public.call_agent_config_ok(p_config jsonb, p_ws uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller text;
begin
  if p_ws is null or not public.is_workspace_sender(p_ws) then
    return false;
  end if;
  if p_config is null or jsonb_typeof(p_config) <> 'object'
     or (select array_agg(k order by k) from jsonb_object_keys(p_config) k) is distinct from array['caller_id', 'min_level', 'per_day', 'temperatures'] then
    return false;
  end if;
  v_caller := p_config ->> 'caller_id';
  if jsonb_typeof(p_config -> 'caller_id') <> 'string'
     or v_caller !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     or not exists (select 1 from public.workspace_members m where m.workspace_id = p_ws and m.user_id = v_caller::uuid) then
    return false;
  end if;
  if jsonb_typeof(p_config -> 'per_day') <> 'number' or (p_config ->> 'per_day') !~ '^[0-9]{1,2}$'
     or (p_config ->> 'per_day')::integer not between 1 and 50 then
    return false;
  end if;
  if jsonb_typeof(p_config -> 'min_level') <> 'number' or (p_config ->> 'min_level') !~ '^[0-4]$' then
    return false;
  end if;
  if jsonb_typeof(p_config -> 'temperatures') <> 'array'
     or exists (select 1 from jsonb_array_elements(p_config -> 'temperatures') e
                 where jsonb_typeof(e) <> 'string' or e #>> '{}' not in ('very_hot', 'hot', 'warm', 'cold'))
     or (select count(*) from jsonb_array_elements_text(p_config -> 'temperatures'))
        <> (select count(distinct e) from jsonb_array_elements_text(p_config -> 'temperatures') e) then
    return false;
  end if;
  return true;
end;
$$;

-- 0010's guard_agent with the call agent rules added (nothing removed). Not security definer: is_client_role() reads
-- current_user.
create or replace function public.guard_agent()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_running integer;
begin
  if tg_op = 'INSERT' then
    new.status := 'draft';
    new.created_by := auth.uid();
    new.created_at := now();
    new.updated_at := now();
    new.archived_at := null;
    new.next_run_at := null;
    new.paused_reason := null;
    return new;
  end if;

  if old.archived_at is not null then
    raise exception 'A4: an archived agent cannot change' using errcode = '23514';
  end if;
  if new.archived_at is distinct from old.archived_at then
    if old.status = 'running' then
      raise exception 'A8: pause the agent before archiving it' using errcode = '23514';
    end if;
    new.archived_at := now();
  end if;

  if public.is_client_role() then
    if new.status is distinct from old.status then
      if not (
        (old.type <> 'call' and old.status = 'draft' and new.status = 'paused'
          and exists (
            select 1 from public.research_runs r
             where r.setup_agent_id = new.id and r.status = 'plan' and r.plan is not null
          ))
        or (old.type = 'call' and old.status = 'draft' and new.status = 'paused'
          and public.call_agent_config_ok(new.config, new.workspace_id))
        or (old.type = 'hunter' and old.status = 'paused' and new.status = 'running')
        or (old.type = 'call' and old.status = 'paused' and new.status = 'running'
          and public.call_agent_config_ok(new.config, new.workspace_id))
        or (old.type in ('hunter', 'call') and old.status = 'running' and new.status = 'paused')
      ) then
        raise exception 'A3: an agent leaves draft only when its setup research has a plan (a call agent: a valid config); then only Ligar and Pausar' using errcode = '23514';
      end if;
    end if;
    if old.status <> 'draft' and (
      new.config is distinct from old.config or new.schedule is distinct from old.schedule
    ) then
      raise exception 'A6: config and schedule are frozen once the agent left draft' using errcode = '23514';
    end if;
  end if;

  if new.status = 'running' and old.status is distinct from 'running' then
    if new.type = 'hunter' then
      perform pg_advisory_xact_lock(hashtextextended('hunter:' || new.workspace_id::text, 0));
      select count(*) into v_running
        from public.agents a
       where a.workspace_id = new.workspace_id and a.type = 'hunter' and a.status = 'running'
         and a.archived_at is null and a.id <> new.id;
      if v_running >= 3 then
        raise exception 'A7: at most 3 hunters can be running in a workspace' using errcode = '23514';
      end if;
    end if;
    if old.status = 'paused' then
      new.next_run_at := coalesce(old.next_run_at, now());
      new.paused_reason := null;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------- T-B5 call_list_items
create table if not exists public.call_list_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  lead_id uuid not null,
  caller_id uuid not null references auth.users (id) on delete cascade,
  list_date date not null,
  position integer not null
    constraint call_list_items_position check (position >= 1),
  -- added by owner/sdr with add_to_call_list: not counted against per_day
  manual boolean not null default false,
  created_at timestamptz not null default now(),
  constraint call_list_items_unique unique (agent_id, lead_id, list_date)
);
-- Plain FK on purpose (like 0014/0016): a composite FK on leads (id, workspace_id) would block re-running 0011, which
-- drops and re-adds that key. Only definer functions write here, and they take workspace_id from the lead itself.
alter table public.call_list_items drop constraint if exists call_list_items_lead_ws_fkey;
alter table public.call_list_items drop constraint if exists call_list_items_lead_fkey;
alter table public.call_list_items
  add constraint call_list_items_lead_fkey foreign key (lead_id) references public.leads (id) on delete cascade;
create index if not exists call_list_items_day_idx on public.call_list_items (workspace_id, list_date, lead_id);
create index if not exists call_list_items_caller_idx on public.call_list_items (caller_id, list_date);

revoke all on table public.call_list_items from public, anon, authenticated;
grant select on table public.call_list_items to authenticated;
alter table public.call_list_items enable row level security;
alter table public.call_list_items force row level security;
drop policy if exists call_list_items_select on public.call_list_items;
create policy call_list_items_select on public.call_list_items
  for select to authenticated
  using (public.is_workspace_sender(workspace_id) or (caller_id = auth.uid() and public.is_workspace_member(workspace_id)));

-- The caller of a call agent, when its config names a current member of the agent's workspace.
create or replace function public.call_agent_caller(p_agent uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id
    from public.agents a
    join public.workspace_members m
      on m.workspace_id = a.workspace_id
     and m.user_id::text = lower(a.config ->> 'caller_id')
   where a.id = p_agent and a.type = 'call';
$$;

create or replace function public.build_call_list(p_agent uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_a public.agents%rowtype;
  v_caller uuid;
  v_day date := public.call_day();
  v_room integer;
  v_pos integer;
  v_min integer;
  v_temps text[];
  v_n integer := 0;
  r record;
begin
  select * into v_a from public.agents a where a.id = p_agent;
  v_caller := public.call_agent_caller(p_agent);
  if v_uid is null or v_a.id is null
     or not (public.is_workspace_sender(v_a.workspace_id)
             or (v_a.type = 'call' and v_caller = v_uid and public.is_workspace_member(v_a.workspace_id))) then
    raise exception 'the caller or owner/sdr only' using errcode = '42501';
  end if;
  if v_a.type <> 'call' or v_a.status <> 'running' or v_a.archived_at is not null or v_caller is null then
    raise exception 'not a running call agent' using errcode = '55000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('call_list:' || v_a.workspace_id::text, 0));

  select greatest((v_a.config ->> 'per_day')::integer - count(*) filter (where not i.manual), 0)::integer,
         coalesce(max(i.position), 0)
    into v_room, v_pos
    from public.call_list_items i
   where i.agent_id = p_agent and i.list_date = v_day;
  v_min := (v_a.config ->> 'min_level')::integer;
  v_temps := array(select jsonb_array_elements_text(v_a.config -> 'temperatures'));

  for r in
    select l.id
      from public.leads l
      left join public.research_candidates c on c.id = l.best_candidate_id
      left join lateral (
        select k.next_step_at from public.call_logs k
         where k.lead_id = l.id
         order by k.called_at desc, k.created_at desc, k.id desc
         limit 1
      ) n on true
     where l.workspace_id = v_a.workspace_id
       and l.level >= v_min
       and (cardinality(v_temps) = 0 or c.temperature = any (v_temps))
       and not exists (select 1 from public.call_list_items i where i.lead_id = l.id and i.list_date = v_day)
       and public.lead_callable(l.id, v_caller)
     order by case when n.next_step_at is not null and n.next_step_at <= now() then 0 else 1 end,
              case c.temperature when 'very_hot' then 0 when 'hot' then 1 when 'warm' then 2 when 'cold' then 3 else 4 end,
              l.level desc, l.first_seen_at, l.id
     limit v_room
  loop
    -- assign first, and only if nobody took the lead meanwhile (hand_off_lead / set_lead_status do not take this lock)
    update public.leads
       set owner_id = coalesce(owner_id, v_caller),
           status = case when status = 'new' then 'call_list' else status end,
           updated_at = now()
     where id = r.id and (owner_id is null or owner_id = v_caller) and status in ('new', 'call_list') and not do_not_call;
    if not found then
      continue;
    end if;
    v_pos := v_pos + 1;
    insert into public.call_list_items (workspace_id, agent_id, lead_id, caller_id, list_date, position)
    values (v_a.workspace_id, p_agent, r.id, v_caller, v_day, v_pos);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Today's lists of every running call agent the signed-in user is the caller of.
create or replace function public.build_my_call_lists()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_n integer := 0;
  a record;
begin
  if v_uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  for a in
    select g.id
      from public.agents g
     where g.type = 'call' and g.status = 'running' and g.archived_at is null
       and public.call_agent_caller(g.id) = v_uid
     order by g.created_at, g.id
  loop
    v_n := v_n + public.build_call_list(a.id);
  end loop;
  return v_n;
end;
$$;

create or replace function public.add_to_call_list(p_lead uuid, p_agent uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_a public.agents%rowtype;
  v_caller uuid;
  v_day date := public.call_day();
  v_pos integer;
begin
  select * into v_a from public.agents a where a.id = p_agent;
  if v_a.id is null or not public.is_workspace_sender(v_a.workspace_id) then
    raise exception 'owner or sdr only' using errcode = '42501';
  end if;
  v_caller := public.call_agent_caller(p_agent);
  if v_a.type <> 'call' or v_a.archived_at is not null or v_caller is null then
    raise exception 'not a call agent' using errcode = '55000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('call_list:' || v_a.workspace_id::text, 0));
  if not exists (select 1 from public.leads l where l.id = p_lead and l.workspace_id = v_a.workspace_id)
     or not public.lead_callable(p_lead, v_caller)
     or exists (select 1 from public.call_list_items i where i.lead_id = p_lead and i.list_date = v_day) then
    raise exception 'lead cannot be called today' using errcode = '55000';
  end if;
  -- assign first, and only if nobody took the lead meanwhile
  update public.leads
     set owner_id = coalesce(owner_id, v_caller),
         status = case when status = 'new' then 'call_list' else status end,
         updated_at = now()
   where id = p_lead and (owner_id is null or owner_id = v_caller) and status in ('new', 'call_list') and not do_not_call;
  if not found then
    raise exception 'lead cannot be called today' using errcode = '55000';
  end if;
  select coalesce(max(i.position), 0) + 1 into v_pos
    from public.call_list_items i where i.agent_id = p_agent and i.list_date = v_day;
  insert into public.call_list_items (workspace_id, agent_id, lead_id, caller_id, list_date, position, manual)
  values (v_a.workspace_id, p_agent, p_lead, v_caller, v_day, v_pos, true);
end;
$$;

-- ---------------------------------------------------------------- T-B6 a removed caller's call agents pause
create or replace function public.release_member_leads()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.leads
     set owner_id = null, updated_at = now()
   where workspace_id = old.workspace_id and owner_id = old.user_id;
  update public.agents
     set status = 'paused'
   where workspace_id = old.workspace_id and type = 'call' and status = 'running'
     and lower(config ->> 'caller_id') = old.user_id::text;
  return null;
end;
$$;

-- ---------------------------------------------------------------- privileges (part B)
revoke all on function public.call_day() from public, anon, authenticated;
revoke all on function public.lead_status_after_call(text, text) from public, anon, authenticated;
revoke all on function public.lead_phone(uuid) from public, anon, authenticated;
revoke all on function public.lead_in_active_campaign(uuid) from public, anon, authenticated;
revoke all on function public.lead_callable(uuid, uuid) from public, anon, authenticated;
revoke all on function public.call_agent_caller(uuid) from public, anon, authenticated;
revoke all on function public.call_agent_config_ok(jsonb, uuid) from public, anon;
revoke all on function public.log_call(uuid, uuid, text, text, text, text, timestamptz) from public, anon;
revoke all on function public.build_call_list(uuid) from public, anon;
revoke all on function public.build_my_call_lists() from public, anon;
revoke all on function public.add_to_call_list(uuid, uuid) from public, anon;
grant execute on function public.call_agent_config_ok(jsonb, uuid) to authenticated;
grant execute on function public.log_call(uuid, uuid, text, text, text, text, timestamptz) to authenticated;
grant execute on function public.build_call_list(uuid) to authenticated;
grant execute on function public.build_my_call_lists() to authenticated;
grant execute on function public.add_to_call_list(uuid, uuid) to authenticated;
