-- 0039 "Rodar agora": run_hunter_now(agent) queues a hunter run now instead of waiting for its schedule.
--   Owner or sdr of the workspace (the closer is refused). Only a hunter that is paused or running: the clock
--   (hunter_due_work, 0010) then picks it up on its next minute because next_run_at <= now().
--   Returns 'queued', 'already_running' (a live run of this agent, status ready/running/paused: the agent is turned on, next_run_at is not touched) or
--   'too_many' (A7: 3 hunters already running in the workspace; the agent stays paused).
--   guard_agent (0023) resets next_run_at on paused -> running, so the status change and the next_run_at change are
--   two updates. A paused hunter is turned on (Ligar) by this call.
-- Depends on 0001-0038. Re-runnable. One transaction: all or nothing.

begin;

create or replace function public.run_hunter_now(p_agent uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  a record;
begin
  select * into a from public.agents where id = p_agent;
  if a.id is null or auth.uid() is null or not public.is_workspace_sender(a.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if a.type <> 'hunter' then
    raise exception 'only a hunter can run now' using errcode = '22023';
  end if;
  select * into a from public.agents where id = p_agent for update;
  if a.archived_at is not null or a.status not in ('paused', 'running') then
    raise exception 'the agent must be paused or running' using errcode = '55000';
  end if;
  if a.status = 'paused' then
    begin
      update public.agents set status = 'running' where id = p_agent;
    exception when sqlstate '23514' then
      if sqlerrm like 'A7%' then
        return 'too_many';
      end if;
      raise;
    end;
  end if;
  -- the agent is running now, so the clock moves a live run on (a 'paused' run too: a cap pause, 0010); no second run
  if exists (select 1 from public.research_runs r where r.agent_id = p_agent and r.status in ('ready', 'running', 'paused')) then
    return 'already_running';
  end if;
  update public.agents set next_run_at = now() where id = p_agent;
  return 'queued';
end;
$$;

revoke all on function public.run_hunter_now(uuid) from public, anon;
grant execute on function public.run_hunter_now(uuid) to authenticated;

commit;
