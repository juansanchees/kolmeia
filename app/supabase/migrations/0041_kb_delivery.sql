-- 0041 Delivery of base companies into a workspace (kind 'kb') + per-lead opportunities + the call queue.
--   lead_imports_kind / lead_fields_source  + 'kb'
--   import_rows_core / undo_lead_import     copied from 0034 with 'kb' added and nothing else changed
--   kb_deliver(p_ws, p_import, p_list_name, p_rows) / kb_deliver_finish(p_import)   service_role only
--   lead_opportunities                      one row per (workspace, lead, offer, base signal); members read, only kb_deliver writes
--   build_call_list                         copied from 0020: leads with an open opportunity come first (priority desc) and skip the
--                                           level/temperature filter (a freshly delivered lead has level 0); everything else unchanged
-- Depends on 0020, 0034, 0040. Re-runnable.
begin;

alter table public.lead_imports drop constraint if exists lead_imports_kind;
alter table public.lead_imports add constraint lead_imports_kind check (kind in ('file', 'apify_maps', 'apollo', 'shovels', 'rapidapi_b2b', 'kb'));

alter table public.lead_fields drop constraint if exists lead_fields_source;
alter table public.lead_fields add constraint lead_fields_source check (source in
  ('import', 'site', 'places', 'ai', 'research', 'apify_maps', 'apollo', 'apify_contact', 'pattern', 'shovels', 'rapidapi_b2b', 'rapidapi_contact', 'kb'));

-- ---------------------------------------------------------------- opportunities
create table if not exists public.lead_opportunities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  import_id uuid references public.lead_imports (id) on delete set null,
  kb_signal_id uuid references public.kb_signals (id) on delete cascade,
  offer text not null check (char_length(offer) between 1 and 60),
  title text check (char_length(title) <= 200),
  signal_date date,
  source text,
  source_url text check (char_length(source_url) <= 500),
  priority int not null default 0 check (priority between 0 and 100),
  priority_codes text[] not null default '{}',
  hook_en text check (char_length(hook_en) <= 300),
  checks jsonb not null default '{}'::jsonb,
  open_questions text[] not null default '{}',
  contact_path text not null default 'none' check (contact_path in ('phone', 'bids', 'vendor_portal', 'none')),
  contact_value text check (char_length(contact_value) <= 300),
  status text not null default 'open' check (status in ('open', 'done')),
  updated_at timestamptz not null default now(),
  constraint lead_opportunities_key unique nulls not distinct (workspace_id, lead_id, offer, kb_signal_id)
);
create index if not exists lead_opportunities_lead_idx on public.lead_opportunities (lead_id);

-- an opportunity goes with its base signal: `set null` would collide on the key when a lead has 2 signals for the same offer.
-- Re-runnable on a table created with the old `on delete set null`.
alter table public.lead_opportunities drop constraint if exists lead_opportunities_kb_signal_id_fkey;
alter table public.lead_opportunities add constraint lead_opportunities_kb_signal_id_fkey
  foreign key (kb_signal_id) references public.kb_signals (id) on delete cascade;

-- re-runnable on a table created before import_id existed
alter table public.lead_opportunities add column if not exists import_id uuid references public.lead_imports (id) on delete set null;

alter table public.lead_opportunities enable row level security;
revoke all on public.lead_opportunities from public, anon, authenticated;
grant select on public.lead_opportunities to authenticated;
grant all on public.lead_opportunities to service_role;
-- Same visibility as the lead itself (owner/sdr of the workspace, or the assigned closer): the subquery runs under leads_select.
drop policy if exists lead_opportunities_select on public.lead_opportunities;
create policy lead_opportunities_select on public.lead_opportunities
  for select to authenticated
  using (exists (select 1 from public.leads l where l.id = lead_id and l.workspace_id = lead_opportunities.workspace_id));

-- ---------------------------------------------------------------- core and undo (0034 + 'kb')
create or replace function public.import_rows_core(p_import uuid, p_rows jsonb, p_source text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_imp public.lead_imports;
  v_ws uuid;
  v_n int;
  v_fresh int := 0;
  v_row jsonb;
  v_no int;
  v_k text;
  v_val text;
  v_vals jsonb;
  v_nk text;
  v_lead uuid;
  v_is_new boolean;
  v_new int := 0;
  v_merged int := 0;
  v_err int := 0;
  v_err_code text;
  v_data jsonb;
  v_keys text[];
  v_cap int;
  v_fields text[] := array['website', 'phone', 'email', 'address', 'city', 'state', 'zip', 'contact_name', 'contact_title', 'note'];
begin
  -- Callers (the file wrapper, the source path) did their own authorization; the core only enforces the data rules.
  -- 0033/0034: 'shovels' and 'rapidapi_b2b' are sources like 'apify_maps' and 'apollo'.
  select * into v_imp from public.lead_imports i where i.id = p_import for update;
  if not found then
    raise exception 'import not found' using errcode = '22023';
  end if;
  if v_imp.status <> 'importing' then
    raise exception 'import is %', v_imp.status using errcode = '22023';
  end if;
  if p_source is null or not ((p_source = 'import' and v_imp.kind = 'file') or (p_source = v_imp.kind and p_source in ('apify_maps', 'apollo', 'shovels', 'rapidapi_b2b', 'kb'))) then
    raise exception 'invalid source' using errcode = '22023';
  end if;
  -- sources may also carry the place id and the company type; file imports keep the F3c-1 key set exactly
  if p_source <> 'import' then
    v_fields := v_fields || array['company_type', 'place_id'];
  end if;
  v_ws := v_imp.workspace_id;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid rows' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_rows);
  if v_n > 500 then
    raise exception 'too many rows' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('lead:' || v_ws::text));

  for v_row in select e.value from jsonb_array_elements(p_rows) e loop
    if jsonb_typeof(v_row) <> 'object' or jsonb_typeof(v_row -> 'row') is distinct from 'number' or (v_row ->> 'row') !~ '^[0-9]{1,4}$' then
      raise exception 'invalid row' using errcode = '22023';
    end if;
    v_no := (v_row ->> 'row')::int;
    if v_no not between 1 and 5000 then
      raise exception 'invalid row' using errcode = '22023';
    end if;
    -- a batch sent twice (retry after a lost answer) is not counted twice
    if exists (select 1 from public.lead_import_rows r where r.import_id = p_import and r.row_number = v_no) then
      continue;
    end if;
    -- the 5,000-row cap counts only rows not stored yet, so a re-sent last batch stays idempotent
    v_fresh := v_fresh + 1;
    if v_imp.row_count + v_fresh > 5000 then
      raise exception 'too many rows' using errcode = '22023';
    end if;

    if v_row ? 'error' then
      select array_agg(k) into v_keys from jsonb_object_keys(v_row) k where k not in ('row', 'error', 'data');
      v_err_code := v_row ->> 'error';
      if v_keys is not null or jsonb_typeof(v_row -> 'error') is distinct from 'string'
         or char_length(v_err_code) not between 1 and 40
         or jsonb_typeof(v_row -> 'data') is distinct from 'object' then
        raise exception 'invalid row' using errcode = '22023';
      end if;
      v_data := v_row -> 'data';
      if octet_length(v_data::text) > 4000 then
        v_data := '{"truncated": true}'::jsonb;
      end if;
      insert into public.lead_import_rows (import_id, workspace_id, row_number, data, outcome, error)
      values (p_import, v_ws, v_no, v_data, 'error', v_err_code);
      v_err := v_err + 1;
      continue;
    end if;

    -- a row to import: only known keys, text values, caps, no hostile website
    select array_agg(k) into v_keys from jsonb_object_keys(v_row) k
     where k <> all (array['row', 'name', 'name_key'] || v_fields);
    if v_keys is not null then
      raise exception 'invalid row' using errcode = '22023';
    end if;
    v_vals := '{}'::jsonb;
    for v_k in select unnest(array['name', 'name_key'] || v_fields) loop
      if v_row -> v_k is null or jsonb_typeof(v_row -> v_k) = 'null' then
        continue;
      end if;
      if jsonb_typeof(v_row -> v_k) <> 'string' then
        raise exception 'invalid row' using errcode = '22023';
      end if;
      v_val := btrim(v_row ->> v_k);
      v_cap := case v_k when 'name' then 200 when 'name_key' then 200 when 'note' then 1000 else 300 end;
      if char_length(v_val) > v_cap then
        raise exception 'invalid row' using errcode = '22023';
      end if;
      if v_val <> '' then
        v_vals := v_vals || jsonb_build_object(v_k, v_val);
      end if;
    end loop;
    if not (v_vals ? 'name') or not (v_row ? 'name_key')
       or (v_vals ->> 'website') !~* '^(https?://[^[:space:]]+)?$'
       or (v_vals ->> 'email') !~ '^([^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+)?$' then
      raise exception 'invalid row' using errcode = '22023';
    end if;
    v_nk := nullif(v_vals ->> 'name_key', '');

    v_lead := public.find_lead(v_ws, v_nk, public.company_domain_key(v_vals ->> 'website'), public.company_phone_key(v_vals ->> 'phone'), null);
    v_is_new := v_lead is null;
    if v_is_new then
      insert into public.leads (workspace_id, best_candidate_id, origin_kind, origin_import_id)
      values (v_ws, null, 'import', p_import)
      returning id into v_lead;
      v_new := v_new + 1;
    else
      update public.leads set last_seen_at = now(), updated_at = now() where id = v_lead and workspace_id = v_ws;
      v_merged := v_merged + 1;
    end if;

    -- K-2: never overwrite; every distinct value is its own row, with its list. The name's key is the writer's name_key.
    insert into public.lead_fields (workspace_id, lead_id, field, value, key, source, source_ref, status)
    values (v_ws, v_lead, 'name', v_vals ->> 'name', v_nk, p_source, p_import::text, 'unverified')
    on conflict do nothing;
    for v_k in select unnest(v_fields) loop
      if v_vals ? v_k then
        insert into public.lead_fields (workspace_id, lead_id, field, value, source, source_ref, status)
        values (v_ws, v_lead, v_k, v_vals ->> v_k, p_source, p_import::text, 'unverified')
        on conflict do nothing;
      end if;
    end loop;

    insert into public.lead_import_rows (import_id, workspace_id, row_number, data, lead_id, outcome)
    values (p_import, v_ws, v_no, v_row - 'row', v_lead, case when v_is_new then 'new' else 'merged' end);
  end loop;

  update public.lead_imports
     set row_count = row_count + v_new + v_merged + v_err,
         new_count = new_count + v_new,
         merged_count = merged_count + v_merged,
         error_count = error_count + v_err
   where id = p_import;
  return jsonb_build_object('new', v_new, 'merged', v_merged, 'errors', v_err);
end;
$$;
create or replace function public.undo_lead_import(p_import uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_imp public.lead_imports;
  v_ws uuid;
  v_lead record;
  v_other uuid;
  v_deleted int := 0;
  v_kept int := 0;
  v_touched uuid[] := '{}';
  v_gone int;
begin
  v_imp := public.lead_import_guard(p_import, array['importing', 'done'], true);
  v_ws := v_imp.workspace_id;
  perform pg_advisory_xact_lock(hashtext('lead:' || v_ws::text));

  for v_lead in
    select l.id, l.origin_import_id
      from public.leads l
     where l.workspace_id = v_ws
       and (l.origin_import_id = p_import
            or exists (select 1 from public.lead_fields f where f.lead_id = l.id and f.workspace_id = v_ws and f.source in ('import', 'apify_maps', 'apollo', 'shovels', 'rapidapi_b2b', 'kb') and f.source_ref = p_import::text))
     order by l.created_at, l.id
  loop
    if v_lead.origin_import_id is not distinct from p_import
       and not exists (select 1 from public.research_candidates c where c.lead_id = v_lead.id)
       and not exists (select 1 from public.lead_fields f where f.lead_id = v_lead.id and not (f.source in ('import', 'apify_maps', 'apollo', 'shovels', 'rapidapi_b2b', 'kb') and f.source_ref = p_import::text))
       and not exists (select 1 from public.leads w where w.id = v_lead.id and (w.status <> 'new' or w.owner_id is not null)) then
      delete from public.leads where id = v_lead.id and workspace_id = v_ws;
      v_deleted := v_deleted + 1;
    else
      v_kept := v_kept + 1;
      v_touched := v_touched || v_lead.id;
      if v_lead.origin_import_id is not distinct from p_import then
        select i.id into v_other
          from public.lead_fields f
          join public.lead_imports i on i.id::text = f.source_ref and i.workspace_id = v_ws
         where f.lead_id = v_lead.id and f.source in ('import', 'apify_maps', 'apollo', 'shovels', 'rapidapi_b2b', 'kb') and f.source_ref <> p_import::text and i.status <> 'undone'
         order by i.created_at, i.id
         limit 1;
        -- the oldest other list takes over; with none, origin_kind stays 'import' and the list id goes null
        update public.leads set origin_import_id = v_other, updated_at = now() where id = v_lead.id;
      end if;
    end if;
  end loop;

  -- A lead somebody already worked (status moved or owner set) keeps this list's values: they may be all it has, and
  -- without them a re-upload could not match it and would create a duplicate.
  delete from public.lead_fields f
   where f.workspace_id = v_ws and f.source in ('import', 'apify_maps', 'apollo', 'shovels', 'rapidapi_b2b', 'kb') and f.source_ref = p_import::text
     and not exists (select 1 from public.leads w where w.id = f.lead_id and (w.status <> 'new' or w.owner_id is not null));
  -- An untouched lead left with no candidate and no value at all would show as a blank "Sem nome": remove it.
  delete from public.leads l
   where l.workspace_id = v_ws and l.id = any (v_touched)
     and l.status = 'new' and l.owner_id is null
     and not exists (select 1 from public.research_candidates c where c.lead_id = l.id)
     and not exists (select 1 from public.lead_fields f where f.lead_id = l.id);
  get diagnostics v_gone = row_count;
  v_deleted := v_deleted + v_gone;
  v_kept := v_kept - v_gone;
  delete from public.lead_import_rows where import_id = p_import;
  update public.lead_imports set status = 'undone' where id = p_import;
  return jsonb_build_object('deleted', v_deleted, 'kept', v_kept);
end;
$$;
-- ---------------------------------------------------------------- kb_deliver
create or replace function public.kb_deliver(p_ws uuid, p_import uuid, p_list_name text, p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_imp public.lead_imports;
  v_id uuid := p_import;
  v_row jsonb;
  v_opp jsonb;
  v_co uuid;
  v_lead uuid;
  v_core jsonb := '[]'::jsonb;
  v_map jsonb := '[]'::jsonb;
  v_skipped int := 0;
  v_res jsonb;
  r record;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid rows' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('lead:' || p_ws::text));
  if v_id is null then
    insert into public.lead_imports (workspace_id, created_by, kind, file_name, list_name)
    values (p_ws, null, 'kb', 'Base Kolmeia', p_list_name)
    returning id into v_id;
  else
    select * into v_imp from public.lead_imports i where i.id = v_id for update;
    if not found or v_imp.kind <> 'kb' or v_imp.workspace_id <> p_ws then
      raise exception 'import does not belong to this workspace' using errcode = '22023';
    end if;
  end if;

  for v_row in select e.value from jsonb_array_elements(p_rows) e loop
    if jsonb_typeof(v_row) <> 'object' then
      raise exception 'invalid row' using errcode = '22023';
    end if;
    if v_row ? 'error' then
      v_core := v_core || jsonb_build_array(v_row);
      continue;
    end if;
    if jsonb_typeof(v_row -> 'kb_company_id') is distinct from 'string' then
      raise exception 'invalid row' using errcode = '22023';
    end if;
    v_co := (v_row ->> 'kb_company_id')::uuid;
    select k.lead_id into v_lead from public.kb_lead_links k where k.workspace_id = p_ws and k.company_id = v_co;
    if v_lead is not null then
      -- already delivered: only its opportunities are refreshed
      v_skipped := v_skipped + 1;
      perform public.kb_upsert_opportunities(p_ws, v_lead, v_row -> 'opportunities', v_id);
    else
      v_core := v_core || jsonb_build_array(v_row - 'kb_company_id' - 'opportunities');
      v_map := v_map || jsonb_build_array(jsonb_build_object('row', (v_row ->> 'row')::int, 'co', v_co, 'opps', coalesce(v_row -> 'opportunities', '[]'::jsonb)));
    end if;
  end loop;

  v_res := public.import_rows_core(v_id, v_core, 'kb');

  for r in
    select (m ->> 'co')::uuid as co, m -> 'opps' as opps, ir.lead_id
      from jsonb_array_elements(v_map) m
      join public.lead_import_rows ir on ir.import_id = v_id and ir.row_number = (m ->> 'row')::int and ir.lead_id is not null
  loop
    insert into public.kb_lead_links (workspace_id, lead_id, company_id, import_id)
    values (p_ws, r.lead_id, r.co, v_id)
    on conflict do nothing;
    -- the lead may have been linked to another company's row of this batch; the opportunities still belong to this lead
    perform public.kb_upsert_opportunities(p_ws, r.lead_id, r.opps, v_id);
  end loop;

  return jsonb_build_object('import_id', v_id, 'new', v_res -> 'new', 'merged', v_res -> 'merged', 'errors', v_res -> 'errors', 'skipped_linked', v_skipped);
end;
$$;

drop function if exists public.kb_upsert_opportunities(uuid, uuid, jsonb);
create or replace function public.kb_upsert_opportunities(p_ws uuid, p_lead uuid, p_opps jsonb, p_import uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o jsonb;
  v_keys text[];
begin
  if p_opps is null or jsonb_typeof(p_opps) = 'null' then
    return;
  end if;
  if jsonb_typeof(p_opps) <> 'array' or jsonb_array_length(p_opps) > 20 then
    raise exception 'invalid opportunities' using errcode = '22023';
  end if;
  for o in select e.value from jsonb_array_elements(p_opps) e loop
    select array_agg(k) into v_keys from jsonb_object_keys(o) k
     where k <> all (array['kb_signal_id', 'offer', 'title', 'signal_date', 'source', 'source_url', 'priority', 'priority_codes',
                           'hook_en', 'checks', 'open_questions', 'contact_path', 'contact_value']);
    if jsonb_typeof(o) <> 'object' or v_keys is not null or nullif(o ->> 'offer', '') is null then
      raise exception 'invalid opportunity' using errcode = '22023';
    end if;
    insert into public.lead_opportunities (workspace_id, lead_id, import_id, kb_signal_id, offer, title, signal_date, source, source_url, priority,
                                           priority_codes, hook_en, checks, open_questions, contact_path, contact_value)
    values (p_ws, p_lead, p_import, (o ->> 'kb_signal_id')::uuid, o ->> 'offer', o ->> 'title', (o ->> 'signal_date')::date, o ->> 'source',
            o ->> 'source_url', coalesce((o ->> 'priority')::int, 0),
            coalesce(array(select jsonb_array_elements_text(o -> 'priority_codes')), '{}'),
            o ->> 'hook_en', coalesce(o -> 'checks', '{}'::jsonb),
            coalesce(array(select jsonb_array_elements_text(o -> 'open_questions')), '{}'),
            coalesce(o ->> 'contact_path', 'none'), o ->> 'contact_value')
    on conflict (workspace_id, lead_id, offer, kb_signal_id) do update
      set title = excluded.title, signal_date = excluded.signal_date, source = excluded.source, source_url = excluded.source_url,
          priority = excluded.priority, priority_codes = excluded.priority_codes, hook_en = excluded.hook_en, checks = excluded.checks,
          open_questions = excluded.open_questions, contact_path = excluded.contact_path, contact_value = excluded.contact_value,
          updated_at = now();
  end loop;
end;
$$;

create or replace function public.kb_deliver_finish(p_import uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.lead_imports set status = 'done', finished_at = now() where id = p_import and kind = 'kb';
  if not found then
    raise exception 'not a kb import' using errcode = '22023';
  end if;
end;
$$;

-- Undo of a kb list: leads that merged into an existing lead survive undo_lead_import (0034 rule), so their link and
-- opportunities from this import go here, which lets a later delivery start clean. Leads deleted by undo lose both by cascade.
create or replace function public.kb_undo_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.lead_opportunities where import_id = new.id;
  delete from public.kb_lead_links where import_id = new.id;
  return new;
end;
$$;
drop trigger if exists kb_undo_cleanup on public.lead_imports;
create trigger kb_undo_cleanup after update of status on public.lead_imports
  for each row when (new.kind = 'kb' and new.status = 'undone' and old.status is distinct from 'undone') execute function public.kb_undo_cleanup();

-- ---------------------------------------------------------------- call queue (0020 + open opportunities first)
create or replace function public.build_call_list(p_agent uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_a public.agents%rowtype;
  v_caller uuid;
  v_day date := public.call_day();
  v_room integer;
  v_pos integer;
  v_min integer;
  v_temps text[];
  v_n integer := 0;
  r record;
begin
  select * into v_a from public.agents a where a.id = p_agent;
  v_caller := public.call_agent_caller(p_agent);
  if v_uid is null or v_a.id is null
     or not (public.is_workspace_sender(v_a.workspace_id)
             or (v_a.type = 'call' and v_caller = v_uid and public.is_workspace_member(v_a.workspace_id))) then
    raise exception 'the caller or owner/sdr only' using errcode = '42501';
  end if;
  if v_a.type <> 'call' or v_a.status <> 'running' or v_a.archived_at is not null or v_caller is null then
    raise exception 'not a running call agent' using errcode = '55000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('call_list:' || v_a.workspace_id::text, 0));

  select greatest((v_a.config ->> 'per_day')::integer - count(*) filter (where not i.manual), 0)::integer,
         coalesce(max(i.position), 0)
    into v_room, v_pos
    from public.call_list_items i
   where i.agent_id = p_agent and i.list_date = v_day;
  v_min := (v_a.config ->> 'min_level')::integer;
  v_temps := array(select jsonb_array_elements_text(v_a.config -> 'temperatures'));

  for r in
    select l.id
      from public.leads l
      left join public.research_candidates c on c.id = l.best_candidate_id
      left join lateral (
        select max(o.priority) as p from public.lead_opportunities o where o.lead_id = l.id and o.status = 'open'
      ) op on true
      left join lateral (
        select k.next_step_at from public.call_logs k
         where k.lead_id = l.id
         order by k.called_at desc, k.created_at desc, k.id desc
         limit 1
      ) n on true
     where l.workspace_id = v_a.workspace_id
       and (op.p is not null or (l.level >= v_min and (cardinality(v_temps) = 0 or c.temperature = any (v_temps))))
       and not exists (select 1 from public.call_list_items i where i.lead_id = l.id and i.list_date = v_day)
       and public.lead_callable(l.id, v_caller)
     order by case when op.p is null then 1 else 0 end, op.p desc nulls last,
              case when n.next_step_at is not null and n.next_step_at <= now() then 0 else 1 end,
              case c.temperature when 'very_hot' then 0 when 'hot' then 1 when 'warm' then 2 when 'cold' then 3 else 4 end,
              l.level desc, l.first_seen_at, l.id
     limit v_room
  loop
    -- assign first, and only if nobody took the lead meanwhile (hand_off_lead / set_lead_status do not take this lock)
    update public.leads
       set owner_id = coalesce(owner_id, v_caller),
           status = case when status = 'new' then 'call_list' else status end,
           updated_at = now()
     where id = r.id and (owner_id is null or owner_id = v_caller) and status in ('new', 'call_list') and not do_not_call;
    if not found then
      continue;
    end if;
    v_pos := v_pos + 1;
    insert into public.call_list_items (workspace_id, agent_id, lead_id, caller_id, list_date, position)
    values (v_a.workspace_id, p_agent, r.id, v_caller, v_day, v_pos);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke all on function public.import_rows_core(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.undo_lead_import(uuid) from public, anon;
grant execute on function public.undo_lead_import(uuid) to authenticated;
revoke all on function public.build_call_list(uuid) from public, anon;
grant execute on function public.build_call_list(uuid) to authenticated;
revoke all on function public.kb_undo_cleanup() from public, anon, authenticated;
revoke all on function public.kb_deliver(uuid, uuid, text, jsonb), public.kb_upsert_opportunities(uuid, uuid, jsonb, uuid), public.kb_deliver_finish(uuid) from public, anon, authenticated;
grant execute on function public.kb_deliver(uuid, uuid, text, jsonb), public.kb_upsert_opportunities(uuid, uuid, jsonb, uuid), public.kb_deliver_finish(uuid) to service_role;

commit;
