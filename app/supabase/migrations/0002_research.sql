-- F1-F3 research ("Pesquisa"): settings, AI call ledger, runs, sources, candidates, checks, evidence, lists.
-- Same standard as 0001: RLS enabled and forced, policies only for `authenticated`, column-level grants,
-- SECURITY DEFINER helpers with an empty search_path, no service-role key anywhere (rule R14).
--
-- Who writes what (there is no background worker and no admin key in this phase):
--  * Every row is written by the logged-in user's session (the research engine runs inside that user's request).
--    RLS keeps each workspace's rows inside the workspace (R8). Columns the engine must never change after the
--    fact (ids, workspace_id, run_id, created_*, spent cost, step lease, approval stamp) are not granted to clients;
--    triggers and RPCs own them.
--  * Rules enforced here as a second line of defence (the engine enforces them first, in code):
--      P1  a check with result 'ok' must have at least one evidence row (deferred constraint trigger);
--      P9  in 'strict' rigor an 'ok' needs evidence from two different hosts (same trigger);
--      P3  only candidates the user kept ('keep') can enter a list (trigger);
--      P4  a run can only start running after the plan was approved (status-transition trigger);
--      R11 no LinkedIn URL can be stored (check constraints through public.is_safe_url).
--  * ai_calls is insert-only for clients; its cost feeds research_runs.spent_cost_usd through a trigger.

-- ---------------------------------------------------------------- url helpers (immutable, used in constraints)
create or replace function public.is_safe_url(u text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select u is null or (
    char_length(u) <= 2000
    and u ~* '^https?://[^\s/?#]+'
    and u !~ '\s'
    and u !~* '^https?://([^/?#]*[.@])?(linkedin\.com|lnkd\.in)([/:?#]|$)'
  );
$$;

create or replace function public.url_host(u text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(lower(substring(u from '^[a-zA-Z]+://(?:[^/?#@]*@)?([^/?#:]+)')), '^www\.', '');
$$;

-- ---------------------------------------------------------------- tables
create table if not exists public.workspace_settings (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  ai_daily_cap_usd numeric(10, 2) not null default 10
    constraint workspace_settings_cap_range check (ai_daily_cap_usd >= 0 and ai_daily_cap_usd <= 100),
  default_rigor text not null default 'careful'
    constraint workspace_settings_rigor check (default_rigor in ('quick', 'careful', 'strict')),
  updated_at timestamptz not null default now()
);

create table if not exists public.research_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null
    constraint research_runs_title_len check (char_length(btrim(title)) between 1 and 120),
  request_text text not null
    constraint research_runs_request_len check (char_length(btrim(request_text)) between 1 and 2000),
  region_text text not null default ''
    constraint research_runs_region_len check (char_length(region_text) <= 1000),
  rigor text not null default 'careful'
    constraint research_runs_rigor check (rigor in ('quick', 'careful', 'strict')),
  status text not null default 'questions'
    constraint research_runs_status check (
      status in ('questions', 'plan', 'ready', 'running', 'paused', 'done', 'failed', 'cancelled')
    ),
  questions jsonb,
  answers jsonb not null default '{}'::jsonb,
  adjustments jsonb not null default '[]'::jsonb,
  plan jsonb,
  max_candidates integer not null default 20
    constraint research_runs_max_candidates check (max_candidates between 1 and 60),
  max_cost_usd numeric(8, 2) not null default 2
    constraint research_runs_max_cost check (max_cost_usd > 0 and max_cost_usd <= 10),
  max_minutes integer not null default 40
    constraint research_runs_max_minutes check (max_minutes between 5 and 180),
  spent_cost_usd numeric(12, 6) not null default 0,
  progress jsonb not null default '{}'::jsonb,
  is_partial boolean not null default false,
  partial_reason text
    constraint research_runs_partial_reason_len check (char_length(partial_reason) <= 300),
  limits_notes jsonb not null default '[]'::jsonb,
  error text
    constraint research_runs_error_len check (char_length(error) <= 300),
  locked_until timestamptz,
  locked_by uuid,
  approved_at timestamptz,
  approved_by uuid references auth.users (id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists research_runs_workspace_idx on public.research_runs (workspace_id, created_at desc);

create table if not exists public.ai_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  run_id uuid references public.research_runs (id) on delete set null,
  task text not null
    constraint ai_calls_task check (
      task in ('research_questions', 'research_plan', 'research_discover', 'research_collect', 'research_verify',
               'research_second_pass', 'classify')
    ),
  model text not null constraint ai_calls_model_len check (char_length(model) <= 60),
  prompt_version text not null constraint ai_calls_prompt_version_len check (char_length(prompt_version) <= 40),
  input_tokens integer not null default 0 constraint ai_calls_input_tokens check (input_tokens >= 0),
  output_tokens integer not null default 0 constraint ai_calls_output_tokens check (output_tokens >= 0),
  cache_read_tokens integer not null default 0 constraint ai_calls_cache_read check (cache_read_tokens >= 0),
  cache_write_tokens integer not null default 0 constraint ai_calls_cache_write check (cache_write_tokens >= 0),
  web_searches integer not null default 0 constraint ai_calls_web_searches check (web_searches >= 0),
  web_fetches integer not null default 0 constraint ai_calls_web_fetches check (web_fetches >= 0),
  cost_usd numeric(12, 6) not null default 0 constraint ai_calls_cost check (cost_usd >= 0),
  status text not null
    constraint ai_calls_status check (status in ('ok', 'refused', 'invalid_output', 'truncated', 'error')),
  error text constraint ai_calls_error_len check (char_length(error) <= 300),
  duration_ms integer not null default 0 constraint ai_calls_duration check (duration_ms >= 0),
  created_at timestamptz not null default now()
);

create index if not exists ai_calls_workspace_day_idx on public.ai_calls (workspace_id, created_at);
create index if not exists ai_calls_run_idx on public.ai_calls (run_id);

create table if not exists public.research_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  run_id uuid not null references public.research_runs (id) on delete cascade,
  kind text not null
    constraint research_sources_kind check (
      kind in ('permits', 'business_registry', 'license_lookup', 'association', 'awards', 'news', 'bids',
               'maps_reviews', 'company_site', 'other')
    ),
  title text not null constraint research_sources_title_len check (char_length(title) between 1 and 200),
  url text constraint research_sources_url check (public.is_safe_url(url)),
  status text not null
    constraint research_sources_status check (status in ('used', 'empty', 'blocked', 'error')),
  note text not null default '' constraint research_sources_note_len check (char_length(note) <= 500),
  created_at timestamptz not null default now()
);

create index if not exists research_sources_run_idx on public.research_sources (run_id);

create table if not exists public.research_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  run_id uuid not null references public.research_runs (id) on delete cascade,
  name text not null constraint research_candidates_name_len check (char_length(btrim(name)) between 1 and 200),
  name_key text not null constraint research_candidates_name_key_len check (char_length(name_key) between 1 and 200),
  city text constraint research_candidates_city_len check (char_length(city) <= 100),
  state text constraint research_candidates_state_len check (char_length(state) <= 40),
  region text constraint research_candidates_region_len check (char_length(region) <= 100),
  website text constraint research_candidates_website check (public.is_safe_url(website)),
  phone text constraint research_candidates_phone_len check (char_length(phone) <= 40),
  public_email text constraint research_candidates_email check (
    public_email is null or (char_length(public_email) <= 254 and public_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')
  ),
  email_type text constraint research_candidates_email_type check (email_type in ('named', 'generic', 'personal', 'none')),
  company_type text not null default 'other'
    constraint research_candidates_company_type check (company_type in ('builder', 'developer', 'property_manager', 'other')),
  size_note text constraint research_candidates_size_note_len check (char_length(size_note) <= 300),
  temperature text constraint research_candidates_temperature check (temperature in ('very_hot', 'hot', 'warm', 'cold')),
  approach text constraint research_candidates_approach check (approach in ('call', 'supplier_signup', 'email')),
  ask_for_name text constraint research_candidates_ask_for_name_len check (char_length(ask_for_name) <= 120),
  ask_for_title text constraint research_candidates_ask_for_title_len check (char_length(ask_for_title) <= 120),
  name_confidence text constraint research_candidates_name_confidence check (name_confidence in ('high', 'medium', 'low')),
  name_source_url text constraint research_candidates_name_source_url check (public.is_safe_url(name_source_url)),
  name_note text constraint research_candidates_name_note_len check (char_length(name_note) <= 500),
  permit_count integer constraint research_candidates_permit_count check (permit_count >= 0),
  total_value_usd numeric(14, 2) constraint research_candidates_total_value check (total_value_usd >= 0),
  last_permit_date date,
  biggest_job_address text constraint research_candidates_job_address_len check (char_length(biggest_job_address) <= 200),
  biggest_job_value_usd numeric(14, 2) constraint research_candidates_job_value check (biggest_job_value_usd >= 0),
  biggest_job_type text constraint research_candidates_job_type_len check (char_length(biggest_job_type) <= 100),
  biggest_job_description text constraint research_candidates_job_desc_len check (char_length(biggest_job_description) <= 500),
  signal_match text constraint research_candidates_signal_match_len check (char_length(signal_match) <= 300),
  google_rating numeric(2, 1) constraint research_candidates_rating check (google_rating between 0 and 5),
  review_count integer constraint research_candidates_review_count check (review_count >= 0),
  hook text constraint research_candidates_hook_len check (char_length(hook) <= 400),
  supplier_portal_url text constraint research_candidates_portal check (public.is_safe_url(supplier_portal_url)),
  notes text constraint research_candidates_notes_len check (char_length(notes) <= 1000),
  user_decision text not null default 'pending'
    constraint research_candidates_decision check (user_decision in ('pending', 'keep', 'drop')),
  second_pass text constraint research_candidates_second_pass check (second_pass in ('stands', 'refuted', 'unsure')),
  is_partial boolean not null default false,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  constraint research_candidates_unique_name unique (run_id, name_key)
);

create index if not exists research_candidates_run_idx on public.research_candidates (run_id);

create table if not exists public.research_checks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  run_id uuid not null references public.research_runs (id) on delete cascade,
  candidate_id uuid not null references public.research_candidates (id) on delete cascade,
  kind text not null
    constraint research_checks_kind check (kind in ('exists_active', 'has_work', 'fits_profile', 'decision_maker')),
  pass smallint not null constraint research_checks_pass check (pass in (1, 2)),
  result text not null constraint research_checks_result check (result in ('ok', 'no', 'unknown')),
  summary text not null default '' constraint research_checks_summary_len check (char_length(summary) <= 500),
  created_at timestamptz not null default now()
);

create index if not exists research_checks_candidate_idx on public.research_checks (candidate_id);

create table if not exists public.research_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  check_id uuid not null references public.research_checks (id) on delete cascade,
  url text not null constraint research_evidence_url check (public.is_safe_url(url)),
  title text not null default '' constraint research_evidence_title_len check (char_length(title) <= 200),
  excerpt text not null default '' constraint research_evidence_excerpt_len check (char_length(excerpt) <= 300),
  seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists research_evidence_check_idx on public.research_evidence (check_id);

create table if not exists public.research_lists (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  run_id uuid references public.research_runs (id) on delete set null,
  name text not null constraint research_lists_name_len check (char_length(btrim(name)) between 1 and 120),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.research_list_items (
  list_id uuid not null references public.research_lists (id) on delete cascade,
  candidate_id uuid not null references public.research_candidates (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (list_id, candidate_id)
);

-- ---------------------------------------------------------------- helpers (security definer)
-- True when the run exists and belongs to the workspace. Used by child-table policies so a row can never point
-- at a run of another workspace.
create or replace function public.run_in_workspace(p_run uuid, p_ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.research_runs r where r.id = p_run and r.workspace_id = p_ws);
$$;

-- Money spent on AI today (UTC day) by a workspace. Members only. Used by the daily cap (R16).
create or replace function public.ai_spend_today(p_workspace uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_workspace_member(p_workspace) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  return coalesce((
    select sum(c.cost_usd) from public.ai_calls c
    where c.workspace_id = p_workspace
      and c.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
  ), 0);
end;
$$;

-- Step lease: only one request at a time may advance a run (two open tabs cannot run the same step twice).
create or replace function public.claim_research_step(p_run uuid, p_holder uuid, p_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  update public.research_runs r
     set locked_until = now() + make_interval(secs => least(greatest(coalesce(p_seconds, 60), 10), 900)),
         locked_by = p_holder
   where r.id = p_run
     and public.is_workspace_member(r.workspace_id)
     and (r.locked_until is null or r.locked_until < now() or r.locked_by = p_holder);
  return found;
end;
$$;

create or replace function public.release_research_step(p_run uuid, p_holder uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.research_runs r
     set locked_until = null, locked_by = null
   where r.id = p_run and r.locked_by = p_holder and public.is_workspace_member(r.workspace_id);
end;
$$;

-- ---------------------------------------------------------------- triggers
-- Run lifecycle (P4): the search can only start after the plan was approved, and the approved plan, rigor and
-- caps are frozen from then on. Approval stamps are set here, never by the client.
create or replace function public.guard_research_run()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  ok boolean;
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.status := 'questions';
    new.spent_cost_usd := 0;
    new.locked_until := null;
    new.locked_by := null;
    new.approved_at := null;
    new.approved_by := null;
    return new;
  end if;

  new.updated_at := now();

  if new.status is distinct from old.status then
    ok := case old.status
      when 'questions' then new.status in ('plan', 'cancelled', 'failed')
      when 'plan' then new.status in ('ready', 'cancelled', 'failed')
      when 'ready' then new.status in ('running', 'cancelled', 'failed')
      when 'running' then new.status in ('paused', 'done', 'failed', 'cancelled')
      when 'paused' then new.status in ('running', 'done', 'cancelled', 'failed')
      else false
    end;
    if not ok then
      raise exception 'invalid research status change: % -> %', old.status, new.status using errcode = '23514';
    end if;
    if new.status = 'ready' then
      if new.plan is null then
        raise exception 'P4: a plan is required before approval' using errcode = '23514';
      end if;
      new.approved_at := now();
      new.approved_by := auth.uid();
    end if;
  end if;

  if old.status in ('ready', 'running', 'paused', 'done', 'failed', 'cancelled') then
    if new.plan is distinct from old.plan
       or new.rigor is distinct from old.rigor
       or new.region_text is distinct from old.region_text
       or new.answers is distinct from old.answers
       or new.max_candidates is distinct from old.max_candidates
       or new.max_cost_usd is distinct from old.max_cost_usd
       or new.max_minutes is distinct from old.max_minutes
    then
      raise exception 'P4: the approved plan is frozen' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- ai_calls: who and when come from the session and the clock, not from the client.
create or replace function public.stamp_ai_call()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.user_id := auth.uid();
  new.created_at := now();
  return new;
end;
$$;

-- Adds each call's cost to its run. SECURITY DEFINER because clients have no update grant on spent_cost_usd.
create or replace function public.add_ai_cost_to_run()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.run_id is not null and new.cost_usd > 0 then
    update public.research_runs r
       set spent_cost_usd = r.spent_cost_usd + new.cost_usd
     where r.id = new.run_id and r.workspace_id = new.workspace_id;
  end if;
  return null;
end;
$$;

-- research_checks: run_id comes from the candidate; the workspace must match.
create or replace function public.stamp_research_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run uuid;
  v_ws uuid;
begin
  select c.run_id, c.workspace_id into v_run, v_ws from public.research_candidates c where c.id = new.candidate_id;
  if v_ws is null or v_ws <> new.workspace_id then
    raise exception 'candidate not in workspace' using errcode = '42501';
  end if;
  new.run_id := v_run;
  new.created_at := now();
  return new;
end;
$$;

create or replace function public.stamp_research_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  select k.workspace_id into v_ws from public.research_checks k where k.id = new.check_id;
  if v_ws is null or v_ws <> new.workspace_id then
    raise exception 'check not in workspace' using errcode = '42501';
  end if;
  new.created_at := now();
  return new;
end;
$$;

-- P1 and P9, checked at commit time (deferred) so a check and its evidence can be written in one transaction.
create or replace function public.require_research_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
  hosts integer;
  v_rigor text;
begin
  if new.result <> 'ok' then
    return null;
  end if;
  if not exists (select 1 from public.research_checks k where k.id = new.id) then
    return null; -- deleted in the same transaction (cascade)
  end if;
  select count(*), count(distinct public.url_host(e.url)) into n, hosts
    from public.research_evidence e where e.check_id = new.id;
  if n < 1 then
    raise exception 'P1: a check marked ok needs at least one source' using errcode = '23514';
  end if;
  select r.rigor into v_rigor from public.research_runs r where r.id = new.run_id;
  if v_rigor = 'strict' and hosts < 2 then
    raise exception 'P9: in strict rigor an ok needs two independent sources' using errcode = '23514';
  end if;
  return null;
end;
$$;

-- P3: only candidates the user kept can enter a list.
create or replace function public.guard_research_list_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.research_candidates c
    join public.research_lists l on l.id = new.list_id
    where c.id = new.candidate_id
      and c.workspace_id = new.workspace_id
      and l.workspace_id = new.workspace_id
      and c.user_decision = 'keep'
  ) then
    raise exception 'P3: only kept candidates can enter a list' using errcode = '23514';
  end if;
  new.created_at := now();
  return new;
end;
$$;

create or replace function public.stamp_research_list()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_by := auth.uid();
  new.created_at := now();
  return new;
end;
$$;

create or replace function public.touch_workspace_settings()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists guard_research_run on public.research_runs;
create trigger guard_research_run
  before insert or update on public.research_runs
  for each row execute function public.guard_research_run();

drop trigger if exists stamp_ai_call on public.ai_calls;
create trigger stamp_ai_call
  before insert on public.ai_calls
  for each row execute function public.stamp_ai_call();

drop trigger if exists add_ai_cost_to_run on public.ai_calls;
create trigger add_ai_cost_to_run
  after insert on public.ai_calls
  for each row execute function public.add_ai_cost_to_run();

drop trigger if exists stamp_research_check on public.research_checks;
create trigger stamp_research_check
  before insert on public.research_checks
  for each row execute function public.stamp_research_check();

drop trigger if exists require_research_evidence on public.research_checks;
create constraint trigger require_research_evidence
  after insert or update on public.research_checks
  deferrable initially deferred
  for each row execute function public.require_research_evidence();

drop trigger if exists stamp_research_evidence on public.research_evidence;
create trigger stamp_research_evidence
  before insert on public.research_evidence
  for each row execute function public.stamp_research_evidence();

drop trigger if exists guard_research_list_item on public.research_list_items;
create trigger guard_research_list_item
  before insert on public.research_list_items
  for each row execute function public.guard_research_list_item();

drop trigger if exists stamp_research_list on public.research_lists;
create trigger stamp_research_list
  before insert on public.research_lists
  for each row execute function public.stamp_research_list();

drop trigger if exists touch_workspace_settings on public.workspace_settings;
create trigger touch_workspace_settings
  before insert or update on public.workspace_settings
  for each row execute function public.touch_workspace_settings();

-- ---------------------------------------------------------------- RPCs (security invoker: RLS and grants apply)
-- One check and its evidence in one transaction (P1 is checked at commit).
create or replace function public.add_research_check(
  p_candidate uuid,
  p_kind text,
  p_pass integer,
  p_result text,
  p_summary text,
  p_evidence jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ws uuid;
  v_id uuid;
  e jsonb;
begin
  select c.workspace_id into v_ws from public.research_candidates c where c.id = p_candidate;
  if v_ws is null then
    raise exception 'candidate not found' using errcode = '42501';
  end if;
  insert into public.research_checks (workspace_id, candidate_id, kind, pass, result, summary)
  values (v_ws, p_candidate, p_kind, p_pass, p_result, coalesce(p_summary, ''))
  returning id into v_id;
  for e in select * from jsonb_array_elements(coalesce(p_evidence, '[]'::jsonb)) loop
    insert into public.research_evidence (workspace_id, check_id, url, title, excerpt, seen_at)
    values (
      v_ws, v_id, e ->> 'url', coalesce(e ->> 'title', ''), coalesce(e ->> 'excerpt', ''),
      coalesce((e ->> 'seen_at')::timestamptz, now())
    );
  end loop;
  return v_id;
end;
$$;

-- Creates a list from the kept candidates of a run (P3: nothing else can enter).
create or replace function public.create_research_list(p_run uuid, p_name text)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ws uuid;
  v_id uuid;
begin
  select r.workspace_id into v_ws from public.research_runs r where r.id = p_run;
  if v_ws is null then
    raise exception 'run not found' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.research_candidates c where c.run_id = p_run and c.user_decision = 'keep'
  ) then
    raise exception 'P3: no kept candidates' using errcode = '23514';
  end if;
  insert into public.research_lists (workspace_id, run_id, name)
  values (v_ws, p_run, btrim(coalesce(p_name, '')))
  returning id into v_id;
  insert into public.research_list_items (list_id, candidate_id, workspace_id)
  select v_id, c.id, v_ws from public.research_candidates c where c.run_id = p_run and c.user_decision = 'keep';
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- privileges
revoke all on function public.is_safe_url(text) from public, anon;
revoke all on function public.url_host(text) from public, anon;
revoke all on function public.run_in_workspace(uuid, uuid) from public, anon;
revoke all on function public.ai_spend_today(uuid) from public, anon;
revoke all on function public.claim_research_step(uuid, uuid, integer) from public, anon;
revoke all on function public.release_research_step(uuid, uuid) from public, anon;
revoke all on function public.add_research_check(uuid, text, integer, text, text, jsonb) from public, anon;
revoke all on function public.create_research_list(uuid, text) from public, anon;
revoke all on function public.guard_research_run() from public, anon, authenticated;
revoke all on function public.stamp_ai_call() from public, anon, authenticated;
revoke all on function public.add_ai_cost_to_run() from public, anon, authenticated;
revoke all on function public.stamp_research_check() from public, anon, authenticated;
revoke all on function public.stamp_research_evidence() from public, anon, authenticated;
revoke all on function public.require_research_evidence() from public, anon, authenticated;
revoke all on function public.guard_research_list_item() from public, anon, authenticated;
revoke all on function public.stamp_research_list() from public, anon, authenticated;
revoke all on function public.touch_workspace_settings() from public, anon, authenticated;
grant execute on function public.is_safe_url(text) to authenticated;
grant execute on function public.url_host(text) to authenticated;
grant execute on function public.run_in_workspace(uuid, uuid) to authenticated;
grant execute on function public.ai_spend_today(uuid) to authenticated;
grant execute on function public.claim_research_step(uuid, uuid, integer) to authenticated;
grant execute on function public.release_research_step(uuid, uuid) to authenticated;
grant execute on function public.add_research_check(uuid, text, integer, text, text, jsonb) to authenticated;
grant execute on function public.create_research_list(uuid, text) to authenticated;

revoke all on table public.workspace_settings from public, anon, authenticated;
revoke all on table public.ai_calls from public, anon, authenticated;
revoke all on table public.research_runs from public, anon, authenticated;
revoke all on table public.research_sources from public, anon, authenticated;
revoke all on table public.research_candidates from public, anon, authenticated;
revoke all on table public.research_checks from public, anon, authenticated;
revoke all on table public.research_evidence from public, anon, authenticated;
revoke all on table public.research_lists from public, anon, authenticated;
revoke all on table public.research_list_items from public, anon, authenticated;

-- workspace_settings: owners set the cap (policy); updated_at belongs to the trigger.
grant select on table public.workspace_settings to authenticated;
grant insert (workspace_id, ai_daily_cap_usd, default_rigor) on table public.workspace_settings to authenticated;
grant update (ai_daily_cap_usd, default_rigor) on table public.workspace_settings to authenticated;

-- ai_calls: insert-only ledger. No update, no delete (the daily cap reads it).
grant select on table public.ai_calls to authenticated;
grant insert (workspace_id, run_id, task, model, prompt_version, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, web_searches, web_fetches, cost_usd, status, error, duration_ms)
  on table public.ai_calls to authenticated;

-- research_runs: spent cost, lease and approval stamps are not client-writable.
grant select, delete on table public.research_runs to authenticated;
grant insert (workspace_id, title, request_text, region_text, rigor, max_candidates, max_cost_usd, max_minutes)
  on table public.research_runs to authenticated;
grant update (title, region_text, rigor, status, questions, answers, adjustments, plan, max_candidates, max_cost_usd,
              max_minutes, progress, is_partial, partial_reason, limits_notes, error, started_at, finished_at)
  on table public.research_runs to authenticated;

grant select on table public.research_sources to authenticated;
grant insert (workspace_id, run_id, kind, title, url, status, note) on table public.research_sources to authenticated;
grant update (status, note) on table public.research_sources to authenticated;

grant select on table public.research_candidates to authenticated;
grant insert (workspace_id, run_id, name, name_key, city, state, region, website, phone, public_email, email_type,
              company_type, size_note, notes, is_partial)
  on table public.research_candidates to authenticated;
grant update (city, state, region, website, phone, public_email, email_type, company_type, size_note, temperature,
              approach, ask_for_name, ask_for_title, name_confidence, name_source_url, name_note, permit_count,
              total_value_usd, last_permit_date, biggest_job_address, biggest_job_value_usd, biggest_job_type,
              biggest_job_description, signal_match, google_rating, review_count, hook, supplier_portal_url, notes,
              user_decision, second_pass, is_partial, verified_at)
  on table public.research_candidates to authenticated;

-- checks and evidence: insert-only (through add_research_check). run_id is set by the trigger.
grant select on table public.research_checks to authenticated;
grant insert (workspace_id, candidate_id, kind, pass, result, summary) on table public.research_checks to authenticated;
grant select on table public.research_evidence to authenticated;
grant insert (workspace_id, check_id, url, title, excerpt, seen_at) on table public.research_evidence to authenticated;

grant select, delete on table public.research_lists to authenticated;
grant insert (workspace_id, run_id, name) on table public.research_lists to authenticated;
grant update (name) on table public.research_lists to authenticated;
grant select, delete on table public.research_list_items to authenticated;
grant insert (list_id, candidate_id, workspace_id) on table public.research_list_items to authenticated;

-- ---------------------------------------------------------------- row level security
alter table public.workspace_settings enable row level security;
alter table public.workspace_settings force row level security;
alter table public.ai_calls enable row level security;
alter table public.ai_calls force row level security;
alter table public.research_runs enable row level security;
alter table public.research_runs force row level security;
alter table public.research_sources enable row level security;
alter table public.research_sources force row level security;
alter table public.research_candidates enable row level security;
alter table public.research_candidates force row level security;
alter table public.research_checks enable row level security;
alter table public.research_checks force row level security;
alter table public.research_evidence enable row level security;
alter table public.research_evidence force row level security;
alter table public.research_lists enable row level security;
alter table public.research_lists force row level security;
alter table public.research_list_items enable row level security;
alter table public.research_list_items force row level security;

-- workspace_settings
drop policy if exists workspace_settings_select on public.workspace_settings;
create policy workspace_settings_select on public.workspace_settings
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists workspace_settings_insert on public.workspace_settings;
create policy workspace_settings_insert on public.workspace_settings
  for insert to authenticated with check (public.is_workspace_owner(workspace_id));
drop policy if exists workspace_settings_update on public.workspace_settings;
create policy workspace_settings_update on public.workspace_settings
  for update to authenticated
  using (public.is_workspace_owner(workspace_id))
  with check (public.is_workspace_owner(workspace_id));

-- ai_calls
drop policy if exists ai_calls_select on public.ai_calls;
create policy ai_calls_select on public.ai_calls
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists ai_calls_insert on public.ai_calls;
create policy ai_calls_insert on public.ai_calls
  for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and (run_id is null or public.run_in_workspace(run_id, workspace_id))
  );

-- research_runs
drop policy if exists research_runs_select on public.research_runs;
create policy research_runs_select on public.research_runs
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists research_runs_insert on public.research_runs;
create policy research_runs_insert on public.research_runs
  for insert to authenticated with check (public.is_workspace_member(workspace_id));
drop policy if exists research_runs_update on public.research_runs;
create policy research_runs_update on public.research_runs
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
drop policy if exists research_runs_delete on public.research_runs;
create policy research_runs_delete on public.research_runs
  for delete to authenticated
  using (public.is_workspace_owner(workspace_id) or (created_by = auth.uid() and public.is_workspace_member(workspace_id)));

-- research_sources
drop policy if exists research_sources_select on public.research_sources;
create policy research_sources_select on public.research_sources
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists research_sources_insert on public.research_sources;
create policy research_sources_insert on public.research_sources
  for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and public.run_in_workspace(run_id, workspace_id));
drop policy if exists research_sources_update on public.research_sources;
create policy research_sources_update on public.research_sources
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- research_candidates
drop policy if exists research_candidates_select on public.research_candidates;
create policy research_candidates_select on public.research_candidates
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists research_candidates_insert on public.research_candidates;
create policy research_candidates_insert on public.research_candidates
  for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and public.run_in_workspace(run_id, workspace_id));
drop policy if exists research_candidates_update on public.research_candidates;
create policy research_candidates_update on public.research_candidates
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- research_checks / research_evidence (the stamp triggers verify the parent's workspace)
drop policy if exists research_checks_select on public.research_checks;
create policy research_checks_select on public.research_checks
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists research_checks_insert on public.research_checks;
create policy research_checks_insert on public.research_checks
  for insert to authenticated with check (public.is_workspace_member(workspace_id));
drop policy if exists research_evidence_select on public.research_evidence;
create policy research_evidence_select on public.research_evidence
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists research_evidence_insert on public.research_evidence;
create policy research_evidence_insert on public.research_evidence
  for insert to authenticated with check (public.is_workspace_member(workspace_id));

-- research_lists / research_list_items
drop policy if exists research_lists_select on public.research_lists;
create policy research_lists_select on public.research_lists
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists research_lists_insert on public.research_lists;
create policy research_lists_insert on public.research_lists
  for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and (run_id is null or public.run_in_workspace(run_id, workspace_id))
  );
drop policy if exists research_lists_update on public.research_lists;
create policy research_lists_update on public.research_lists
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
drop policy if exists research_lists_delete on public.research_lists;
create policy research_lists_delete on public.research_lists
  for delete to authenticated using (public.is_workspace_member(workspace_id));

drop policy if exists research_list_items_select on public.research_list_items;
create policy research_list_items_select on public.research_list_items
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists research_list_items_insert on public.research_list_items;
create policy research_list_items_insert on public.research_list_items
  for insert to authenticated with check (public.is_workspace_member(workspace_id));
drop policy if exists research_list_items_delete on public.research_list_items;
create policy research_list_items_delete on public.research_list_items
  for delete to authenticated using (public.is_workspace_member(workspace_id));
