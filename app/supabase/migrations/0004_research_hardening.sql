-- 0004 research hardening (review of 10/11/2026). Applies on top of 0001 + 0002; independent of 0003 (e-mail area).
-- Never edits 0001/0002: everything here is `create or replace`, `alter`, new objects, revoke/grant. Re-runnable.
-- Same standard: RLS enabled and forced, policies only for `authenticated`, SECURITY DEFINER helpers with an empty
-- search_path, no service-role key anywhere (R14).
--
-- What changes (finding numbers from the review):
--   10  url_host / is_safe_url match src/lib/safe-url.ts: trailing dots, IPv6, IP-literal and internal hosts.
--   1   ai_access allowlist + ai_limits ceilings; per-user and global daily caps; at most 3 owned workspaces;
--       workspace daily cap <= US$ 50.
--   2   ai_calls is no longer client-insertable: reserve_ai_call (atomic check + pending row at the worst-case
--       reserve, under one lock) and settle_ai_call (the caller's own pending row, once, cost bounded).
--   6   one check per (candidate, kind, pass); add_research_check upserts (idempotent retries).
--   7   the run's clock and end-of-run fields belong to the database; progress only moves forward.
--   5/17/20  new candidate columns (entry path, found-at, per-field sources), source status 'unverified',
--       research_jobs ("Obras sem construtora").
--
-- Applying to a live database that already has rows: see the "live database" notes inline (search for LIVE).

-- ================================================================ 10. URL helpers (same vectors as the TS tests)
-- Host of an http(s) URL: lower case, userinfo skipped, IPv6 literal kept in brackets, trailing dots and a leading
-- "www." removed; null when not http(s).
create or replace function public.url_host(u text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(
    regexp_replace(
      regexp_replace(
        lower(substring(u from '^[Hh][Tt][Tt][Pp][Ss]?://(?:[^/?#@]*@)?(\[[^]/?#]*\]|[^/?#:]+)')),
        '\.+$', ''),
      '^www\.', ''),
    '');
$$;

-- LIVE: replacing this function does not re-check rows already stored; only new writes are checked.
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
    and u !~ '^[A-Za-z]+://[^/?#]*@'
    and coalesce(public.url_host(u), '') like '%.%'
    and strpos(public.url_host(u), '[') = 0
    and strpos(public.url_host(u), ':') = 0
    and public.url_host(u) !~ '(^|\.)(0x[0-9a-f]*|[0-9]+)$'
    and public.url_host(u) !~ '(^|\.)(localhost|local|internal|localdomain|lan|home\.arpa|intranet|corp)$'
    and public.url_host(u) !~ '(^|\.)(linkedin\.com|lnkd\.in)$'
  );
$$;

-- ================================================================ 1. AI access allowlist and ceilings
-- Ceilings the server env can only lower (AI_USER_DAILY_CAP_USD, AI_GLOBAL_DAILY_CAP_USD). One row. No client
-- grant at all: the operator changes it in the SQL editor.
create table if not exists public.ai_limits (
  id boolean primary key default true constraint ai_limits_singleton check (id),
  user_daily_max_usd numeric(10, 2) not null default 10 constraint ai_limits_user check (user_daily_max_usd between 0 and 1000),
  global_daily_max_usd numeric(10, 2) not null default 25 constraint ai_limits_global check (global_daily_max_usd between 0 and 10000),
  call_cost_max_usd numeric(10, 2) not null default 25 constraint ai_limits_call check (call_cost_max_usd between 0.01 and 100),
  updated_at timestamptz not null default now()
);
insert into public.ai_limits (id) values (true) on conflict (id) do nothing;

-- Who may spend the operator's Anthropic key. Sign-up alone does not grant it.
create table if not exists public.ai_access (
  user_id uuid primary key references auth.users (id) on delete cascade,
  granted_at timestamptz not null default now()
);

-- Every user that exists when this migration runs keeps access (works on the PGlite test stub of auth.users too).
-- LIVE: users who sign up after this point need a row (insert into public.ai_access (user_id) values (...)).
insert into public.ai_access (user_id) select u.id from auth.users u on conflict (user_id) do nothing;

-- Workspace daily cap: hard ceiling US$ 50 (was 100). LIVE: higher values are clamped to 50 first.
update public.workspace_settings set ai_daily_cap_usd = 50 where ai_daily_cap_usd > 50;
alter table public.workspace_settings drop constraint if exists workspace_settings_cap_range;
alter table public.workspace_settings
  add constraint workspace_settings_cap_range check (ai_daily_cap_usd >= 0 and ai_daily_cap_usd <= 50);

-- At most 3 owned workspaces per user (each workspace has its own daily cap, so more would multiply it).
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
  perform pg_advisory_xact_lock(hashtext('public.create_workspace'), hashtext(auth.uid()::text));
  if (select count(*) from public.workspace_members m where m.user_id = auth.uid() and m.role = 'owner') >= 3 then
    raise exception 'workspace limit: at most 3 owned workspaces' using errcode = '23514';
  end if;
  insert into public.workspaces (name, created_by)
  values (v_name, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

-- ================================================================ 2. AI ledger: reserve, then settle once
alter table public.ai_calls add column if not exists reserve_usd numeric(12, 6) not null default 0;
alter table public.ai_calls add column if not exists settled_at timestamptz;
alter table public.ai_calls drop constraint if exists ai_calls_reserve;
alter table public.ai_calls add constraint ai_calls_reserve check (reserve_usd >= 0 and reserve_usd <= 100);
alter table public.ai_calls drop constraint if exists ai_calls_status;
alter table public.ai_calls
  add constraint ai_calls_status check (status in ('pending', 'ok', 'refused', 'invalid_output', 'truncated', 'error'));
-- LIVE: NOT VALID, so an old row above the ceiling does not block the migration; new rows are checked.
alter table public.ai_calls drop constraint if exists ai_calls_cost_max;
alter table public.ai_calls add constraint ai_calls_cost_max check (cost_usd <= 100) not valid;

-- Day window (UTC) and the cost a row counts for: a pending row counts at its reserve until settled (never free,
-- however old it is); a settled row counts at its real cost.
create or replace function public.ai_day_start()
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select date_trunc('day', now() at time zone 'utc') at time zone 'utc';
$$;

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
    select sum(case when c.status = 'pending' then greatest(c.reserve_usd, c.cost_usd) else c.cost_usd end)
    from public.ai_calls c
    where c.workspace_id = p_workspace and c.created_at >= public.ai_day_start()
  ), 0);
end;
$$;

-- The caller's own spend today, across every workspace.
create or replace function public.ai_spend_today_user()
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(case when c.status = 'pending' then greatest(c.reserve_usd, c.cost_usd) else c.cost_usd end), 0)
  from public.ai_calls c
  where c.user_id = auth.uid() and c.created_at >= public.ai_day_start();
$$;

-- Total spend today across all workspaces. Returns only one number.
create or replace function public.ai_spend_today_global()
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  return coalesce((
    select sum(case when c.status = 'pending' then greatest(c.reserve_usd, c.cost_usd) else c.cost_usd end)
    from public.ai_calls c
    where c.created_at >= public.ai_day_start()
  ), 0);
end;
$$;

-- Atomic check-and-reserve. Errors carry "ai_cap:<code>" so the app maps them to typed errors.
-- One transaction-level advisory lock for every reservation in the deployment: the global cap needs it, and the
-- volume (a handful of calls per minute) makes the serialisation free in practice.
create or replace function public.reserve_ai_call(
  p_workspace uuid,
  p_run uuid,
  p_task text,
  p_model text,
  p_prompt_version text,
  p_reserve_usd numeric,
  p_user_cap_usd numeric,
  p_global_cap_usd numeric
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_lim public.ai_limits%rowtype;
  v_ws_cap numeric;
  v_spent numeric;
  v_run public.research_runs%rowtype;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not exists (select 1 from public.ai_access a where a.user_id = v_uid) then
    raise exception 'ai_cap:no_access' using errcode = '42501';
  end if;
  if not public.is_workspace_member(p_workspace) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  if p_run is not null and not public.run_in_workspace(p_run, p_workspace) then
    raise exception 'run not in workspace' using errcode = '42501';
  end if;
  select * into v_lim from public.ai_limits l where l.id;
  if p_reserve_usd is null or p_reserve_usd <= 0 or p_reserve_usd > v_lim.call_cost_max_usd then
    raise exception 'invalid reserve' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('public.reserve_ai_call'));

  v_ws_cap := coalesce((select s.ai_daily_cap_usd from public.workspace_settings s where s.workspace_id = p_workspace), 10);
  select coalesce(sum(case when c.status = 'pending' then greatest(c.reserve_usd, c.cost_usd) else c.cost_usd end), 0)
    into v_spent from public.ai_calls c where c.workspace_id = p_workspace and c.created_at >= public.ai_day_start();
  if v_spent + p_reserve_usd > v_ws_cap then
    raise exception 'ai_cap:daily_cap' using errcode = 'P0001';
  end if;

  select coalesce(sum(case when c.status = 'pending' then greatest(c.reserve_usd, c.cost_usd) else c.cost_usd end), 0)
    into v_spent from public.ai_calls c where c.user_id = v_uid and c.created_at >= public.ai_day_start();
  if v_spent + p_reserve_usd > least(coalesce(p_user_cap_usd, v_lim.user_daily_max_usd), v_lim.user_daily_max_usd) then
    raise exception 'ai_cap:user_cap' using errcode = 'P0001';
  end if;

  select coalesce(sum(case when c.status = 'pending' then greatest(c.reserve_usd, c.cost_usd) else c.cost_usd end), 0)
    into v_spent from public.ai_calls c where c.created_at >= public.ai_day_start();
  if v_spent + p_reserve_usd > least(coalesce(p_global_cap_usd, v_lim.global_daily_max_usd), v_lim.global_daily_max_usd) then
    raise exception 'ai_cap:global_cap' using errcode = 'P0001';
  end if;

  if p_run is not null then
    select * into v_run from public.research_runs r where r.id = p_run;
    if v_run.status = 'running' then
      if v_run.started_at is not null and now() > v_run.started_at + make_interval(mins => v_run.max_minutes) then
        raise exception 'ai_cap:run_time' using errcode = 'P0001';
      end if;
      select coalesce(sum(c.reserve_usd), 0) into v_spent
        from public.ai_calls c where c.run_id = p_run and c.status = 'pending';
      if v_run.spent_cost_usd + v_spent + p_reserve_usd > v_run.max_cost_usd then
        raise exception 'ai_cap:run_cap' using errcode = 'P0001';
      end if;
    end if;
  end if;

  insert into public.ai_calls (workspace_id, run_id, task, model, prompt_version, status, reserve_usd)
  values (p_workspace, p_run, p_task, p_model, p_prompt_version, 'pending', p_reserve_usd)
  returning id into v_id;
  return v_id;
end;
$$;

-- Settles the caller's own pending row, once, with the real usage. Cost bounded by ai_limits.call_cost_max_usd.
create or replace function public.settle_ai_call(
  p_id uuid,
  p_status text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_cache_read_tokens integer,
  p_cache_write_tokens integer,
  p_web_searches integer,
  p_web_fetches integer,
  p_cost_usd numeric,
  p_error text,
  p_duration_ms integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max numeric;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_status is null or p_status not in ('ok', 'refused', 'invalid_output', 'truncated', 'error') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  select l.call_cost_max_usd into v_max from public.ai_limits l where l.id;
  if p_cost_usd is null or p_cost_usd < 0 or p_cost_usd > v_max then
    raise exception 'invalid cost' using errcode = '22023';
  end if;
  update public.ai_calls c
     set status = p_status,
         input_tokens = greatest(coalesce(p_input_tokens, 0), 0),
         output_tokens = greatest(coalesce(p_output_tokens, 0), 0),
         cache_read_tokens = greatest(coalesce(p_cache_read_tokens, 0), 0),
         cache_write_tokens = greatest(coalesce(p_cache_write_tokens, 0), 0),
         web_searches = greatest(coalesce(p_web_searches, 0), 0),
         web_fetches = greatest(coalesce(p_web_fetches, 0), 0),
         cost_usd = p_cost_usd,
         error = left(p_error, 300),
         duration_ms = greatest(coalesce(p_duration_ms, 0), 0),
         settled_at = now()
   where c.id = p_id and c.user_id = auth.uid() and c.status = 'pending';
  if not found then
    raise exception 'ai call is not a pending call of this user' using errcode = '42501';
  end if;
end;
$$;

-- Run spend follows settled cost (insert and the one settling update).
create or replace function public.add_ai_cost_to_run()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delta numeric;
begin
  if new.run_id is null then
    return null;
  end if;
  v_delta := new.cost_usd - case when tg_op = 'UPDATE' then old.cost_usd else 0 end;
  if v_delta <> 0 then
    update public.research_runs r
       set spent_cost_usd = r.spent_cost_usd + v_delta
     where r.id = new.run_id and r.workspace_id = new.workspace_id;
  end if;
  return null;
end;
$$;

drop trigger if exists add_ai_cost_to_run on public.ai_calls;
create trigger add_ai_cost_to_run
  after insert or update of cost_usd on public.ai_calls
  for each row execute function public.add_ai_cost_to_run();

-- No direct client writes to the ledger any more (only the two RPCs above).
revoke all on table public.ai_calls from public, anon, authenticated;
grant select on table public.ai_calls to authenticated;
drop policy if exists ai_calls_insert on public.ai_calls;

-- ================================================================ 17. source status "unverified"
alter table public.research_sources drop constraint if exists research_sources_status;
alter table public.research_sources
  add constraint research_sources_status check (status in ('used', 'empty', 'unverified', 'blocked', 'error'));

-- ================================================================ 5 / 20. candidate columns
alter table public.research_candidates
  add column if not exists entry_path text
    constraint research_candidates_entry_path check (entry_path in ('directory', 'search', 'signal')),
  add column if not exists found_at_url text
    constraint research_candidates_found_at_url check (public.is_safe_url(found_at_url)),
  add column if not exists found_at_title text
    constraint research_candidates_found_at_title_len check (char_length(found_at_title) <= 200),
  add column if not exists found_at_excerpt text
    constraint research_candidates_found_at_excerpt_len check (char_length(found_at_excerpt) <= 300),
  add column if not exists found_at_seen_at timestamptz,
  add column if not exists phone_source_url text
    constraint research_candidates_phone_source_url check (public.is_safe_url(phone_source_url)),
  add column if not exists email_source_url text
    constraint research_candidates_email_source_url check (public.is_safe_url(email_source_url)),
  add column if not exists rating_source_url text
    constraint research_candidates_rating_source_url check (public.is_safe_url(rating_source_url));

grant insert (entry_path, found_at_url, found_at_title, found_at_excerpt, found_at_seen_at, phone_source_url)
  on table public.research_candidates to authenticated;
grant update (phone_source_url, email_source_url, rating_source_url) on table public.research_candidates to authenticated;

-- ================================================================ 6. one check per (candidate, kind, pass)
-- LIVE: duplicates (from retried steps) are removed first, keeping the newest row of each group.
delete from public.research_checks a
 using public.research_checks b
 where a.candidate_id = b.candidate_id and a.kind = b.kind and a.pass = b.pass
   and (a.created_at < b.created_at or (a.created_at = b.created_at and a.id < b.id));

do $$
begin
  alter table public.research_checks
    add constraint research_checks_one_per_pass unique (candidate_id, kind, pass);
exception
  when duplicate_object or duplicate_table then null;
end
$$;

-- Idempotent: a retried step replaces the check and its evidence instead of adding a second one. SECURITY DEFINER
-- (it must replace evidence, which clients cannot delete), with the membership check done here.
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
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  v_id uuid;
  e jsonb;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select c.workspace_id into v_ws from public.research_candidates c where c.id = p_candidate;
  if v_ws is null or not public.is_workspace_member(v_ws) then
    raise exception 'candidate not found' using errcode = '42501';
  end if;
  insert into public.research_checks (workspace_id, candidate_id, kind, pass, result, summary)
  values (v_ws, p_candidate, p_kind, p_pass, p_result, coalesce(p_summary, ''))
  on conflict (candidate_id, kind, pass)
  do update set result = excluded.result, summary = excluded.summary, created_at = now()
  returning id into v_id;
  delete from public.research_evidence ev where ev.check_id = v_id;
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

-- ================================================================ 20. jobs without a builder (G10)
create table if not exists public.research_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  run_id uuid not null references public.research_runs (id) on delete cascade,
  address text constraint research_jobs_address_len check (char_length(address) <= 200),
  project_name text constraint research_jobs_project_len check (char_length(project_name) <= 200),
  job_type text constraint research_jobs_type_len check (char_length(job_type) <= 100),
  declared_value_usd numeric(14, 2) constraint research_jobs_value check (declared_value_usd >= 0),
  job_date date,
  source_url text not null constraint research_jobs_source_url check (public.is_safe_url(source_url)),
  excerpt text not null default '' constraint research_jobs_excerpt_len check (char_length(excerpt) <= 300),
  seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint research_jobs_what check (address is not null or project_name is not null)
);

create index if not exists research_jobs_run_idx on public.research_jobs (run_id);
create unique index if not exists research_jobs_dedupe
  on public.research_jobs (run_id, source_url, coalesce(lower(address), ''), coalesce(lower(project_name), ''));

-- Inserts a batch of jobs for a run, skipping ones already stored (security invoker: RLS and grants apply).
create or replace function public.add_research_jobs(p_run uuid, p_jobs jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ws uuid;
  v_n integer;
begin
  select r.workspace_id into v_ws from public.research_runs r where r.id = p_run;
  if v_ws is null then
    raise exception 'run not found' using errcode = '42501';
  end if;
  insert into public.research_jobs (workspace_id, run_id, address, project_name, job_type, declared_value_usd, job_date, source_url, excerpt, seen_at)
  select v_ws, p_run, j ->> 'address', j ->> 'project_name', j ->> 'job_type', (j ->> 'declared_value_usd')::numeric,
         (j ->> 'job_date')::date, j ->> 'source_url', coalesce(j ->> 'excerpt', ''), coalesce((j ->> 'seen_at')::timestamptz, now())
  from jsonb_array_elements(coalesce(p_jobs, '[]'::jsonb)) j
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace function public.stamp_research_job()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists stamp_research_job on public.research_jobs;
create trigger stamp_research_job
  before insert on public.research_jobs
  for each row execute function public.stamp_research_job();

revoke all on table public.research_jobs from public, anon, authenticated;
grant select on table public.research_jobs to authenticated;
grant insert (workspace_id, run_id, address, project_name, job_type, declared_value_usd, job_date, source_url, excerpt, seen_at)
  on table public.research_jobs to authenticated;

alter table public.research_jobs enable row level security;
alter table public.research_jobs force row level security;
drop policy if exists research_jobs_select on public.research_jobs;
create policy research_jobs_select on public.research_jobs
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists research_jobs_insert on public.research_jobs;
create policy research_jobs_insert on public.research_jobs
  for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and public.run_in_workspace(run_id, workspace_id));

-- ================================================================ 7. run guard: clock, end-of-run fields, progress
create or replace function public.guard_research_run()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  ok boolean;
  ending boolean;
  stages text[] := array['discover_sources', 'collect', 'verify', 'second_pass', 'finalize'];
  v_old_stage integer;
  v_new_stage integer;
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.status := 'questions';
    new.spent_cost_usd := 0;
    new.locked_until := null;
    new.locked_by := null;
    new.approved_at := null;
    new.approved_by := null;
    new.started_at := null;
    new.finished_at := null;
    new.is_partial := false;
    new.partial_reason := null;
    new.limits_notes := '[]'::jsonb;
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

  -- The clock belongs to the database: started_at on ready -> running, finished_at when the run ends. Whatever a
  -- client sends for them is ignored, so the time cap (max_minutes) cannot be moved.
  ending := new.status is distinct from old.status and new.status in ('done', 'failed', 'cancelled');
  new.started_at := case when old.status = 'ready' and new.status = 'running' then now() else old.started_at end;
  new.finished_at := case when ending then now() else old.finished_at end;

  -- Partial flags and the limits notes are written once, when the run ends.
  if not ending and (
       new.limits_notes is distinct from old.limits_notes
       or new.is_partial is distinct from old.is_partial
       or new.partial_reason is distinct from old.partial_reason)
  then
    raise exception 'limits and partial flags are set only when the run ends' using errcode = '23514';
  end if;

  -- Progress only moves forward: the stage never goes back and collectRounds never decreases.
  if new.progress is distinct from old.progress then
    v_old_stage := array_position(stages, old.progress ->> 'stage');
    v_new_stage := array_position(stages, new.progress ->> 'stage');
    if v_old_stage is not null and (v_new_stage is null or v_new_stage < v_old_stage) then
      raise exception 'progress: the stage cannot go back' using errcode = '23514';
    end if;
    if coalesce((new.progress ->> 'collectRounds')::integer, 0) < coalesce((old.progress ->> 'collectRounds')::integer, 0) then
      raise exception 'progress: collectRounds cannot decrease' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- ================================================================ privileges
revoke all on table public.ai_limits from public, anon, authenticated;
alter table public.ai_limits enable row level security;
alter table public.ai_limits force row level security;

revoke all on table public.ai_access from public, anon, authenticated;
grant select on table public.ai_access to authenticated;
alter table public.ai_access enable row level security;
alter table public.ai_access force row level security;
drop policy if exists ai_access_select_own on public.ai_access;
create policy ai_access_select_own on public.ai_access
  for select to authenticated using (user_id = auth.uid());

revoke all on function public.url_host(text) from public, anon;
revoke all on function public.is_safe_url(text) from public, anon;
revoke all on function public.create_workspace(text) from public, anon;
revoke all on function public.ai_day_start() from public, anon;
revoke all on function public.ai_spend_today(uuid) from public, anon;
revoke all on function public.ai_spend_today_user() from public, anon;
revoke all on function public.ai_spend_today_global() from public, anon;
revoke all on function public.reserve_ai_call(uuid, uuid, text, text, text, numeric, numeric, numeric) from public, anon;
revoke all on function public.settle_ai_call(uuid, text, integer, integer, integer, integer, integer, integer, numeric, text, integer) from public, anon;
revoke all on function public.add_research_check(uuid, text, integer, text, text, jsonb) from public, anon;
revoke all on function public.add_research_jobs(uuid, jsonb) from public, anon;
revoke all on function public.add_ai_cost_to_run() from public, anon, authenticated;
revoke all on function public.guard_research_run() from public, anon, authenticated;
revoke all on function public.stamp_research_job() from public, anon, authenticated;
grant execute on function public.url_host(text) to authenticated;
grant execute on function public.is_safe_url(text) to authenticated;
grant execute on function public.create_workspace(text) to authenticated;
grant execute on function public.ai_day_start() to authenticated;
grant execute on function public.ai_spend_today(uuid) to authenticated;
grant execute on function public.ai_spend_today_user() to authenticated;
grant execute on function public.ai_spend_today_global() to authenticated;
grant execute on function public.reserve_ai_call(uuid, uuid, text, text, text, numeric, numeric, numeric) to authenticated;
grant execute on function public.settle_ai_call(uuid, text, integer, integer, integer, integer, integer, integer, numeric, text, integer) to authenticated;
grant execute on function public.add_research_check(uuid, text, integer, text, text, jsonb) to authenticated;
grant execute on function public.add_research_jobs(uuid, jsonb) to authenticated;
