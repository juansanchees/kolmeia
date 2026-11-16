-- 0032 Learning loop: the Caçador learns from results (docs/superpowers/specs/2026-11-16-learning-loop-design.md).
--   * learned_profiles.source: 'list' (a training list, 0015) or 'results' (lead outcomes). A results proposal has no
--     import and goes through the same propose -> approve flow: nothing applies until a sender approves it.
--   * learned_profile_valid (0015) also accepts points with key 'avoid' ("what did not work"). profile_hints_of already
--     turns every point into a "<key>: <text>" line, so approved avoid points reach the collect prompt as hints.
--   * results_rows_core(ws): the leads with a result (newest 300 positive-ish and 300 negative-ish), what the AI reads
--     about each, when results were last learned (results_last_at), the open results proposal and the current
--     approved profile.
--     The app labels them (src/lib/learning/results.ts): positive = meeting, won, or an e-mail reply classified
--     'interested' on a lead not lost/discarded; negative = lost, discarded; anything else is not returned.
--   * Two doors to the same core: the sender's session (results_learning_rows, propose_results_profile) and the
--     Caçador clock (hunter_results_*: scheduler token, open hunter tick; the AI call is charged to the workspace's
--     owner who has AI access). One open results proposal per workspace at a time.
-- Depends on 0001-0031. Re-runnable.

alter table public.learned_profiles
  add column if not exists source text not null default 'list';
alter table public.learned_profiles drop constraint if exists learned_profiles_source;
alter table public.learned_profiles
  add constraint learned_profiles_source check (source in ('list', 'results'));
create index if not exists learned_profiles_results_idx on public.learned_profiles (workspace_id, created_at desc) where source = 'results';

-- 0015's body, with 'avoid' added to the point keys (nothing else changed).
create or replace function public.learned_profile_valid(p_profile jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  pt jsonb;
  r jsonb;
  e jsonb;
begin
  if p_profile is null or jsonb_typeof(p_profile) is distinct from 'object' then
    return false;
  end if;
  -- points
  if jsonb_typeof(p_profile -> 'points') is distinct from 'array' or jsonb_array_length(p_profile -> 'points') > 12 then
    return false;
  end if;
  for pt in select x from jsonb_array_elements(p_profile -> 'points') x loop
    if jsonb_typeof(pt) is distinct from 'object'
       or jsonb_typeof(pt -> 'key') is distinct from 'string'
       or (pt ->> 'key') not in ('type', 'size', 'region', 'projects', 'signals', 'where_to_find', 'avoid')
       or jsonb_typeof(pt -> 'text') is distinct from 'string'
       or char_length(pt ->> 'text') not between 1 and 200
       or jsonb_typeof(pt -> 'rows') is distinct from 'array'
       or jsonb_array_length(pt -> 'rows') not between 1 and 20 then
      return false;
    end if;
    for r in select x from jsonb_array_elements(pt -> 'rows') x loop
      if jsonb_typeof(r) is distinct from 'number' or (r #>> '{}') !~ '^[0-9]{1,4}$' or (r #>> '{}')::integer not between 1 and 5001 then
        return false;
      end if;
    end loop;
  end loop;
  -- filter
  if jsonb_typeof(p_profile -> 'filter') is distinct from 'object'
     or jsonb_typeof(p_profile -> 'filter' -> 'companyTypes') is distinct from 'array'
     or jsonb_typeof(p_profile -> 'filter' -> 'towns') is distinct from 'array'
     or jsonb_array_length(p_profile -> 'filter' -> 'towns') > 60 then
    return false;
  end if;
  for e in select x from jsonb_array_elements(p_profile -> 'filter' -> 'companyTypes') x loop
    if jsonb_typeof(e) is distinct from 'string' or (e #>> '{}') not in ('builder', 'developer', 'property_manager', 'other') then
      return false;
    end if;
  end loop;
  for e in select x from jsonb_array_elements(p_profile -> 'filter' -> 'towns') x loop
    if jsonb_typeof(e) is distinct from 'string' or char_length(e #>> '{}') not between 1 and 60 then
      return false;
    end if;
  end loop;
  -- searchQueries: strings, none naming the blocked social network
  if jsonb_typeof(p_profile -> 'searchQueries') is distinct from 'array' or jsonb_array_length(p_profile -> 'searchQueries') > 8 then
    return false;
  end if;
  for e in select x from jsonb_array_elements(p_profile -> 'searchQueries') x loop
    if jsonb_typeof(e) is distinct from 'string' or char_length(e #>> '{}') not between 1 and 120 or (e #>> '{}') ~* 'linked\s*in|lnkd' then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- ---------------------------------------------------------------- the data the learning reads (internal)
-- When results were last learned: the newest results proposal, or the newest results AI call (prompt version
-- 'profile-results-...'), so a call that proposed nothing (or failed) still waits its 7 days. Internal.
create or replace function public.results_last_at(p_ws uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(
    (select max(x.created_at) from public.learned_profiles x where x.workspace_id = p_ws and x.source = 'results'),
    (select max(c.created_at) from public.ai_calls c
      where c.workspace_id = p_ws and c.run_id is null and c.task = 'profile_learn' and c.prompt_version like 'profile-results-%')
  );
$$;

create or replace function public.results_rows_core(p_ws uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with interested as (
    select p.lead_id, max(r.received_at) as at
      from public.email_replies r
      join public.email_prospects p on p.id = r.prospect_id
     where r.workspace_id = p_ws and r.classification = 'interested' and p.lead_id is not null
     group by p.lead_id
  ),
  picked as (
    (select l.*, i.at as interested_at, greatest(l.updated_at, i.at) as labeled_at
       from public.leads l left join interested i on i.lead_id = l.id
      where l.workspace_id = p_ws
        and (l.status in ('meeting', 'won') or (i.at is not null and l.status not in ('lost', 'discarded')))
      order by greatest(l.updated_at, i.at) desc
      limit 300)
    union all
    (select l.*, i.at, greatest(l.updated_at, i.at)
       from public.leads l left join interested i on i.lead_id = l.id
      where l.workspace_id = p_ws and l.status in ('lost', 'discarded')
      order by l.updated_at desc
      limit 300)
  )
  select jsonb_build_object(
    'last_at', public.results_last_at(p_ws),
    'open_id', (select x.id from public.learned_profiles x
                 where x.workspace_id = p_ws and x.source = 'results' and x.status = 'proposed'
                 order by x.created_at desc limit 1),
    'current', (select x.profile from public.learned_profiles x
                 where x.workspace_id = p_ws and x.status = 'approved'
                 order by (x.agent_id is null) desc, x.version desc limit 1),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'lead_id', k.id,
               'status', k.status,
               'interested', k.interested_at is not null,
               'labeled_at', k.labeled_at,
               'name', coalesce(c.name, fv.name),
               'city', coalesce(c.city, fv.city),
               'company_type', coalesce(c.company_type, fv.company_type),
               'segment', k.segment,
               'size_note', c.size_note,
               'biggest_job', c.biggest_job_type,
               'biggest_job_usd', c.biggest_job_value_usd,
               'permits', c.permit_count,
               'origin', coalesce(imp.list_name, k.origin_kind),
               'note', (select g.notes from public.call_logs g
                         where g.lead_id = k.id and g.notes <> '' order by g.called_at desc limit 1))
             order by k.labeled_at desc)
        from picked k
        left join public.research_candidates c on c.id = k.best_candidate_id
        left join public.lead_imports imp on imp.id = k.origin_import_id
        left join lateral (
          select max(f.value) filter (where f.field = 'name') as name,
                 max(f.value) filter (where f.field = 'city') as city,
                 max(f.value) filter (where f.field = 'company_type') as company_type
            from public.lead_fields f
           where k.best_candidate_id is null and f.lead_id = k.id and f.status <> 'refuted'
             and f.field in ('name', 'city', 'company_type')
        ) fv on true
    ), '[]'::jsonb)
  );
$$;

-- One open results proposal per workspace: a second call (two tabs, the clock and a click) gets the open one back.
create or replace function public.propose_results_core(p_ws uuid, p_uid uuid, p_profile jsonb, p_sample_rows integer)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.learned_profile_valid(p_profile) or p_sample_rows is null or p_sample_rows not between 1 and 80 then
    raise exception 'invalid profile' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('learned_profiles:results:' || p_ws::text, 0));
  select x.id into v_id from public.learned_profiles x
   where x.workspace_id = p_ws and x.source = 'results' and x.status = 'proposed'
   order by x.created_at desc limit 1;
  if v_id is not null then
    return v_id;
  end if;
  insert into public.learned_profiles (workspace_id, import_id, profile, original, sample_rows, created_by, source)
  values (p_ws, null, p_profile, p_profile, p_sample_rows, p_uid, 'results')
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- the sender's door
create or replace function public.results_learning_rows(p_ws uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_ws is null or not public.is_workspace_sender(p_ws) then
    raise exception 'sender only' using errcode = '42501';
  end if;
  return public.results_rows_core(p_ws);
end;
$$;

create or replace function public.propose_results_profile(p_ws uuid, p_profile jsonb, p_sample_rows integer)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_ws is null or not public.is_workspace_sender(p_ws) then
    raise exception 'sender only' using errcode = '42501';
  end if;
  return public.propose_results_core(p_ws, auth.uid(), p_profile, p_sample_rows);
end;
$$;

-- ---------------------------------------------------------------- the clock's door
-- The token is checked and the hunter tick is still open (its lease not run out). Internal.
create or replace function public.results_tick_ok(p_tick uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.scheduler_authorized()
     and exists (select 1 from public.hunter_ticks t where t.id = p_tick and t.finished_at is null and t.lease_until > now());
$$;

-- Who pays the clock's call: the workspace's oldest owner with AI access (null = the workspace is skipped). Internal.
create or replace function public.results_payer(p_ws uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id
    from public.workspace_members m
    join public.ai_access a on a.user_id = m.user_id
   where m.workspace_id = p_ws and m.role = 'owner'
   order by m.created_at, m.user_id
   limit 1;
$$;

-- Workspaces worth a look: a Caçador, a payer, no open results proposal, nothing learned in the last 7 days. At most 3, the
-- longest-waiting first. The app applies the full rule (resultsDue) to their rows.
create or replace function public.hunter_results_due(p_tick uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.results_tick_ok(p_tick) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('workspace_id', w.id, 'last_at', w.last_at) order by w.last_at nulls first, w.id)
      from (
        select s.id, public.results_last_at(s.id) as last_at
          from public.workspaces s
         where exists (select 1 from public.agents a where a.workspace_id = s.id and a.type = 'hunter' and a.archived_at is null)
           and public.results_payer(s.id) is not null
           and not exists (select 1 from public.learned_profiles x where x.workspace_id = s.id and x.source = 'results' and x.status = 'proposed')
      ) w
     where w.last_at is null or w.last_at < now() - interval '7 days'
     limit 3
  ), '[]'::jsonb);
end;
$$;

create or replace function public.hunter_results_rows(p_tick uuid, p_ws uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.results_tick_ok(p_tick) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return public.results_rows_core(p_ws);
end;
$$;

create or replace function public.hunter_results_reserve_ai_call(
  p_tick uuid,
  p_ws uuid,
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
  v_uid uuid;
begin
  if not public.results_tick_ok(p_tick) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_task is distinct from 'profile_learn' then
    raise exception 'only the profile task' using errcode = '22023';
  end if;
  v_uid := public.results_payer(p_ws);
  if v_uid is null then
    raise exception 'ai_cap:no_access' using errcode = '42501';
  end if;
  return public.reserve_ai_call_core(v_uid, p_ws, null, p_task, p_model, p_prompt_version, p_reserve_usd, p_user_cap_usd, p_global_cap_usd);
end;
$$;

-- Settles only a pending, run-less profile call; the person charged is the one stored at reserve time.
create or replace function public.hunter_results_settle_ai_call(
  p_tick uuid,
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
  if not public.results_tick_ok(p_tick) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select c.user_id into v_uid from public.ai_calls c
   where c.id = p_id and c.run_id is null and c.task = 'profile_learn' and c.status = 'pending';
  if v_uid is null then
    raise exception 'ai call is not a pending profile call' using errcode = '42501';
  end if;
  perform public.settle_ai_call_core(v_uid, p_id, p_status, p_input_tokens, p_output_tokens, p_cache_read_tokens,
                                     p_cache_write_tokens, p_web_searches, p_web_fetches, p_cost_usd, p_error, p_duration_ms);
end;
$$;

create or replace function public.hunter_propose_results_profile(p_tick uuid, p_ws uuid, p_profile jsonb, p_sample_rows integer)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.results_tick_ok(p_tick) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from public.workspaces s where s.id = p_ws) then
    raise exception 'no workspace' using errcode = '22023';
  end if;
  return public.propose_results_core(p_ws, null, p_profile, p_sample_rows);
end;
$$;

-- ---------------------------------------------------------------- privileges
revoke all on function public.results_last_at(uuid) from public, anon, authenticated;
revoke all on function public.results_rows_core(uuid) from public, anon, authenticated;
revoke all on function public.propose_results_core(uuid, uuid, jsonb, integer) from public, anon, authenticated;
revoke all on function public.results_tick_ok(uuid) from public, anon, authenticated;
revoke all on function public.results_payer(uuid) from public, anon, authenticated;
revoke all on function public.results_learning_rows(uuid) from public, anon;
revoke all on function public.propose_results_profile(uuid, jsonb, integer) from public, anon;
grant execute on function public.results_learning_rows(uuid) to authenticated;
grant execute on function public.propose_results_profile(uuid, jsonb, integer) to authenticated;
-- Only anon (the public key the clock uses) may call hunter_*, and each of them refuses without the scheduler token.
revoke all on function public.hunter_results_due(uuid) from public, anon, authenticated;
revoke all on function public.hunter_results_rows(uuid, uuid) from public, anon, authenticated;
revoke all on function public.hunter_results_reserve_ai_call(uuid, uuid, text, text, text, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function public.hunter_results_settle_ai_call(uuid, uuid, text, integer, integer, integer, integer, integer, integer, numeric, text, integer) from public, anon, authenticated;
revoke all on function public.hunter_propose_results_profile(uuid, uuid, jsonb, integer) from public, anon, authenticated;
grant execute on function public.hunter_results_due(uuid) to anon;
grant execute on function public.hunter_results_rows(uuid, uuid) to anon;
grant execute on function public.hunter_results_reserve_ai_call(uuid, uuid, text, text, text, numeric, numeric, numeric) to anon;
grant execute on function public.hunter_results_settle_ai_call(uuid, uuid, text, integer, integer, integer, integer, integer, integer, numeric, text, integer) to anon;
grant execute on function public.hunter_propose_results_profile(uuid, uuid, jsonb, integer) to anon;
