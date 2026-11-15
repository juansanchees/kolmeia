-- 0016 Contact scraper (F3d-2): the Qualificador's step P2b asks Apify's contact scraper for the e-mail a lead's own
-- site shows, when the free reader (P2) found none. Up to 10 leads share one queued run (and its 0.50 minimum charge);
-- the sources clock starts it like any other run (kind 'contact', 0013), and the e-mails come back through
-- source_add_contacts as confirmed lead_fields (source 'apify_contact', source_ref = the page).
--   source_run_leads             which leads a contact run covers (and the site it reads)
--   qualifier_request_contacts   Qualificador path: put a lead in the workspace's open contact run (or open one)
--   source_contact_leads         sources path: the leads of a running contact run
--   source_add_contacts          sources path: store the e-mails and settle the run
--   step p2b                     between p2 and p3 (queue, step log and qualifier_step_done accept it)
--   'apify_contact' values       re-queue a finished lead like an import does (K-4)
-- Depends on 0001-0015. Re-runnable. (There is no 0012 on this branch.)

-- ---------------------------------------------------------------- the step p2b
alter table public.qualifier_queue drop constraint if exists qualifier_queue_next_step;
alter table public.qualifier_queue add constraint qualifier_queue_next_step check (next_step in ('p1', 'p2', 'p2b', 'p3', 'p4', 'p5', 'done'));
alter table public.qualifier_queue drop constraint if exists qualifier_queue_fail_step;
alter table public.qualifier_queue add constraint qualifier_queue_fail_step check (fail_step is null or fail_step in ('p1', 'p2', 'p2b', 'p3', 'p4', 'p5'));
alter table public.qualifier_step_log drop constraint if exists qualifier_step_log_step;
alter table public.qualifier_step_log add constraint qualifier_step_log_step check (step in ('p1', 'p2', 'p2b', 'p3', 'p4', 'p5'));

-- ---------------------------------------------------------------- which leads a contact run covers
create table if not exists public.source_run_leads (
  run_id uuid not null references public.source_runs (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  start_url text not null constraint source_run_leads_url check (char_length(start_url) between 8 and 2000),
  primary key (run_id, lead_id)
);
create index if not exists source_run_leads_lead_idx on public.source_run_leads (lead_id);
revoke all on table public.source_run_leads from public, anon, authenticated;
grant select on table public.source_run_leads to authenticated;
alter table public.source_run_leads enable row level security;
alter table public.source_run_leads force row level security;
drop policy if exists source_run_leads_select on public.source_run_leads;
create policy source_run_leads_select on public.source_run_leads
  for select to authenticated using (exists (select 1 from public.source_runs r where r.id = run_id and public.is_workspace_sender(r.workspace_id)));

-- ---------------------------------------------------------------- re-queue on contact e-mails (K-4)
create or replace function public.requeue_lead_on_import()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.qualifier_queue q
     set next_step = 'p1', done_reason = null, fail_step = null, fail_streak = 0,
         enqueued_at = now(), locked_by = null, locked_until = null
   where q.lead_id = new.lead_id and q.next_step = 'done' and q.done_reason is distinct from 'dead';
  return null;
end;
$$;
drop trigger if exists requeue_lead_on_import on public.lead_fields;
create trigger requeue_lead_on_import
  after insert on public.lead_fields
  for each row
  when (new.source in ('import', 'apify_maps', 'apollo', 'apify_contact'))
  execute function public.requeue_lead_on_import();

-- qualifier_step_done of 0014 with p2b as a step and apify_contact among the values that re-open a claimed lead.
create or replace function public.qualifier_step_done(p_tick uuid, p_lead uuid, p_step text, p_outcome text, p_next text, p_done_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  v_err boolean := p_outcome = 'error';
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_ws := public.qualifier_assert(p_tick, p_lead, true);
  if p_step is null or p_step <> all (array['p1', 'p2', 'p2b', 'p3', 'p4', 'p5']) then
    raise exception 'invalid step' using errcode = '22023';
  end if;
  if p_outcome is null or char_length(p_outcome) not between 1 and 30 then
    raise exception 'invalid outcome' using errcode = '22023';
  end if;
  if p_next is null or p_next <> all (array['p1', 'p2', 'p2b', 'p3', 'p4', 'p5', 'done']) then
    raise exception 'invalid next step' using errcode = '22023';
  end if;
  if p_next = 'done' and (p_done_reason is null or p_done_reason <> all (array['complete', 'lead_cap', 'dead'])) then
    raise exception 'done needs a reason: complete, lead_cap or dead' using errcode = '22023';
  end if;
  insert into public.qualifier_step_log (workspace_id, lead_id, step, outcome) values (v_ws, p_lead, p_step, p_outcome);
  -- imported values that arrived while the lead was claimed (the re-queue trigger only sees finished leads): do not close
  -- Also a manual request that came in while it was claimed (request_qualification wrote manual_at after the claim): it
  -- keeps manual_at and deep_requested (strictly after the claim: a same-instant tie is not a second request, so it never
  -- causes a second paid pass). A dead lead stays dead.
  if p_next = 'done' and p_done_reason <> 'dead' and exists (
       select 1 from public.qualifier_queue z
        where z.lead_id = p_lead and z.claimed_at is not null
          and (z.manual_at > z.claimed_at
               or exists (select 1 from public.lead_fields f
                           where f.lead_id = p_lead and f.source in ('import', 'apify_maps', 'apollo', 'apify_contact') and f.created_at >= z.claimed_at))) then
    update public.qualifier_queue q
       set notes = q.notes || jsonb_build_object(p_step, p_outcome), last_step_at = now(), fail_streak = 0, fail_step = null,
           next_step = 'p1', done_reason = null, enqueued_at = now(), locked_by = null, locked_until = null, claimed_at = null
     where q.lead_id = p_lead;
    return;
  end if;
  update public.qualifier_queue q
     set notes = q.notes || jsonb_build_object(p_step, p_outcome),
         last_step_at = now(),
         fail_streak = case when v_err then (case when q.fail_step = p_step then q.fail_streak else 0 end) + 1 else 0 end,
         fail_step = case when v_err then p_step else null end,
         next_step = p_next,
         done_reason = case when p_next = 'done' then p_done_reason else null end,
         locked_by = case when p_next = 'done' then null else q.locked_by end,
         locked_until = case when p_next = 'done' then null else q.locked_until end,
         manual_at = case when p_next = 'done' then null else q.manual_at end,
         deep_requested = case when p_next = 'done' then false else q.deep_requested end
   where q.lead_id = p_lead;
end;
$$;

-- ---------------------------------------------------------------- Qualificador path: ask for contacts
-- True = the lead is (now, or already) in an open contact run. False = nothing was asked: no Apify connection, the
-- day's cap has no room for a new run's 0.50 reserve, or the lead was already answered (or charged) in the last 30 days.
-- Joins the workspace's oldest queued run that nobody has claimed and that has fewer than 10 leads; else opens one.
create or replace function public.qualifier_request_contacts(p_tick uuid, p_lead uuid, p_url text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  v_url text := btrim(p_url);
  v_conn public.source_connections;
  v_run uuid;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_ws := public.qualifier_assert(p_tick, p_lead, true);
  if v_url is null or char_length(v_url) > 2000 or v_url !~* '^https?://[^/?#[:space:]]+' or v_url ~ '[[:space:]]' then
    raise exception 'invalid url' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('source:' || v_ws::text));
  select * into v_conn from public.source_connections c where c.workspace_id = v_ws and c.provider = 'apify';
  if not found then
    return false;
  end if;
  if exists (select 1 from public.source_run_leads l join public.source_runs r on r.id = l.run_id
              where l.lead_id = p_lead and r.kind = 'contact' and r.status in ('queued', 'running')) then
    return true;
  end if;
  -- answered, or paid for and failed (stale, start_unknown, import_refused...), in the last 30 days: never pay twice.
  -- Free failures (no_leads, a definite refusal, disconnected, refused at the cap) may try again.
  if exists (select 1 from public.source_run_leads l join public.source_runs r on r.id = l.run_id
              where l.lead_id = p_lead and r.kind = 'contact' and r.created_at > now() - interval '30 days'
                and (r.status = 'imported' or (r.status = 'failed' and coalesce(r.cost_usd, 0) > 0))) then
    return false;
  end if;
  select r.id into v_run
    from public.source_runs r
   where r.workspace_id = v_ws and r.kind = 'contact' and r.status = 'queued' and r.start_claimed_at is null
     and (select count(*) from public.source_run_leads l where l.run_id = r.id) < 10
   order by r.created_at, r.id
   limit 1
     for update;
  if v_run is null then
    if public.source_spent_today(v_ws) + 0.50 > coalesce(v_conn.daily_cap_usd, 2.00) then
      return false;
    end if;
    insert into public.source_runs (workspace_id, provider, kind, query, max_results, reserve_usd)
    values (v_ws, 'apify', 'contact', jsonb_build_object('label', 'Contatos'), 10, 0.50)
    returning id into v_run;
  end if;
  insert into public.source_run_leads (run_id, lead_id, start_url) values (v_run, p_lead, v_url);
  return true;
end;
$$;

-- ---------------------------------------------------------------- sources path: the leads of a contact run
create or replace function public.source_contact_leads(p_tick uuid, p_run uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.source_assert_tick(p_tick);
  if not exists (select 1 from public.source_runs r where r.id = p_run and r.kind = 'contact') then
    raise exception 'not a contact run' using errcode = '22023';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('lead_id', l.lead_id, 'start_url', l.start_url) order by l.lead_id)
                     from public.source_run_leads l where l.run_id = p_run), '[]'::jsonb);
end;
$$;

-- 0013's source_next_work plus the contact batching window (a contact run is claimed at 10 leads or 10 minutes old).
create or replace function public.source_next_work(p_tick uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_ct text;
  v_cap_usd numeric;
  v_cap_calls integer;
  v_over boolean;
  v_start jsonb := '[]'::jsonb;
  v_poll jsonb := '[]'::jsonb;
  v_n int := 0;
begin
  perform public.source_assert_tick(p_tick);
  -- a start claimed over 10 minutes ago never reported back (the tick died after Apify may have started it):
  -- its fate is unknown, so it is failed and its reserve is charged; it is never started a second time
  update public.source_runs
     set status = 'failed', error = 'start_unknown', finished_at = now(), cost_usd = reserve_usd
   where status = 'queued' and start_claimed_at is not null and start_claimed_at < now() - interval '10 minutes';
  for v in
    select r.* from public.source_runs r where r.status = 'queued' and r.start_claimed_at is null order by r.created_at, r.id
  loop
    exit when v_n >= 3;
    perform pg_advisory_xact_lock(hashtext('source:' || v.workspace_id::text));
    -- re-read under the lock: a client may have changed it meanwhile
    if not exists (select 1 from public.source_runs r where r.id = v.id and r.status = 'queued' and r.start_claimed_at is null) then
      continue;
    end if;
    -- a contact run waits for company: under 10 leads and younger than 10 minutes it is not started yet (the 0.50
    -- minimum charge is shared by up to 10 leads). qualifier_request_contacts takes the same lock, so no lead joins
    -- a run that is being claimed.
    if v.kind = 'contact' and v.created_at > now() - interval '10 minutes'
       and (select count(*) from public.source_run_leads l where l.run_id = v.id) < 10 then
      continue;
    end if;
    select c.secret_ciphertext, c.daily_cap_usd, c.daily_calls into v_ct, v_cap_usd, v_cap_calls
      from public.source_connections c where c.workspace_id = v.workspace_id and c.provider = v.provider;
    if v_ct is null then
      update public.source_runs set status = 'refused', error = 'disconnected', finished_at = now() where id = v.id;
      continue;
    end if;
    -- the queued run already counts in today's total: over the cap only if the total up to this run (younger queued
    -- runs left out, so the oldest keep their place) exceeds it
    if v.provider = 'apify' then
      v_over := public.source_spent_today(v.workspace_id) - coalesce((
          select sum(x.reserve_usd) from public.source_runs x
           where x.workspace_id = v.workspace_id and x.provider = 'apify' and x.status = 'queued' and x.created_at >= public.source_day_start() and (x.created_at, x.id) > (v.created_at, v.id)), 0)
        > coalesce(v_cap_usd, 2.00);
    else
      v_over := public.source_calls_today(v.workspace_id) - (
          select count(*) from public.source_runs x
           where x.workspace_id = v.workspace_id and x.provider = 'apollo' and x.status = 'queued' and x.created_at >= public.source_day_start() and (x.created_at, x.id) > (v.created_at, v.id))
        > coalesce(v_cap_calls, 20);
    end if;
    if v_over then
      update public.source_runs set status = 'refused', error = 'source_cap', finished_at = now() where id = v.id;
      continue;
    end if;
    v_n := v_n + 1;
    update public.source_runs set start_claimed_at = now() where id = v.id;
    v_start := v_start || jsonb_build_array(jsonb_build_object(
      'id', v.id, 'workspace_id', v.workspace_id, 'provider', v.provider, 'kind', v.kind, 'query', v.query,
      'max_results', v.max_results, 'reserve_usd', v.reserve_usd, 'external_run_id', v.external_run_id,
      'dataset_id', v.dataset_id, 'started_at', v.started_at, 'label', v.query ->> 'label', 'ciphertext', v_ct));
  end loop;

  for v in
    select r.* from public.source_runs r where r.status = 'running' order by r.started_at nulls first, r.id limit 10
  loop
    select c.secret_ciphertext into v_ct from public.source_connections c where c.workspace_id = v.workspace_id and c.provider = v.provider;
    if v_ct is null then
      update public.source_runs set status = 'failed', error = 'disconnected', finished_at = now(), cost_usd = coalesce(cost_usd, reserve_usd) where id = v.id;
      continue;
    end if;
    v_poll := v_poll || jsonb_build_array(jsonb_build_object(
      'id', v.id, 'workspace_id', v.workspace_id, 'provider', v.provider, 'kind', v.kind, 'query', v.query,
      'max_results', v.max_results, 'reserve_usd', v.reserve_usd, 'external_run_id', v.external_run_id,
      'dataset_id', v.dataset_id, 'started_at', v.started_at, 'label', v.query ->> 'label', 'ciphertext', v_ct));
  end loop;
  return jsonb_build_object('start', v_start, 'poll', v_poll);
end;
$$;

-- 0013's source_mark_started: a contact run (Apify) needs its ids like a Maps run does.
create or replace function public.source_mark_started(p_tick uuid, p_run uuid, p_external_id text, p_dataset text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
  v_kind text;
begin
  perform public.source_assert_tick(p_tick);
  select r.kind into v_kind from public.source_runs r where r.id = p_run;
  -- Apify (Maps, contacts) ids are alphanumeric; an Apollo search finishes in one tick and may have no external id or dataset
  if (v_kind in ('maps', 'contact') and (p_external_id is null or p_dataset is null or p_external_id !~ '^[A-Za-z0-9]{1,100}$' or p_dataset !~ '^[A-Za-z0-9]{1,100}$'))
     or (v_kind is not null and v_kind not in ('maps', 'contact') and ((p_external_id is not null and p_external_id <> '' and p_external_id !~ '^[A-Za-z0-9]{1,100}$')
                                          or (p_dataset is not null and p_dataset <> '' and p_dataset !~ '^[A-Za-z0-9]{1,100}$'))) then
    raise exception 'invalid run id' using errcode = '22023';
  end if;
  update public.source_runs r
     set status = 'running', external_run_id = nullif(p_external_id, ''), dataset_id = nullif(p_dataset, ''), started_at = now()
   where r.id = p_run and r.status = 'queued';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'run is not queued' using errcode = '22023';
  end if;
end;
$$;

-- Stores a finished contact run's e-mails once and settles the run ('imported', cost = what Apify charged, else the
-- reserve). Rows are { lead_id, value, url }: each lead must belong to the run; a row that is not (or is malformed)
-- is skipped and counted in dropped, the rest is kept. The values are confirmed (they are on the
-- lead's own site) and carry the page they were read on; a finished lead is re-queued by the lead_fields trigger.
-- Only from running (else 22023): a second call cannot store twice. Returns the number of e-mails new to their lead.
create or replace function public.source_add_contacts(p_tick uuid, p_run uuid, p_rows jsonb, p_found int, p_cost numeric)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.source_runs;
  r jsonb;
  k text;
  v_n integer := 0;
  v_i integer;
  v_value text;
  v_url text;
  v_ok boolean;
  v_skipped integer := 0;
begin
  perform public.source_assert_tick(p_tick);
  select * into v_run from public.source_runs x where x.id = p_run for update;
  if not found or v_run.kind <> 'contact' or v_run.status <> 'running' then
    raise exception 'run is not importable' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 100
     or p_found is null or p_found not between 0 and 10000
     or (p_cost is not null and (p_cost < 0 or p_cost > 1000)) then
    raise exception 'invalid rows' using errcode = '22023';
  end if;
  -- one bad row must not cost the other leads of the run their e-mails: it is skipped and counted (dropped)
  for r in select e from jsonb_array_elements(p_rows) e loop
    v_ok := jsonb_typeof(r) = 'object';
    if v_ok then
      for k in select jsonb_object_keys(r) loop
        if k <> all (array['lead_id', 'value', 'url']) then
          v_ok := false;
        end if;
      end loop;
    end if;
    if v_ok then
      v_value := lower(btrim(r ->> 'value'));
      v_url := btrim(r ->> 'url');
      v_ok := (r ->> 'lead_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          and v_value ~ '^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$' and char_length(v_value) <= 254
          and char_length(v_url) <= 2000 and v_url ~* '^https?://[^/?#[:space:]]+' and v_url !~ '[[:space:]]';
    end if;
    if v_ok then
      v_ok := exists (select 1 from public.source_run_leads l where l.run_id = p_run and l.lead_id = (r ->> 'lead_id')::uuid);
    end if;
    if v_ok is not true then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    insert into public.lead_fields (workspace_id, lead_id, field, value, source, source_ref, status)
    values (v_run.workspace_id, (r ->> 'lead_id')::uuid, 'email', v_value, 'apify_contact', v_url, 'confirmed')
    on conflict do nothing;
    get diagnostics v_i = row_count;
    v_n := v_n + v_i;
  end loop;
  update public.source_runs
     set status = 'imported', found = p_found,
         dropped = greatest(p_found - (jsonb_array_length(p_rows) - v_skipped), 0),
         finished_at = now(), cost_usd = round(coalesce(p_cost, reserve_usd), 2)
   where id = p_run;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------- privileges
revoke all on function public.requeue_lead_on_import() from public, anon, authenticated;
revoke all on function public.qualifier_step_done(uuid, uuid, text, text, text, text) from public, authenticated;
revoke all on function public.qualifier_request_contacts(uuid, uuid, text) from public, authenticated;
revoke all on function public.source_contact_leads(uuid, uuid) from public, authenticated;
revoke all on function public.source_mark_started(uuid, uuid, text, text) from public, authenticated;
revoke all on function public.source_add_contacts(uuid, uuid, jsonb, int, numeric) from public, authenticated;
grant execute on function public.qualifier_step_done(uuid, uuid, text, text, text, text) to anon;
grant execute on function public.qualifier_request_contacts(uuid, uuid, text) to anon;
grant execute on function public.source_contact_leads(uuid, uuid) to anon;
grant execute on function public.source_mark_started(uuid, uuid, text, text) to anon;
grant execute on function public.source_add_contacts(uuid, uuid, jsonb, int, numeric) to anon;
