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
