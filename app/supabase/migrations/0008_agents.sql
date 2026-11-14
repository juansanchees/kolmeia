-- 0008 Agentes (F2): the agents table, the link from a setup research to its agent, and the owner/sdr role rules.
--   A1 a new agent is a draft, stamped by the database (creator, dates, no next run).
--   A2 a setup run needs a draft hunter of the same workspace, started by owner or sdr; one per agent.
--   A3 draft -> paused only when its setup run has a plan; nothing else changes status in F2.
--   A4 archiving uses the database clock and freezes the agent.
--   A5 a setup run only asks questions and writes a plan (or fails / is cancelled): it can never be approved or run.
--   J2 agents belong to owner and sdr only (is_workspace_sender); the closer sees none.
-- Depends on 0001-0004 (is_workspace_sender / is_client_role come from 0003). Re-runnable.

create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  type text not null
    constraint agents_type check (type in ('hunter', 'email', 'call')),
  name text not null
    constraint agents_name_len check (char_length(btrim(name)) between 1 and 80),
  status text not null default 'draft'
    constraint agents_status check (status in ('draft', 'paused', 'running', 'done')),
  config jsonb not null default '{}'::jsonb
    constraint agents_config_object check (jsonb_typeof(config) = 'object')
    constraint agents_config_size check (octet_length(config::text) <= 16000),
  schedule text not null default 'weekly'
    constraint agents_schedule check (schedule in ('once', 'weekly', 'daily')),
  next_run_at timestamptz,
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agents_workspace_idx on public.agents (workspace_id, created_at desc);

alter table public.research_runs
  add column if not exists setup_agent_id uuid references public.agents (id) on delete set null;

create unique index if not exists research_runs_setup_agent_uidx
  on public.research_runs (setup_agent_id) where setup_agent_id is not null;

-- A1, A3, A4. Not security definer on purpose: is_client_role() reads current_user, and RLS already limits who gets here.
create or replace function public.guard_agent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.status := 'draft';
    new.created_by := auth.uid();
    new.created_at := now();
    new.updated_at := now();
    new.archived_at := null;
    new.next_run_at := null;
    return new;
  end if;

  if old.archived_at is not null then
    raise exception 'A4: an archived agent cannot change' using errcode = '23514';
  end if;
  if new.archived_at is distinct from old.archived_at then
    new.archived_at := now();
  end if;

  if public.is_client_role() and new.status is distinct from old.status then
    if not (
      old.status = 'draft' and new.status = 'paused'
      and exists (
        select 1 from public.research_runs r
         where r.setup_agent_id = new.id and r.status = 'plan' and r.plan is not null
      )
    ) then
      raise exception 'A3: an agent leaves draft only when its setup research has a plan' using errcode = '23514';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists guard_agent on public.agents;
create trigger guard_agent
  before insert or update on public.agents
  for each row execute function public.guard_agent();

-- A2, A5 (not security definer, same reason; the agent lookup runs under RLS as an owner or sdr).
create or replace function public.guard_agent_setup_run()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.setup_agent_id is null then
    return new;
  end if;

  if tg_op = 'INSERT' and public.is_client_role() then
    if not public.is_workspace_sender(new.workspace_id)
       or not exists (
         select 1 from public.agents a
          where a.id = new.setup_agent_id and a.workspace_id = new.workspace_id
            and a.type = 'hunter' and a.status = 'draft' and a.archived_at is null
       ) then
      raise exception 'A2: a setup research needs a draft hunter agent of this workspace' using errcode = '23514';
    end if;
  end if;

  if new.status not in ('questions', 'plan', 'failed', 'cancelled') then
    raise exception 'A5: an agent''s setup research cannot run' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_agent_setup_run on public.research_runs;
create trigger guard_agent_setup_run
  before insert or update on public.research_runs
  for each row execute function public.guard_agent_setup_run();

revoke all on function public.guard_agent() from public, anon, authenticated;
revoke all on function public.guard_agent_setup_run() from public, anon, authenticated;

-- Privileges. status is in the insert list only so a client cannot be refused for naming it: the trigger forces 'draft'.
revoke all on table public.agents from public, anon, authenticated;
grant select on table public.agents to authenticated;
grant insert (workspace_id, type, name, status, config, schedule) on table public.agents to authenticated;
grant update (name, status, config, schedule, archived_at) on table public.agents to authenticated;
grant insert (setup_agent_id) on table public.research_runs to authenticated;

alter table public.agents enable row level security;
alter table public.agents force row level security;

drop policy if exists agents_select on public.agents;
create policy agents_select on public.agents
  for select to authenticated
  using (public.is_workspace_sender(workspace_id));

drop policy if exists agents_insert on public.agents;
create policy agents_insert on public.agents
  for insert to authenticated
  with check (public.is_workspace_sender(workspace_id));

drop policy if exists agents_update on public.agents;
create policy agents_update on public.agents
  for update to authenticated
  using (public.is_workspace_sender(workspace_id))
  with check (public.is_workspace_sender(workspace_id));

-- J2: the company profile is written by owner and sdr; the closer only reads (select policy unchanged).
drop policy if exists company_profiles_insert on public.company_profiles;
create policy company_profiles_insert on public.company_profiles
  for insert to authenticated
  with check (public.is_workspace_sender(workspace_id));

drop policy if exists company_profiles_update on public.company_profiles;
create policy company_profiles_update on public.company_profiles
  for update to authenticated
  using (public.is_workspace_sender(workspace_id))
  with check (public.is_workspace_sender(workspace_id));
