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
