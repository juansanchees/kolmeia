-- 0010 Caçador em segundo plano (F3b), part 1: agent life cycle and agent runs.
--   Ligar / Pausar: paused -> running -> paused are client transitions (hunter only); the server writes the rest.
--   A6 config and schedule are frozen for clients once the agent left draft (caps never come from config).
--   A7 at most 3 running hunters per workspace (C6); A8 a running agent cannot be archived.
--   Archiving cancels the agent's setup run and active run; deleting an agent deletes its setup research.
--   One active run (ready, running, paused) per agent; an agent run is born approved, by the database, not a client.
--   hunter_caps(rigor) = DEFAULT_CAPS in SQL (pinned to the TypeScript by a test).
-- Depends on 0001-0009. Re-runnable.

alter table public.agents
  add column if not exists paused_reason text;
alter table public.agents drop constraint if exists agents_paused_reason;
alter table public.agents
  add constraint agents_paused_reason
  check (paused_reason is null or paused_reason in ('daily_cap', 'user_cap', 'global_cap', 'no_access', 'error'));

-- Blocker 5: deleting an agent deletes its setup research.
alter table public.research_runs drop constraint if exists research_runs_setup_agent_id_fkey;
alter table public.research_runs
  add constraint research_runs_setup_agent_id_fkey
  foreign key (setup_agent_id) references public.agents (id) on delete cascade;

create unique index if not exists research_runs_one_active_per_agent
  on public.research_runs (agent_id)
  where agent_id is not null and status in ('ready', 'running', 'paused');

-- Caps of a scheduled run: the same numbers as DEFAULT_CAPS (src/lib/research/types.ts). Any other rigor is careful.
create or replace function public.hunter_caps(p_rigor text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case p_rigor
    when 'quick'  then '{"maxCandidates": 15, "maxCostUsd": 2, "maxMinutes": 20}'::jsonb
    when 'strict' then '{"maxCandidates": 25, "maxCostUsd": 5, "maxMinutes": 60}'::jsonb
    else               '{"maxCandidates": 20, "maxCostUsd": 3, "maxMinutes": 40}'::jsonb
  end
$$;

-- A1, A3 (generalised), A4, A6, A7, A8, Ligar. Not security definer on purpose: is_client_role() reads current_user.
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
        (old.status = 'draft' and new.status = 'paused'
          and exists (
            select 1 from public.research_runs r
             where r.setup_agent_id = new.id and r.status = 'plan' and r.plan is not null
          ))
        or (old.type = 'hunter' and old.status = 'paused' and new.status = 'running')
        or (old.type = 'hunter' and old.status = 'running' and new.status = 'paused')
      ) then
        raise exception 'A3: an agent leaves draft only when its setup research has a plan; then only Ligar and Pausar' using errcode = '23514';
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

-- Archiving cancels the setup run and the active run of the agent (the run guard validates each transition).
create or replace function public.archive_agent_runs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.archived_at is null and new.archived_at is not null then
    update public.research_runs r
       set status = 'cancelled'
     where (r.setup_agent_id = new.id or r.agent_id = new.id)
       and r.status in ('questions', 'plan', 'ready', 'running', 'paused');
  end if;
  return null;
end;
$$;

drop trigger if exists archive_agent_runs on public.agents;
create trigger archive_agent_runs
  after update on public.agents
  for each row execute function public.archive_agent_runs();

-- Run guard: the INSERT branch of 0004 plus the agent run (named by agent_id, inserted by the database, never a client).
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
  v_creator uuid;
begin
  if tg_op = 'INSERT' then
    if new.agent_id is not null and not public.is_client_role() and new.status = 'ready' then
      if new.plan is null then
        raise exception 'P4: a plan is required before approval' using errcode = '23514';
      end if;
      select a.created_by into v_creator from public.agents a where a.id = new.agent_id;
      new.created_by := v_creator;
      new.approved_by := v_creator;
      new.approved_at := now();
    else
      new.created_by := auth.uid();
      new.status := 'questions';
      new.approved_at := null;
      new.approved_by := null;
    end if;
    new.spent_cost_usd := 0;
    new.locked_until := null;
    new.locked_by := null;
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

  -- The clock belongs to the database: started_at on ready -> running, finished_at when the run ends.
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

revoke all on function public.guard_agent() from public, anon, authenticated;
revoke all on function public.guard_research_run() from public, anon, authenticated;
revoke all on function public.archive_agent_runs() from public, anon, authenticated;
revoke all on function public.hunter_caps(text) from public, anon, authenticated;

-- =====================================================================================================================
-- Part 2: the hunter path. A scheduler tick (no user, no session) advances agent runs through hunter_* functions.
--   Every hunter_* entry point is SECURITY DEFINER, granted to anon only, and first checks scheduler_authorized() (the
--   E1 token; 42501 otherwise). A call names (p_tick, p_run): the tick must be open, the run must belong to a
--   non-archived hunter in the same workspace, and every write needs the run's step lease held by that tick.
--   Nothing here reads or writes anything outside the named run (and, through it, its workspace).
-- =====================================================================================================================

-- Deleting an agent never leaves an approved run behind that something could drive. The run is cancelled (its
-- candidates and leads stay: they are the work, and deleting an agent must not delete LEADS).
create or replace function public.cancel_agent_runs_on_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.research_runs r
     set status = 'cancelled'
   where r.agent_id = old.id and r.status in ('ready', 'running', 'paused');
  return old;
end;
$$;

drop trigger if exists cancel_agent_runs_on_delete on public.agents;
create trigger cancel_agent_runs_on_delete
  before delete on public.agents
  for each row execute function public.cancel_agent_runs_on_delete();

-- A page can no longer take the step lease of an agent run (agent runs are driven by the tick only).
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
     and r.agent_id is null
     and public.is_workspace_sender(r.workspace_id)
     and (r.locked_until is null or r.locked_until < now() or r.locked_by = p_holder);
  return found;
end;
$$;

-- ---------------------------------------------------------------- heartbeat: one tick at a time
create table if not exists public.hunter_ticks (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  lease_until timestamptz not null,
  finished_at timestamptz,
  counts jsonb not null default '{}'::jsonb,
  -- a short code only (never a raw message): R10
  error text constraint hunter_ticks_error check (char_length(error) <= 60)
);
create index if not exists hunter_ticks_started_idx on public.hunter_ticks (started_at desc);

alter table public.hunter_ticks enable row level security;
alter table public.hunter_ticks force row level security;
revoke all on table public.hunter_ticks from public, anon, authenticated;

-- ---------------------------------------------------------------- AI: reserve / settle move into *_core
-- Not SECURITY DEFINER: they run with the rights of the definer function that calls them. p_uid is the person charged
-- (auth.uid() on the user path, the agent's creator on the hunter path). Membership is checked by the callers.
create or replace function public.reserve_ai_call_core(
  p_uid uuid,
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
set search_path = ''
as $$
declare
  v_lim public.ai_limits%rowtype;
  v_ws_cap numeric;
  v_spent numeric;
  v_run public.research_runs%rowtype;
  v_id uuid;
begin
  if p_uid is null or not exists (select 1 from public.ai_access a where a.user_id = p_uid) then
    raise exception 'ai_cap:no_access' using errcode = '42501';
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
    into v_spent from public.ai_calls c where c.user_id = p_uid and c.created_at >= public.ai_day_start();
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

  insert into public.ai_calls (workspace_id, run_id, user_id, task, model, prompt_version, status, reserve_usd)
  values (p_workspace, p_run, p_uid, p_task, p_model, p_prompt_version, 'pending', p_reserve_usd)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.settle_ai_call_core(
  p_uid uuid,
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
set search_path = ''
as $$
declare
  v_max numeric;
begin
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
   where c.id = p_id and c.user_id = p_uid and c.status = 'pending';
  if not found then
    raise exception 'ai call is not a pending call of this user' using errcode = '42501';
  end if;
end;
$$;

-- The session never names who is charged: the hunter path has no session, so the stamp keeps a user the definer
-- function wrote (clients have no INSERT grant on ai_calls at all) and falls back to the session user otherwise.
create or replace function public.stamp_ai_call()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.user_id := coalesce(auth.uid(), new.user_id);
  new.created_at := now();
  return new;
end;
$$;

-- Same signatures and grants as 0004, now sender-only (owner and sdr; a closer cannot spend the workspace AI cap).
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
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not exists (select 1 from public.ai_access a where a.user_id = auth.uid()) then
    raise exception 'ai_cap:no_access' using errcode = '42501';
  end if;
  if not public.is_workspace_member(p_workspace) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  if not public.is_workspace_sender(p_workspace) then
    raise exception 'not allowed: only owner and sdr spend AI' using errcode = '42501';
  end if;
  return public.reserve_ai_call_core(auth.uid(), p_workspace, p_run, p_task, p_model, p_prompt_version, p_reserve_usd, p_user_cap_usd, p_global_cap_usd);
end;
$$;

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
  v_ws uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select c.workspace_id into v_ws from public.ai_calls c where c.id = p_id and c.user_id = auth.uid() and c.status = 'pending';
  if v_ws is null or not public.is_workspace_sender(v_ws) then
    raise exception 'ai call is not a pending call of this user' using errcode = '42501';
  end if;
  perform public.settle_ai_call_core(auth.uid(), p_id, p_status, p_input_tokens, p_output_tokens, p_cache_read_tokens,
                                     p_cache_write_tokens, p_web_searches, p_web_fetches, p_cost_usd, p_error, p_duration_ms);
end;
$$;

-- Today's spend and the ledger are for owner and sdr too (the closer has no AI screen).
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
  if not public.is_workspace_sender(p_workspace) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return coalesce((
    select sum(case when c.status = 'pending' then greatest(c.reserve_usd, c.cost_usd) else c.cost_usd end)
    from public.ai_calls c
    where c.workspace_id = p_workspace and c.created_at >= public.ai_day_start()
  ), 0);
end;
$$;

drop policy if exists ai_calls_select on public.ai_calls;
create policy ai_calls_select on public.ai_calls
  for select to authenticated using (public.is_workspace_sender(workspace_id));
-- Clients have no INSERT policy on ai_calls at all (0004): rows come only from reserve_ai_call_core.
drop policy if exists ai_calls_insert on public.ai_calls;

-- ---------------------------------------------------------------- internal helpers (no grants)
-- Rejects a patch that is not an object or has a key outside the allowed list (22023).
create or replace function public.hunter_check_keys(p_patch jsonb, p_allowed text[])
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'patch must be an object' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p_patch) loop
    if not (k = any (p_allowed)) then
      raise exception 'field not allowed in a patch: %', k using errcode = '22023';
    end if;
  end loop;
end;
$$;

-- Scope of one call: token, open tick, a run of a non-archived hunter in the run's workspace. A write also needs the run
-- to be alive (a cancelled, done or failed run takes no write even while its lease has not run out) and the step lease
-- held by this tick. Returns the workspace id. Not SECURITY DEFINER: it runs with the rights of the entry point.
create or replace function public.hunter_assert(p_tick uuid, p_run uuid, p_write boolean)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v record;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from public.hunter_ticks t where t.id = p_tick and t.finished_at is null and t.lease_until > now()) then
    raise exception 'tick is not open' using errcode = '55000';
  end if;
  select r.workspace_id, r.status, r.locked_by, r.locked_until into v
    from public.research_runs r
    join public.agents a on a.id = r.agent_id
   where r.id = p_run and a.type = 'hunter' and a.archived_at is null and a.workspace_id = r.workspace_id;
  if not found then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_write then
    if v.status not in ('ready', 'running', 'paused') then
      raise exception 'run is not active' using errcode = '55000';
    end if;
    if v.locked_by is distinct from p_tick or v.locked_until is null or v.locked_until <= now() then
      raise exception 'step lease not held' using errcode = '55000';
    end if;
  end if;
  return v.workspace_id;
end;
$$;

-- ---------------------------------------------------------------- tick
create or replace function public.hunter_begin_tick()
returns jsonb
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
  perform pg_advisory_xact_lock(hashtext('hunter:tick'));
  delete from public.hunter_ticks where started_at < now() - interval '30 days';
  if exists (select 1 from public.hunter_ticks t where t.finished_at is null and t.lease_until > now()) then
    return jsonb_build_object('tick_id', null, 'busy', true);
  end if;
  -- a tick whose lease ran out without reporting (crash, timeout) is closed as an error
  update public.hunter_ticks set finished_at = now(), error = 'lease_expired' where finished_at is null;
  insert into public.hunter_ticks (lease_until) values (now() + interval '330 seconds') returning id into v_id;
  return jsonb_build_object('tick_id', v_id, 'busy', false);
end;
$$;

create or replace function public.hunter_finish_tick(p_tick uuid, p_counts jsonb, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_counts jsonb;
  v_n integer;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- only small numbers under short keys are kept (ids, times, counts: R10)
  select coalesce(jsonb_object_agg(e.key, least(greatest((e.value #>> '{}')::numeric, 0), 100000)), '{}'::jsonb) into v_counts
    from (
      select j.key, j.value
        from jsonb_each(case when jsonb_typeof(p_counts) = 'object' then p_counts else '{}'::jsonb end) j
       where jsonb_typeof(j.value) = 'number' and j.key ~ '^[a-zA-Z_]{1,30}$'
       limit 10
    ) e;
  update public.hunter_ticks t
     set finished_at = now(), counts = v_counts, error = left(p_error, 60)
   where t.id = p_tick and t.finished_at is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'tick is not open' using errcode = '55000';
  end if;
  -- no step lease outlives its tick
  update public.research_runs r set locked_until = null, locked_by = null where r.locked_by = p_tick;
end;
$$;

-- What to do now: end finished once-agents, resume runs the cap paused, create the runs that are due, list the runs to advance.
create or replace function public.hunter_due_work(p_tick uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a record;
  s record;
  v_rigor text;
  v_caps jsonb;
  v_ids jsonb;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from public.hunter_ticks t where t.id = p_tick and t.finished_at is null and t.lease_until > now()) then
    raise exception 'tick is not open' using errcode = '55000';
  end if;

  -- (a) a once-agent whose run ended is done
  update public.agents g
     set status = 'done'
   where g.type = 'hunter' and g.status = 'running' and g.archived_at is null and g.schedule = 'once'
     and exists (select 1 from public.research_runs r where r.agent_id = g.id)
     and not exists (select 1 from public.research_runs r where r.agent_id = g.id and r.status in ('ready', 'running', 'paused'));

  -- (b) a run the cap paused goes on when its agent was turned on again
  update public.research_runs r
     set status = 'running', progress = r.progress - 'pauseReason'
    from public.agents g
   where r.agent_id = g.id and r.status = 'paused'
     and g.type = 'hunter' and g.status = 'running' and g.archived_at is null and g.workspace_id = r.workspace_id;

  -- (c) the runs that are due: one approved run per running agent, from its setup plan, with the fixed caps
  for a in
    select g.*
      from public.agents g
     where g.type = 'hunter' and g.status = 'running' and g.archived_at is null
       and g.next_run_at is not null and g.next_run_at <= now()
       and not exists (select 1 from public.research_runs r where r.agent_id = g.id and r.status in ('ready', 'running', 'paused'))
     order by g.next_run_at, g.id
       for update of g skip locked
  loop
    select r.* into s
      from public.research_runs r
     where r.setup_agent_id = a.id and r.workspace_id = a.workspace_id and r.status = 'plan' and r.plan is not null;
    if a.created_by is null then
      update public.agents g set status = 'paused', paused_reason = 'no_access' where g.id = a.id;
    elsif s.id is null then
      update public.agents g set status = 'paused', paused_reason = 'error' where g.id = a.id;
    else
      v_rigor := case when a.config ->> 'rigor' in ('quick', 'careful', 'strict') then a.config ->> 'rigor' else 'careful' end;
      v_caps := public.hunter_caps(v_rigor);
      insert into public.research_runs (workspace_id, title, request_text, region_text, rigor, status, questions, answers,
                                        adjustments, plan, max_candidates, max_cost_usd, max_minutes, agent_id)
      values (a.workspace_id, left(a.name, 100) || ' · ' || to_char(now(), 'DD/MM'), s.request_text, s.region_text, v_rigor, 'ready',
              s.questions, s.answers, s.adjustments, s.plan, (v_caps ->> 'maxCandidates')::integer,
              (v_caps ->> 'maxCostUsd')::numeric, (v_caps ->> 'maxMinutes')::integer, a.id);
      update public.agents g
         set next_run_at = case a.schedule
               when 'weekly' then now() + interval '7 days'
               when 'daily' then now() + interval '1 day'
               else null end
       where g.id = a.id;
    end if;
  end loop;

  -- (d) the runs to advance now: oldest first, at most 3, not held by anyone else
  select coalesce(jsonb_agg(t.id order by t.updated_at, t.id), '[]'::jsonb) into v_ids
    from (
      select r.id, r.updated_at
        from public.research_runs r
        join public.agents g on g.id = r.agent_id
       where g.type = 'hunter' and g.status = 'running' and g.archived_at is null and g.workspace_id = r.workspace_id
         and r.status in ('ready', 'running')
         and (r.locked_until is null or r.locked_until < now() or r.locked_by = p_tick)
       order by r.updated_at, r.id
       limit 3
    ) t;
  return jsonb_build_object('run_ids', v_ids);
end;
$$;

-- ---------------------------------------------------------------- step lease
create or replace function public.hunter_claim_step(p_tick uuid, p_run uuid, p_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform public.hunter_assert(p_tick, p_run, false);
  -- a new step starts only for a running agent and a live run; a lease held by someone else (an unexpired one) refuses
  update public.research_runs r
     set locked_until = now() + make_interval(secs => least(greatest(coalesce(p_seconds, 60), 10), 900)),
         locked_by = p_tick
    from public.agents g
   where r.id = p_run and g.id = r.agent_id and g.status = 'running' and g.archived_at is null
     and r.status in ('ready', 'running')
     and (r.locked_until is null or r.locked_until < now() or r.locked_by = p_tick);
  return found;
end;
$$;

create or replace function public.hunter_release_step(p_tick uuid, p_run uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform public.hunter_assert(p_tick, p_run, false);
  update public.research_runs r set locked_until = null, locked_by = null where r.id = p_run and r.locked_by = p_tick;
end;
$$;

-- ---------------------------------------------------------------- reads (scope: the named run and its workspace)
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
             'agent_id', r.agent_id)
      from public.research_runs r
     where r.id = p_run
  );
end;
$$;

create or replace function public.hunter_profile(p_tick uuid, p_run uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_ws := public.hunter_assert(p_tick, p_run, false);
  return (
    select jsonb_build_object('what_we_do', p.what_we_do, 'service_area', p.service_area, 'wanted_work', p.wanted_work,
                              'good_customer', p.good_customer, 'not_wanted', p.not_wanted)
      from public.company_profiles p
     where p.workspace_id = v_ws
  );
end;
$$;

create or replace function public.hunter_sources(p_tick uuid, p_run uuid)
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
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', s.id, 'run_id', s.run_id, 'kind', s.kind, 'title', s.title, 'url', s.url,
                                         'status', s.status, 'note', s.note) order by s.created_at, s.id)
      from public.research_sources s
     where s.run_id = p_run
  ), '[]'::jsonb);
end;
$$;

create or replace function public.hunter_candidates(p_tick uuid, p_run uuid)
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
  return coalesce((
    select jsonb_agg(to_jsonb(c) - array['workspace_id', 'domain_key', 'phone_key', 'lead_id', 'created_at'] order by c.created_at, c.id)
      from public.research_candidates c
     where c.run_id = p_run
  ), '[]'::jsonb);
end;
$$;

create or replace function public.hunter_checks(p_tick uuid, p_run uuid)
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
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', k.id, 'candidate_id', k.candidate_id, 'kind', k.kind, 'pass', k.pass, 'result', k.result, 'summary', k.summary,
             'evidence', coalesce((
               select jsonb_agg(jsonb_build_object('url', e.url, 'title', e.title, 'excerpt', e.excerpt, 'seen_at', e.seen_at)
                                order by e.created_at, e.id)
                 from public.research_evidence e
                where e.check_id = k.id), '[]'::jsonb)) order by k.created_at, k.id)
      from public.research_checks k
     where k.run_id = p_run
  ), '[]'::jsonb);
end;
$$;

create or replace function public.hunter_jobs(p_tick uuid, p_run uuid)
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
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', j.id, 'run_id', j.run_id, 'address', j.address, 'project_name', j.project_name,
                                         'job_type', j.job_type, 'declared_value_usd', j.declared_value_usd, 'job_date', j.job_date,
                                         'source_url', j.source_url, 'excerpt', j.excerpt, 'seen_at', j.seen_at)
                     order by j.created_at, j.id)
      from public.research_jobs j
     where j.run_id = p_run
  ), '[]'::jsonb);
end;
$$;

-- Companies already in LEADS for the run's workspace (their best candidate), newest first, at most 2000. Leads this
-- very run created are left out: they are the run's own candidates, not something it already knew.
create or replace function public.hunter_known_companies(p_tick uuid, p_run uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_ws := public.hunter_assert(p_tick, p_run, false);
  return coalesce((
    select jsonb_agg(jsonb_build_object('name', x.name, 'website', x.website, 'phone', x.phone) order by x.last_seen_at desc, x.id)
      from (
        select l.id, l.last_seen_at, c.name, c.website, c.phone
          from public.leads l
          join public.research_candidates c on c.id = l.best_candidate_id
         where l.workspace_id = v_ws and l.origin_run_id is distinct from p_run
         order by l.last_seen_at desc, l.id
         limit 2000
      ) x
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------- writes (the step lease must be held by this tick)
create or replace function public.hunter_update_run(p_tick uuid, p_run uuid, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cur public.research_runs;
  v_new public.research_runs;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform public.hunter_assert(p_tick, p_run, true);
  perform public.hunter_check_keys(p_patch, array['status', 'progress', 'is_partial', 'partial_reason', 'limits_notes', 'error']);
  select * into v_cur from public.research_runs r where r.id = p_run;
  v_new := jsonb_populate_record(v_cur, p_patch);
  update public.research_runs r
     set status = v_new.status, progress = v_new.progress, is_partial = v_new.is_partial,
         partial_reason = v_new.partial_reason, limits_notes = v_new.limits_notes, error = v_new.error
   where r.id = p_run;
end;
$$;

create or replace function public.hunter_add_sources(p_tick uuid, p_run uuid, p_rows jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_ws := public.hunter_assert(p_tick, p_run, true);
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 200 then
    raise exception 'rows must be an array of at most 200' using errcode = '22023';
  end if;
  insert into public.research_sources (workspace_id, run_id, kind, title, url, status, note)
  select v_ws, p_run, x.kind, x.title, x.url, x.status, coalesce(x.note, '')
    from jsonb_to_recordset(p_rows) as x(kind text, title text, url text, status text, note text);
end;
$$;

create or replace function public.hunter_add_candidates(p_tick uuid, p_run uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  v_out jsonb;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_ws := public.hunter_assert(p_tick, p_run, true);
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 200 then
    raise exception 'rows must be an array of at most 200' using errcode = '22023';
  end if;
  with ins as (
    insert into public.research_candidates (workspace_id, run_id, name, name_key, city, state, region, website, phone,
                                            company_type, size_note, notes, entry_path, found_at_url, found_at_title,
                                            found_at_excerpt, found_at_seen_at, phone_source_url)
    select v_ws, p_run, x.name, x.name_key, x.city, x.state, x.region, x.website, x.phone,
           coalesce(x.company_type, 'other'), x.size_note, x.notes, x.entry_path, x.found_at_url, x.found_at_title,
           x.found_at_excerpt, x.found_at_seen_at, x.phone_source_url
      from jsonb_to_recordset(p_rows) as x(name text, name_key text, city text, state text, region text, website text,
                                           phone text, company_type text, size_note text, notes text, entry_path text,
                                           found_at_url text, found_at_title text, found_at_excerpt text,
                                           found_at_seen_at timestamptz, phone_source_url text)
    on conflict on constraint research_candidates_unique_name do nothing
    returning *
  )
  select coalesce(jsonb_agg(to_jsonb(ins) - array['workspace_id', 'domain_key', 'phone_key', 'lead_id', 'created_at']), '[]'::jsonb)
    into v_out from ins;
  return v_out;
end;
$$;

create or replace function public.hunter_update_candidate(p_tick uuid, p_run uuid, p_candidate uuid, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cur public.research_candidates;
  v_new public.research_candidates;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform public.hunter_assert(p_tick, p_run, true);
  -- the CandidatePatch columns of rows.ts, without user_decision (that one is the person's)
  perform public.hunter_check_keys(p_patch, array[
    'city', 'state', 'region', 'website', 'phone', 'public_email', 'email_type', 'company_type', 'size_note', 'temperature',
    'approach', 'ask_for_name', 'ask_for_title', 'name_confidence', 'name_source_url', 'name_note', 'permit_count',
    'total_value_usd', 'last_permit_date', 'biggest_job_address', 'biggest_job_value_usd', 'biggest_job_type',
    'biggest_job_description', 'signal_match', 'google_rating', 'review_count', 'hook', 'supplier_portal_url', 'notes',
    'second_pass', 'is_partial', 'verified_at', 'phone_source_url', 'email_source_url', 'rating_source_url']);
  select * into v_cur from public.research_candidates c where c.id = p_candidate and c.run_id = p_run;
  if v_cur.id is null then
    raise exception 'candidate not found' using errcode = '42501';
  end if;
  v_new := jsonb_populate_record(v_cur, p_patch);
  update public.research_candidates c
     set city = v_new.city, state = v_new.state, region = v_new.region, website = v_new.website, phone = v_new.phone,
         public_email = v_new.public_email, email_type = v_new.email_type, company_type = v_new.company_type,
         size_note = v_new.size_note, temperature = v_new.temperature, approach = v_new.approach,
         ask_for_name = v_new.ask_for_name, ask_for_title = v_new.ask_for_title, name_confidence = v_new.name_confidence,
         name_source_url = v_new.name_source_url, name_note = v_new.name_note, permit_count = v_new.permit_count,
         total_value_usd = v_new.total_value_usd, last_permit_date = v_new.last_permit_date,
         biggest_job_address = v_new.biggest_job_address, biggest_job_value_usd = v_new.biggest_job_value_usd,
         biggest_job_type = v_new.biggest_job_type, biggest_job_description = v_new.biggest_job_description,
         signal_match = v_new.signal_match, google_rating = v_new.google_rating, review_count = v_new.review_count,
         hook = v_new.hook, supplier_portal_url = v_new.supplier_portal_url, notes = v_new.notes,
         second_pass = v_new.second_pass, is_partial = v_new.is_partial, verified_at = v_new.verified_at,
         phone_source_url = v_new.phone_source_url, email_source_url = v_new.email_source_url,
         rating_source_url = v_new.rating_source_url
   where c.id = p_candidate and c.run_id = p_run;
end;
$$;

-- Same upsert as add_research_check (a retried step replaces the check and its evidence).
create or replace function public.hunter_add_check(
  p_tick uuid,
  p_run uuid,
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
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_ws := public.hunter_assert(p_tick, p_run, true);
  if not exists (select 1 from public.research_candidates c where c.id = p_candidate and c.run_id = p_run) then
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
    values (v_ws, v_id, e ->> 'url', coalesce(e ->> 'title', ''), coalesce(e ->> 'excerpt', ''),
            coalesce((e ->> 'seen_at')::timestamptz, now()));
  end loop;
  return v_id;
end;
$$;

create or replace function public.hunter_add_jobs(p_tick uuid, p_run uuid, p_jobs jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  v_n integer;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_ws := public.hunter_assert(p_tick, p_run, true);
  if p_jobs is null or jsonb_typeof(p_jobs) <> 'array' or jsonb_array_length(p_jobs) > 200 then
    raise exception 'jobs must be an array of at most 200' using errcode = '22023';
  end if;
  insert into public.research_jobs (workspace_id, run_id, address, project_name, job_type, declared_value_usd, job_date, source_url, excerpt, seen_at)
  select v_ws, p_run, j ->> 'address', j ->> 'project_name', j ->> 'job_type', (j ->> 'declared_value_usd')::numeric,
         (j ->> 'job_date')::date, j ->> 'source_url', coalesce(j ->> 'excerpt', ''), coalesce((j ->> 'seen_at')::timestamptz, now())
    from jsonb_array_elements(p_jobs) j
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- The agent stops itself (an AI ceiling, no access, bad config): the agent pauses with the reason, its running run pauses too.
-- Only a live run of a running agent; no step lease is needed (the cap is found inside a step, and the run may be released).
create or replace function public.hunter_pause_agent(p_tick uuid, p_run uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent uuid;
  v_status text;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform public.hunter_assert(p_tick, p_run, false);
  if p_reason is null or p_reason not in ('daily_cap', 'user_cap', 'global_cap', 'no_access', 'error') then
    raise exception 'invalid pause reason' using errcode = '22023';
  end if;
  select r.agent_id, r.status into v_agent, v_status from public.research_runs r where r.id = p_run;
  if v_status not in ('ready', 'running', 'paused') then
    raise exception 'run is not active' using errcode = '55000';
  end if;
  update public.agents g set status = 'paused', paused_reason = p_reason where g.id = v_agent and g.status = 'running';
  update public.research_runs r
     set status = 'paused', progress = r.progress || jsonb_build_object('pauseReason', p_reason)
   where r.id = p_run and r.status = 'running';
end;
$$;

-- ---------------------------------------------------------------- AI on the hunter path (charged to the agent's creator)
create or replace function public.hunter_reserve_ai_call(
  p_tick uuid,
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
  v_ws uuid;
  v_uid uuid;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_ws := public.hunter_assert(p_tick, p_run, true);
  -- Only a running run reserves: a step still in flight after a client pause must not reserve past the run's caps
  -- (the core applies the run caps only while the run is running).
  if not exists (select 1 from public.research_runs r where r.id = p_run and r.status = 'running') then
    raise exception 'run is not running' using errcode = '55000';
  end if;
  select a.created_by into v_uid
    from public.research_runs r join public.agents a on a.id = r.agent_id
   where r.id = p_run;
  -- the creator must still be owner or sdr of the workspace; otherwise nothing is reserved
  if v_uid is null or not exists (
       select 1 from public.workspace_members m where m.workspace_id = v_ws and m.user_id = v_uid and m.role in ('owner', 'sdr')) then
    raise exception 'ai_cap:no_access' using errcode = '42501';
  end if;
  return public.reserve_ai_call_core(v_uid, v_ws, p_run, p_task, p_model, p_prompt_version, p_reserve_usd, p_user_cap_usd, p_global_cap_usd);
end;
$$;

-- Settling needs no live run and no live agent: a call in flight when the run was cancelled, or its agent archived or
-- deleted, still records its cost. The ledger row must be this run's pending row and the run must be an agent run:
-- its agent is a hunter of the workspace (archived or not), or the agent was deleted (agent_id null and the delete
-- trigger cancelled the run). The person charged is the one stored on the row at reserve time.
create or replace function public.hunter_settle_ai_call(
  p_tick uuid,
  p_run uuid,
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
  v_uid uuid;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from public.hunter_ticks t where t.id = p_tick and t.finished_at is null and t.lease_until > now()) then
    raise exception 'tick is not open' using errcode = '55000';
  end if;
  select c.user_id into v_uid
    from public.ai_calls c
    join public.research_runs r on r.id = c.run_id
    left join public.agents a on a.id = r.agent_id
   where c.id = p_id and c.run_id = p_run and c.status = 'pending' and c.workspace_id = r.workspace_id
     and ((a.type = 'hunter' and a.workspace_id = r.workspace_id) or (r.agent_id is null and r.status = 'cancelled'));
  if v_uid is null then
    raise exception 'ai call is not a pending call of this run' using errcode = '42501';
  end if;
  perform public.settle_ai_call_core(v_uid, p_id, p_status, p_input_tokens, p_output_tokens, p_cache_read_tokens,
                                     p_cache_write_tokens, p_web_searches, p_web_fetches, p_cost_usd, p_error, p_duration_ms);
end;
$$;

-- ---------------------------------------------------------------- grants
-- Internal: nobody calls these directly.
revoke all on function public.cancel_agent_runs_on_delete() from public, anon, authenticated;
revoke all on function public.reserve_ai_call_core(uuid, uuid, uuid, text, text, text, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function public.settle_ai_call_core(uuid, uuid, text, integer, integer, integer, integer, integer, integer, numeric, text, integer) from public, anon, authenticated;
revoke all on function public.hunter_check_keys(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.hunter_assert(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.stamp_ai_call() from public, anon, authenticated;
-- Client wrappers keep their grants (replaced above with the same signatures).
revoke all on function public.reserve_ai_call(uuid, uuid, text, text, text, numeric, numeric, numeric) from public, anon;
revoke all on function public.settle_ai_call(uuid, text, integer, integer, integer, integer, integer, integer, numeric, text, integer) from public, anon;
revoke all on function public.ai_spend_today(uuid) from public, anon;
revoke all on function public.claim_research_step(uuid, uuid, integer) from public, anon;
grant execute on function public.reserve_ai_call(uuid, uuid, text, text, text, numeric, numeric, numeric) to authenticated;
grant execute on function public.settle_ai_call(uuid, text, integer, integer, integer, integer, integer, integer, numeric, text, integer) to authenticated;
grant execute on function public.ai_spend_today(uuid) to authenticated;
grant execute on function public.claim_research_step(uuid, uuid, integer) to authenticated;

-- Only anon (the public key the route uses) may call hunter_*, and each of them refuses without the scheduler token.
revoke all on function public.hunter_begin_tick() from public, anon, authenticated;
revoke all on function public.hunter_finish_tick(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.hunter_due_work(uuid) from public, anon, authenticated;
revoke all on function public.hunter_claim_step(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.hunter_release_step(uuid, uuid) from public, anon, authenticated;
revoke all on function public.hunter_get_run(uuid, uuid) from public, anon, authenticated;
revoke all on function public.hunter_profile(uuid, uuid) from public, anon, authenticated;
revoke all on function public.hunter_sources(uuid, uuid) from public, anon, authenticated;
revoke all on function public.hunter_candidates(uuid, uuid) from public, anon, authenticated;
revoke all on function public.hunter_checks(uuid, uuid) from public, anon, authenticated;
revoke all on function public.hunter_jobs(uuid, uuid) from public, anon, authenticated;
revoke all on function public.hunter_known_companies(uuid, uuid) from public, anon, authenticated;
revoke all on function public.hunter_update_run(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.hunter_add_sources(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.hunter_add_candidates(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.hunter_update_candidate(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.hunter_add_check(uuid, uuid, uuid, text, integer, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.hunter_add_jobs(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.hunter_pause_agent(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.hunter_reserve_ai_call(uuid, uuid, text, text, text, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function public.hunter_settle_ai_call(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer, numeric, text, integer) from public, anon, authenticated;

grant execute on function public.hunter_begin_tick() to anon;
grant execute on function public.hunter_finish_tick(uuid, jsonb, text) to anon;
grant execute on function public.hunter_due_work(uuid) to anon;
grant execute on function public.hunter_claim_step(uuid, uuid, integer) to anon;
grant execute on function public.hunter_release_step(uuid, uuid) to anon;
grant execute on function public.hunter_get_run(uuid, uuid) to anon;
grant execute on function public.hunter_profile(uuid, uuid) to anon;
grant execute on function public.hunter_sources(uuid, uuid) to anon;
grant execute on function public.hunter_candidates(uuid, uuid) to anon;
grant execute on function public.hunter_checks(uuid, uuid) to anon;
grant execute on function public.hunter_jobs(uuid, uuid) to anon;
grant execute on function public.hunter_known_companies(uuid, uuid) to anon;
grant execute on function public.hunter_update_run(uuid, uuid, jsonb) to anon;
grant execute on function public.hunter_add_sources(uuid, uuid, jsonb) to anon;
grant execute on function public.hunter_add_candidates(uuid, uuid, jsonb) to anon;
grant execute on function public.hunter_update_candidate(uuid, uuid, uuid, jsonb) to anon;
grant execute on function public.hunter_add_check(uuid, uuid, uuid, text, integer, text, text, jsonb) to anon;
grant execute on function public.hunter_add_jobs(uuid, uuid, jsonb) to anon;
grant execute on function public.hunter_pause_agent(uuid, uuid, text) to anon;
grant execute on function public.hunter_reserve_ai_call(uuid, uuid, text, text, text, numeric, numeric, numeric) to anon;
grant execute on function public.hunter_settle_ai_call(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer, numeric, text, integer) to anon;
