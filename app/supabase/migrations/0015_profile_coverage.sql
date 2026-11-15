-- 0015 Perfil aprendido + Cobertura (F3c-3).
--   K-7  learned_profiles: a profile the AI proposed from a training list becomes real only when a sender approves it
--        (as is or edited). Approval gives the next version of the workspace and supersedes the previous approved
--        profile of the same target (one Caçador, or every Caçador when agent_id is null). Nothing else applies a profile.
--   K-7  a new Caçador run is stamped at insert with the newest approved profile for its agent (else the all-hunters one):
--        research_runs.profile_id + a hints snapshot. One-off and setup runs never get a profile; a run keeps its stamp.
--   K-11 qualifier_queue.profile_match (column born in 0014) follows the newest approved profile's filter
--        (company type + town, no AI). An empty filter matches nothing.
--   C-e  coverage_marks: towns the owner or sdr already searched outside the app.
-- Depends on 0001-0011, 0013 and 0014 (0012 is not required). Re-runnable.

-- ================================================================ K-7 learned_profiles
create table if not exists public.learned_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  import_id uuid references public.lead_imports (id) on delete set null,
  agent_id uuid references public.agents (id) on delete set null,
  version integer,
  status text not null default 'proposed' constraint learned_profiles_status check (status in ('proposed', 'approved', 'rejected', 'superseded')),
  profile jsonb not null constraint learned_profiles_profile check (jsonb_typeof(profile) = 'object' and octet_length(profile::text) <= 16000),
  original jsonb not null constraint learned_profiles_original check (jsonb_typeof(original) = 'object' and octet_length(original::text) <= 16000),
  sample_rows integer not null constraint learned_profiles_sample_rows check (sample_rows >= 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  constraint learned_profiles_ws_version_key unique (workspace_id, version)
);
create index if not exists learned_profiles_ws_status_idx on public.learned_profiles (workspace_id, status, version desc);

alter table public.research_runs
  add column if not exists profile_id uuid references public.learned_profiles (id) on delete set null,
  add column if not exists profile_hints jsonb;

-- The hints a run carries: one "<key>: <text>" line per point, plus the search queries.
create or replace function public.profile_hints_of(p_profile jsonb, p_version integer)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'version', p_version,
    'lines', coalesce((
      select jsonb_agg((x.pt ->> 'key') || ': ' || (x.pt ->> 'text') order by x.o)
        from jsonb_array_elements(case when jsonb_typeof(p_profile -> 'points') = 'array' then p_profile -> 'points' else '[]'::jsonb end)
             with ordinality as x (pt, o)
       where x.pt ->> 'key' is not null and x.pt ->> 'text' is not null
    ), '[]'::jsonb),
    'queries', case when jsonb_typeof(p_profile -> 'searchQueries') = 'array' then p_profile -> 'searchQueries' else '[]'::jsonb end
  );
$$;

-- A town or a city typed in a list, folded for comparison: case, spaces, a trailing ", MA".
create or replace function public.profile_town_key(p_town text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(btrim(regexp_replace(btrim(coalesce(p_town, '')), ',\s*(ma|massachusetts)\.?\s*$', '', 'i')));
$$;

-- K-11: does the lead fit the filter { companyTypes, towns }? Each non-empty list must match; both empty matches nothing.
create or replace function public.lead_matches_profile(p_lead uuid, p_filter jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_types text[];
  v_towns text[];
begin
  if p_filter is null or jsonb_typeof(p_filter) <> 'object' then
    return false;
  end if;
  v_types := array(
    select lower(btrim(t.v))
      from jsonb_array_elements_text(case when jsonb_typeof(p_filter -> 'companyTypes') = 'array' then p_filter -> 'companyTypes' else '[]'::jsonb end) as t (v)
     where btrim(t.v) <> '');
  v_towns := array(
    select public.profile_town_key(t.v)
      from jsonb_array_elements_text(case when jsonb_typeof(p_filter -> 'towns') = 'array' then p_filter -> 'towns' else '[]'::jsonb end) as t (v)
     where public.profile_town_key(t.v) <> '');
  if coalesce(cardinality(v_types), 0) = 0 and coalesce(cardinality(v_towns), 0) = 0 then
    return false;
  end if;
  if cardinality(v_types) > 0 and not exists (
    select 1 from public.lead_fields f
     where f.lead_id = p_lead and f.field = 'company_type' and f.status <> 'refuted' and lower(btrim(f.value)) = any (v_types)
    union all
    select 1 from public.research_candidates c
     where c.lead_id = p_lead and lower(btrim(c.company_type)) = any (v_types)
  ) then
    return false;
  end if;
  if cardinality(v_towns) > 0 and not exists (
    select 1 from public.lead_fields f
     where f.lead_id = p_lead and f.field = 'city' and f.status <> 'refuted' and public.profile_town_key(f.value) = any (v_towns)
    union all
    select 1 from public.research_candidates c
     where c.lead_id = p_lead and c.city is not null and public.profile_town_key(c.city) = any (v_towns)
  ) then
    return false;
  end if;
  return true;
end;
$$;

-- The filter of the newest approved profile of the workspace (any target); null when none.
create or replace function public.profile_filter_of(p_ws uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select p.profile -> 'filter'
    from public.learned_profiles p
   where p.workspace_id = p_ws and p.status = 'approved'
   order by p.version desc
   limit 1;
$$;

-- Recompute profile_match for every lead of the workspace (at approval).
create or replace function public.refresh_profile_match(p_ws uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_filter jsonb := public.profile_filter_of(p_ws);
begin
  update public.qualifier_queue q
     set profile_match = m.v
    from (
      select z.lead_id, (v_filter is not null and public.lead_matches_profile(z.lead_id, v_filter)) as v
        from public.qualifier_queue z
       where z.workspace_id = p_ws
    ) m
   where q.lead_id = m.lead_id and q.profile_match is distinct from m.v;
end;
$$;

-- Recompute one lead when a city or company type arrives.
create or replace function public.refresh_profile_match_lead()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_filter jsonb := public.profile_filter_of(new.workspace_id);
  v_match boolean;
begin
  v_match := v_filter is not null and public.lead_matches_profile(new.lead_id, v_filter);
  update public.qualifier_queue q set profile_match = v_match
   where q.lead_id = new.lead_id and q.profile_match is distinct from v_match;
  return null;
end;
$$;

drop trigger if exists refresh_profile_match_lead on public.lead_fields;
create trigger refresh_profile_match_lead
  after insert on public.lead_fields
  for each row
  when (new.field in ('city', 'company_type'))
  execute function public.refresh_profile_match_lead();

-- ---------------------------------------------------------------- RPCs (authenticated senders)
create or replace function public.propose_profile(p_import uuid, p_profile jsonb, p_sample_rows integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_imp public.lead_imports;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into v_imp from public.lead_imports i where i.id = p_import;
  if not found or not public.is_workspace_sender(v_imp.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not v_imp.use_as_training or v_imp.status <> 'done' then
    raise exception 'the list is not a finished training list' using errcode = '22023';
  end if;
  if p_profile is null or jsonb_typeof(p_profile) <> 'object' or p_sample_rows is null or p_sample_rows < 0 then
    raise exception 'invalid profile' using errcode = '22023';
  end if;
  insert into public.learned_profiles (workspace_id, import_id, profile, original, sample_rows, created_by)
  values (v_imp.workspace_id, v_imp.id, p_profile, p_profile, p_sample_rows, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.approve_profile(p_profile uuid, p_edited jsonb, p_agent uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.learned_profiles;
  v_version integer;
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into p from public.learned_profiles x where x.id = p_profile;
  if not found or not public.is_workspace_sender(p.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_edited is not null then
    if jsonb_typeof(p_edited) <> 'object' or exists (
      select 1 from jsonb_object_keys(p_edited) k where k not in ('points', 'filter', 'searchQueries')
    ) then
      raise exception 'invalid edit' using errcode = '22023';
    end if;
  end if;
  if p_agent is not null and not exists (
    select 1 from public.agents a where a.id = p_agent and a.workspace_id = p.workspace_id and a.type = 'hunter'
  ) then
    raise exception 'not a hunter of this workspace' using errcode = '22023';
  end if;
  -- one approval at a time per workspace: one version number each, the older one superseded
  perform pg_advisory_xact_lock(hashtextextended('learned_profiles:' || p.workspace_id::text, 0));
  select * into p from public.learned_profiles x where x.id = p_profile for update;
  if p.status <> 'proposed' then
    raise exception 'profile is %', p.status using errcode = '22023';
  end if;
  select coalesce(max(x.version), 0) + 1 into v_version from public.learned_profiles x where x.workspace_id = p.workspace_id;
  update public.learned_profiles x
     set status = 'superseded'
   where x.workspace_id = p.workspace_id and x.status = 'approved' and x.agent_id is not distinct from p_agent;
  update public.learned_profiles x
     set status = 'approved', version = v_version, agent_id = p_agent,
         profile = case when p_edited is null then x.profile else x.profile || p_edited end,
         approved_by = auth.uid(), approved_at = now()
   where x.id = p_profile;
  perform public.refresh_profile_match(p.workspace_id);
  return v_version;
end;
$$;

create or replace function public.reject_profile(p_profile uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.learned_profiles;
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into p from public.learned_profiles x where x.id = p_profile;
  if not found or not public.is_workspace_sender(p.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('learned_profiles:' || p.workspace_id::text, 0));
  update public.learned_profiles x set status = 'rejected' where x.id = p_profile and x.status = 'proposed';
  if not found then
    raise exception 'profile is not proposed' using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------- K-7 the run stamp
-- Fires after F3b's guard_research_run (alphabetical order: zz_). The guard never touches the two new columns.
create or replace function public.stamp_run_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.learned_profiles;
begin
  select * into p
    from public.learned_profiles x
   where x.workspace_id = new.workspace_id and x.status = 'approved' and (x.agent_id = new.agent_id or x.agent_id is null)
   order by (x.agent_id is not null) desc, x.version desc
   limit 1;
  if found then
    new.profile_id := p.id;
    new.profile_hints := public.profile_hints_of(p.profile, p.version);
  else
    new.profile_id := null;
    new.profile_hints := null;
  end if;
  return new;
end;
$$;

drop trigger if exists zz_stamp_run_profile on public.research_runs;
create trigger zz_stamp_run_profile
  before insert on public.research_runs
  for each row
  when (new.agent_id is not null)
  execute function public.stamp_run_profile();

-- hunter_get_run lists its columns one by one: same function as 0010 plus the stamp.
create or replace function public.hunter_get_run(p_tick uuid, p_run uuid)
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
  perform public.hunter_assert(p_tick, p_run, false);
  return (
    select jsonb_build_object(
             'id', r.id, 'workspace_id', r.workspace_id, 'title', r.title, 'request_text', r.request_text,
             'region_text', r.region_text, 'rigor', r.rigor, 'status', r.status, 'questions', r.questions,
             'answers', r.answers, 'adjustments', r.adjustments, 'plan', r.plan, 'max_candidates', r.max_candidates,
             'max_cost_usd', r.max_cost_usd, 'max_minutes', r.max_minutes, 'spent_cost_usd', r.spent_cost_usd,
             'progress', r.progress, 'is_partial', r.is_partial, 'partial_reason', r.partial_reason,
             'limits_notes', r.limits_notes, 'error', r.error, 'approved_at', r.approved_at, 'started_at', r.started_at,
             'finished_at', r.finished_at, 'created_at', r.created_at, 'setup_agent_id', r.setup_agent_id,
             'agent_id', r.agent_id, 'profile_id', r.profile_id, 'profile_hints', r.profile_hints)
      from public.research_runs r
     where r.id = p_run
  );
end;
$$;

-- ================================================================ C-e coverage_marks
create table if not exists public.coverage_marks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  town text not null constraint coverage_marks_town check (char_length(town) between 1 and 60),
  county text not null constraint coverage_marks_county check (char_length(county) between 1 and 20),
  note text not null default '' constraint coverage_marks_note check (char_length(note) <= 200),
  searched_at date not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.coverage_marks drop constraint if exists coverage_marks_searched_at;
alter table public.coverage_marks add constraint coverage_marks_searched_at check (searched_at <= current_date);
create index if not exists coverage_marks_ws_idx on public.coverage_marks (workspace_id, searched_at desc);

create or replace function public.stamp_coverage_mark()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists stamp_coverage_mark on public.coverage_marks;
create trigger stamp_coverage_mark
  before insert on public.coverage_marks
  for each row execute function public.stamp_coverage_mark();

-- ================================================================ privileges and RLS
revoke all on table public.learned_profiles from public, anon, authenticated;
grant select on table public.learned_profiles to authenticated;
revoke all on table public.coverage_marks from public, anon, authenticated;
grant select, delete on table public.coverage_marks to authenticated;
grant insert (workspace_id, town, county, note, searched_at) on table public.coverage_marks to authenticated;

alter table public.learned_profiles enable row level security;
alter table public.learned_profiles force row level security;
drop policy if exists learned_profiles_select on public.learned_profiles;
create policy learned_profiles_select on public.learned_profiles
  for select to authenticated
  using (public.is_workspace_sender(workspace_id));

alter table public.coverage_marks enable row level security;
alter table public.coverage_marks force row level security;
drop policy if exists coverage_marks_select on public.coverage_marks;
create policy coverage_marks_select on public.coverage_marks
  for select to authenticated
  using (public.is_workspace_sender(workspace_id));
drop policy if exists coverage_marks_insert on public.coverage_marks;
create policy coverage_marks_insert on public.coverage_marks
  for insert to authenticated
  with check (public.is_workspace_sender(workspace_id));
drop policy if exists coverage_marks_delete on public.coverage_marks;
create policy coverage_marks_delete on public.coverage_marks
  for delete to authenticated
  using (public.is_workspace_sender(workspace_id));

-- Internal functions: no client grant. The three RPCs are for signed-in senders only.
revoke all on function public.profile_hints_of(jsonb, integer) from public, anon, authenticated;
revoke all on function public.profile_town_key(text) from public, anon, authenticated;
revoke all on function public.lead_matches_profile(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.profile_filter_of(uuid) from public, anon, authenticated;
revoke all on function public.refresh_profile_match(uuid) from public, anon, authenticated;
revoke all on function public.refresh_profile_match_lead() from public, anon, authenticated;
revoke all on function public.stamp_run_profile() from public, anon, authenticated;
revoke all on function public.stamp_coverage_mark() from public, anon, authenticated;
revoke all on function public.propose_profile(uuid, jsonb, integer) from public, anon;
revoke all on function public.approve_profile(uuid, jsonb, uuid) from public, anon;
revoke all on function public.reject_profile(uuid) from public, anon;
grant execute on function public.propose_profile(uuid, jsonb, integer) to authenticated;
grant execute on function public.approve_profile(uuid, jsonb, uuid) to authenticated;
grant execute on function public.reject_profile(uuid) to authenticated;
