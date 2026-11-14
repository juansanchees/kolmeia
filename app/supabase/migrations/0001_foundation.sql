-- F0 foundation: workspaces, members, company profile. Multi-tenant from day one (rule R8).
-- Run as the table-owning role (on Supabase: `postgres`, which has BYPASSRLS). Re-runnable.
--
-- Design notes
--  * Every policy targets `authenticated` only. `anon` gets no grant and no policy.
--  * Membership checks go through SECURITY DEFINER helpers (empty search_path, schema-qualified names), so
--    policies on workspace_members can ask "am I a member?" without recursing into their own policy.
--  * The app creates a workspace through the RPC create_workspace(name): one atomic call that inserts the
--    workspace; the trigger then makes the caller its owner. A plain INSERT ... RETURNING cannot work for a
--    normal user, because the select policy only shows rows of workspaces you already belong to, and the
--    owner row is created by an AFTER trigger, after the RETURNING visibility check.
--  * No service-role key is needed anywhere (rule R14).

-- ---------------------------------------------------------------- types
do $$
begin
  create type public.workspace_role as enum ('owner', 'sdr', 'closer');
exception
  when duplicate_object then null;
end
$$;

-- ---------------------------------------------------------------- tables
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null
    constraint workspaces_name_len check (char_length(btrim(name)) between 1 and 80),
  -- on delete set null: a user can be removed from Supabase Auth; the workspace stays (see guard_last_owner).
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.workspace_role not null default 'sdr',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index if not exists workspace_members_user_idx on public.workspace_members (user_id);

create table if not exists public.company_profiles (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  what_we_do text not null default ''
    constraint company_profiles_what_we_do_len check (char_length(what_we_do) <= 2000),
  service_area text not null default ''
    constraint company_profiles_service_area_len check (char_length(service_area) <= 2000),
  wanted_work text[] not null default '{}'
    constraint company_profiles_wanted_work_values check (
      wanted_work <@ array['new_construction', 'multifamily', 'commercial', 'single_family', 'maintenance']::text[]
    ),
  good_customer text not null default ''
    constraint company_profiles_good_customer_len check (char_length(good_customer) <= 2000),
  not_wanted text not null default ''
    constraint company_profiles_not_wanted_len check (char_length(not_wanted) <= 2000),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- helpers (security definer, no recursion)
create or replace function public.is_workspace_member(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = ws
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_workspace_owner(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = ws
      and m.user_id = auth.uid()
      and m.role = 'owner'
  );
$$;

-- A workspace must never be left without an owner (nobody could manage or delete it).
-- Fires after a role change or a member delete. SECURITY DEFINER on purpose: under FORCE ROW LEVEL SECURITY a
-- plain function would count owners through the CALLER's select policy (only rows of workspaces they belong to,
-- and none at all for a user deleted by the Auth admin), which could miscount. As the table owner (BYPASSRLS on
-- Supabase) it sees every member row. It is not callable by clients (execute revoked, trigger only).
-- Deleting the workspace itself is allowed: the cascade removes member rows after the parent row is gone.
-- Consequence: deleting the Auth account of a workspace's sole owner is blocked too. Transfer ownership
-- (promote another member) or delete the workspace first.
create or replace function public.guard_last_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner')
     and exists (select 1 from public.workspaces w where w.id = old.workspace_id)
     and not exists (
       select 1 from public.workspace_members m
       where m.workspace_id = old.workspace_id and m.role = 'owner'
     )
  then
    raise exception 'last owner: a workspace must keep at least one owner' using errcode = '23514';
  end if;
  return null;
end;
$$;

-- Creator becomes owner. Runs as the table owner, so it is not blocked by the members policies.
create or replace function public.handle_new_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict (workspace_id, user_id) do nothing;
  return new;
end;
$$;

-- App entry point for "create my workspace". Validates input; the caller is always the creator.
create or replace function public.create_workspace(p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    raise exception 'invalid workspace name' using errcode = '22023';
  end if;
  insert into public.workspaces (name, created_by)
  values (v_name, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

-- Keeps updated_at / updated_by honest regardless of what the client sends.
create or replace function public.touch_company_profile()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;

drop trigger if exists on_workspace_created on public.workspaces;
create trigger on_workspace_created
  after insert on public.workspaces
  for each row execute function public.handle_new_workspace();

drop trigger if exists guard_last_owner_update on public.workspace_members;
create trigger guard_last_owner_update
  after update of role on public.workspace_members
  for each row execute function public.guard_last_owner();

drop trigger if exists guard_last_owner_delete on public.workspace_members;
create trigger guard_last_owner_delete
  after delete on public.workspace_members
  for each row execute function public.guard_last_owner();

drop trigger if exists touch_company_profile on public.company_profiles;
create trigger touch_company_profile
  before insert or update on public.company_profiles
  for each row execute function public.touch_company_profile();

-- ---------------------------------------------------------------- privileges
revoke all on function public.is_workspace_member(uuid) from public, anon;
revoke all on function public.is_workspace_owner(uuid) from public, anon;
revoke all on function public.handle_new_workspace() from public, anon, authenticated;
revoke all on function public.create_workspace(text) from public, anon;
revoke all on function public.touch_company_profile() from public, anon;
revoke all on function public.guard_last_owner() from public, anon, authenticated;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.is_workspace_owner(uuid) to authenticated;
grant execute on function public.create_workspace(text) to authenticated;

-- Supabase default privileges grant everything to the API roles, so revoke first, then grant the minimum.
-- Column-level grants make id / created_by / user_id / workspace_id / created_at / updated_* immutable for clients.
revoke all on table public.workspaces from public, anon, authenticated;
revoke all on table public.workspace_members from public, anon, authenticated;
revoke all on table public.company_profiles from public, anon, authenticated;

-- workspaces: created only through create_workspace(); a client can only rename or delete (owner, via policy).
grant select, delete on table public.workspaces to authenticated;
grant update (name) on table public.workspaces to authenticated;

-- workspace_members: NO client insert in this phase. Rows come from the creation trigger only.
-- Later, invites arrive as an invite-and-accept RPC (security definer) where the invitee is auth.uid().
grant select, delete on table public.workspace_members to authenticated;
grant update (role) on table public.workspace_members to authenticated;

-- company_profiles: only the content columns; updated_by / updated_at belong to the trigger.
grant select, delete on table public.company_profiles to authenticated;
grant insert (workspace_id, what_we_do, service_area, wanted_work, good_customer, not_wanted)
  on table public.company_profiles to authenticated;
grant update (what_we_do, service_area, wanted_work, good_customer, not_wanted)
  on table public.company_profiles to authenticated;

-- ---------------------------------------------------------------- row level security
alter table public.workspaces enable row level security;
alter table public.workspaces force row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_members force row level security;
alter table public.company_profiles enable row level security;
alter table public.company_profiles force row level security;

-- workspaces
drop policy if exists workspaces_select on public.workspaces;
create policy workspaces_select on public.workspaces
  for select to authenticated
  using (public.is_workspace_member(id));

-- No insert policy and no insert grant on workspaces: creation goes through create_workspace().
drop policy if exists workspaces_insert on public.workspaces;

drop policy if exists workspaces_update on public.workspaces;
create policy workspaces_update on public.workspaces
  for update to authenticated
  using (public.is_workspace_owner(id))
  with check (public.is_workspace_owner(id));

drop policy if exists workspaces_delete on public.workspaces;
create policy workspaces_delete on public.workspaces
  for delete to authenticated
  using (public.is_workspace_owner(id));

-- workspace_members
drop policy if exists workspace_members_select on public.workspace_members;
create policy workspace_members_select on public.workspace_members
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- No insert policy and no insert grant on workspace_members (see grants above).
drop policy if exists workspace_members_insert on public.workspace_members;

drop policy if exists workspace_members_update on public.workspace_members;
create policy workspace_members_update on public.workspace_members
  for update to authenticated
  using (public.is_workspace_owner(workspace_id))
  with check (public.is_workspace_owner(workspace_id));

drop policy if exists workspace_members_delete on public.workspace_members;
create policy workspace_members_delete on public.workspace_members
  for delete to authenticated
  using (public.is_workspace_owner(workspace_id));

-- company_profiles
drop policy if exists company_profiles_select on public.company_profiles;
create policy company_profiles_select on public.company_profiles
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists company_profiles_insert on public.company_profiles;
create policy company_profiles_insert on public.company_profiles
  for insert to authenticated
  with check (public.is_workspace_member(workspace_id));

drop policy if exists company_profiles_update on public.company_profiles;
create policy company_profiles_update on public.company_profiles
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists company_profiles_delete on public.company_profiles;
create policy company_profiles_delete on public.company_profiles
  for delete to authenticated
  using (public.is_workspace_owner(workspace_id));
