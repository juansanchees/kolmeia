-- 0011 Lists (F3c-1): upload a CSV/XLSX, every row becomes a lead, every value keeps its source.
--   T2 (end of file) create/preview/import/finish/undo RPCs, hunter_known_companies with import-only leads.
--   T1 lead_fields (one row per value with its source), lead_imports, lead_import_rows, leads.origin_import_id,
--      find_lead() = ONE duplicate rule for research candidates and imports, link_lead/unlink re-created on top of it.
-- Depends on 0001-0010. Re-runnable.

-- ---------------------------------------------------------------- imports
create table if not exists public.lead_imports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  file_name text not null constraint lead_imports_file_name check (char_length(file_name) between 1 and 200),
  sheet_name text constraint lead_imports_sheet_name check (sheet_name is null or char_length(sheet_name) <= 100),
  list_name text not null constraint lead_imports_list_name check (char_length(list_name) between 1 and 80),
  mapping jsonb not null default '{}'::jsonb
    constraint lead_imports_mapping check (jsonb_typeof(mapping) = 'object' and octet_length(mapping::text) <= 8000),
  use_as_training boolean not null default false,
  status text not null default 'importing' constraint lead_imports_status check (status in ('importing', 'done', 'undone')),
  row_count integer not null default 0,
  new_count integer not null default 0,
  merged_count integer not null default 0,
  error_count integer not null default 0,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists lead_imports_ws_idx on public.lead_imports (workspace_id, created_at desc);

create table if not exists public.lead_import_rows (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  row_number integer not null constraint lead_import_rows_row_number check (row_number between 1 and 5001),
  data jsonb not null constraint lead_import_rows_data check (octet_length(data::text) <= 4000),
  lead_id uuid,
  outcome text not null constraint lead_import_rows_outcome check (outcome in ('new', 'merged', 'error')),
  error text constraint lead_import_rows_error check (error is null or char_length(error) <= 40),
  unique (import_id, row_number)
);
create index if not exists lead_import_rows_lead_idx on public.lead_import_rows (lead_id);

-- leads: a new origin
alter table public.leads drop constraint if exists leads_origin_kind;
alter table public.leads
  add constraint leads_origin_kind check (origin_kind in ('agent', 'one_off', 'import'));
alter table public.leads
  add column if not exists origin_import_id uuid references public.lead_imports (id) on delete set null;
create index if not exists leads_origin_import_idx on public.leads (origin_import_id) where origin_import_id is not null;

-- Workspace integrity: a row of a child table always carries the workspace of its parent (composite foreign keys).
alter table public.lead_imports drop constraint if exists lead_imports_id_ws_key;
alter table public.lead_imports add constraint lead_imports_id_ws_key unique (id, workspace_id);
alter table public.leads drop constraint if exists leads_id_ws_key;
alter table public.leads add constraint leads_id_ws_key unique (id, workspace_id);
alter table public.lead_import_rows drop constraint if exists lead_import_rows_import_ws_fkey;
alter table public.lead_import_rows
  add constraint lead_import_rows_import_ws_fkey foreign key (import_id, workspace_id)
  references public.lead_imports (id, workspace_id) on delete cascade;
alter table public.lead_import_rows drop constraint if exists lead_import_rows_lead_ws_fkey;
alter table public.lead_import_rows
  add constraint lead_import_rows_lead_ws_fkey foreign key (lead_id, workspace_id)
  references public.leads (id, workspace_id) on delete set null (lead_id);

-- ---------------------------------------------------------------- lead_fields: "de onde veio"
create table if not exists public.lead_fields (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid not null,
  field text not null constraint lead_fields_field check (field in
    ('name', 'phone', 'email', 'website', 'address', 'city', 'state', 'zip', 'contact_name', 'contact_title', 'company_type', 'note', 'active_project', 'place_id')),
  value text not null constraint lead_fields_value check (char_length(value) between 1 and 1000),
  key text,
  source text not null constraint lead_fields_source check (source in ('import', 'site', 'places', 'ai', 'research')),
  source_ref text constraint lead_fields_source_ref check (source_ref is null or char_length(source_ref) <= 2000),
  status text not null default 'unverified' constraint lead_fields_status check (status in ('unverified', 'confirmed', 'refuted')),
  excerpt text constraint lead_fields_excerpt check (excerpt is null or char_length(excerpt) <= 300),
  seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.lead_fields drop constraint if exists lead_fields_lead_ws_fkey;
alter table public.lead_fields
  add constraint lead_fields_lead_ws_fkey foreign key (lead_id, workspace_id)
  references public.leads (id, workspace_id) on delete cascade;
create index if not exists lead_fields_key_idx on public.lead_fields (workspace_id, field, key) where key is not null;
create index if not exists lead_fields_lead_idx on public.lead_fields (lead_id);
-- K-2: every distinct value is its own row; the same value from another list (another source_ref) is another row; the same value twice from one source is one row.
drop index if exists public.lead_fields_distinct;
create unique index if not exists lead_fields_distinct
  on public.lead_fields (lead_id, field, md5(lower(btrim(value))), source, coalesce(source_ref, ''));

-- The key of a value: SQL company keys for website/phone, lower-cased e-mail. A name keeps the key its writer
-- computed (TS nameKey, as research candidates do); every other field has none.
create or replace function public.lead_field_key()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.field = 'website' then
    new.key := public.company_domain_key(new.value);
  elsif new.field = 'phone' then
    new.key := public.company_phone_key(new.value);
  elsif new.field = 'email' then
    new.key := lower(btrim(new.value));
  elsif new.field <> 'name' then
    new.key := null;
  end if;
  return new;
end;
$$;

drop trigger if exists lead_field_key on public.lead_fields;
create trigger lead_field_key
  before insert or update of value on public.lead_fields
  for each row execute function public.lead_field_key();

-- ---------------------------------------------------------------- ONE duplicate rule
-- Priority: name, domain, phone; several matches -> the oldest lead. Candidates (F3a) and non-refuted fields both identify.
-- Callers must hold the 'lead:' || workspace advisory lock.
create or replace function public.find_lead(p_ws uuid, p_name_key text, p_domain text, p_phone text, p_exclude_candidate uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.lead_id
    from (
      select c.lead_id,
             case
               when c.name_key = p_name_key then 1
               when p_domain is not null and c.domain_key = p_domain then 2
               else 3
             end as prio
        from public.research_candidates c
       where c.workspace_id = p_ws
         and c.lead_id is not null
         and (p_exclude_candidate is null or c.id <> p_exclude_candidate)
         and (
           c.name_key = p_name_key
           or (p_domain is not null and c.domain_key = p_domain)
           or (p_phone is not null and c.phone_key = p_phone)
         )
      union all
      select f.lead_id,
             case f.field when 'name' then 1 when 'website' then 2 else 3 end as prio
        from public.lead_fields f
       where f.workspace_id = p_ws
         and f.status <> 'refuted'
         and f.key is not null
         and (
           (f.field = 'name' and p_name_key is not null and f.key = p_name_key)
           or (f.field = 'website' and p_domain is not null and f.key = p_domain)
           or (f.field = 'phone' and p_phone is not null and f.key = p_phone)
         )
    ) m
    join public.leads l on l.id = m.lead_id and l.workspace_id = p_ws
   order by m.prio, l.created_at, l.id
   limit 1;
$$;

-- link_lead (F3a), same signature and lock, now on top of find_lead.
create or replace function public.link_lead(p_ws uuid, p_run uuid, p_candidate uuid, p_name_key text, p_website text, p_phone text, p_seen_at timestamptz)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain text := public.company_domain_key(p_website);
  v_phone text := public.company_phone_key(p_phone);
  v_lead uuid;
  v_agent uuid;
begin
  perform pg_advisory_xact_lock(hashtext('lead:' || p_ws::text));

  v_lead := public.find_lead(p_ws, p_name_key, v_domain, v_phone, p_candidate);

  if v_lead is null then
    select r.agent_id into v_agent from public.research_runs r where r.id = p_run;
    insert into public.leads (workspace_id, best_candidate_id, origin_kind, origin_agent_id, origin_run_id, first_seen_at, last_seen_at)
    values (p_ws, p_candidate, case when v_agent is null then 'one_off' else 'agent' end, v_agent, p_run, p_seen_at, p_seen_at)
    returning id into v_lead;
  else
    update public.leads set best_candidate_id = p_candidate, last_seen_at = greatest(last_seen_at, p_seen_at), updated_at = now() where id = v_lead;
  end if;
  return v_lead;
end;
$$;

-- unlink (F3a L3): a lead that holds imported (or other non-research) values survives losing its last candidate.
create or replace function public.unlink_candidate_lead()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_best uuid;
begin
  perform pg_advisory_xact_lock(hashtext('lead:' || old.workspace_id::text));
  select c.id into v_best
    from public.research_candidates c
   where c.lead_id = old.lead_id and c.verified_at is not null
   order by c.verified_at desc, c.created_at desc, c.id
   limit 1;
  if v_best is not null then
    update public.leads set best_candidate_id = v_best, updated_at = now() where id = old.lead_id;
  elsif exists (select 1 from public.lead_fields f where f.lead_id = old.lead_id and f.source <> 'research') then
    update public.leads set best_candidate_id = null, updated_at = now() where id = old.lead_id;
  else
    delete from public.leads where id = old.lead_id;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------- closer visibility
create or replace function public.lead_visible_to_assignee(p_lead uuid, p_ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.leads l where l.id = p_lead and l.workspace_id = p_ws and l.owner_id = auth.uid());
$$;

-- ---------------------------------------------------------------- privileges and RLS
revoke all on function public.lead_field_key() from public, anon, authenticated;
revoke all on function public.find_lead(uuid, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.link_lead(uuid, uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.unlink_candidate_lead() from public, anon, authenticated;
revoke all on function public.lead_visible_to_assignee(uuid, uuid) from public, anon;
grant execute on function public.lead_visible_to_assignee(uuid, uuid) to authenticated;

revoke all on table public.lead_imports from public, anon, authenticated;
revoke all on table public.lead_import_rows from public, anon, authenticated;
revoke all on table public.lead_fields from public, anon, authenticated;
grant select on table public.lead_imports to authenticated;
grant select on table public.lead_import_rows to authenticated;
grant select on table public.lead_fields to authenticated;

alter table public.lead_imports enable row level security;
alter table public.lead_imports force row level security;
alter table public.lead_import_rows enable row level security;
alter table public.lead_import_rows force row level security;
alter table public.lead_fields enable row level security;
alter table public.lead_fields force row level security;

drop policy if exists lead_imports_select on public.lead_imports;
create policy lead_imports_select on public.lead_imports
  for select to authenticated using (public.is_workspace_sender(workspace_id));
drop policy if exists lead_import_rows_select on public.lead_import_rows;
create policy lead_import_rows_select on public.lead_import_rows
  for select to authenticated using (public.is_workspace_sender(workspace_id));
drop policy if exists lead_fields_select on public.lead_fields;
create policy lead_fields_select on public.lead_fields
  for select to authenticated
  using (public.is_workspace_sender(workspace_id) or public.lead_visible_to_assignee(lead_id, workspace_id));


-- ================================================================ T2: import RPCs
-- Shared guard: signed in, sender of the import's workspace, import in an allowed status. Not callable by clients.
create or replace function public.lead_import_guard(p_import uuid, p_statuses text[], p_lock boolean)
returns public.lead_imports
language plpgsql
set search_path = ''
as $$
declare
  v_imp public.lead_imports;
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_lock then
    select * into v_imp from public.lead_imports i where i.id = p_import for update;
  else
    select * into v_imp from public.lead_imports i where i.id = p_import;
  end if;
  if not found or not public.is_workspace_sender(v_imp.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not (v_imp.status = any (p_statuses)) then
    raise exception 'import is %', v_imp.status using errcode = '22023';
  end if;
  return v_imp;
end;
$$;

create or replace function public.create_lead_import(p_ws uuid, p_file_name text, p_sheet_name text, p_list_name text, p_mapping jsonb, p_use_as_training boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_list text := btrim(coalesce(p_list_name, ''));
  v_file text := btrim(coalesce(p_file_name, ''));
  v_id uuid;
begin
  if auth.uid() is null or p_ws is null or not public.is_workspace_sender(p_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if char_length(v_file) not between 1 and 200 or char_length(v_list) not between 1 and 80
     or char_length(coalesce(p_sheet_name, '')) > 100
     or p_mapping is null or jsonb_typeof(p_mapping) <> 'object' or octet_length(p_mapping::text) > 8000 then
    raise exception 'invalid import' using errcode = '22023';
  end if;
  insert into public.lead_imports (workspace_id, created_by, file_name, sheet_name, list_name, mapping, use_as_training)
  values (p_ws, auth.uid(), v_file, nullif(btrim(coalesce(p_sheet_name, '')), ''), v_list, p_mapping, coalesce(p_use_as_training, false))
  returning id into v_id;
  return v_id;
end;
$$;

-- Read-only: for each row, the existing lead it would join (null = new). Error rows are always null.
create or replace function public.preview_import_rows(p_import uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_imp public.lead_imports;
  v_row jsonb;
  v_out jsonb := '[]'::jsonb;
  v_no int;
  v_nk text;
  v_web text;
  v_phone text;
  v_lead uuid;
begin
  v_imp := public.lead_import_guard(p_import, array['importing'], false);
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'invalid rows' using errcode = '22023';
  end if;
  for v_row in select e.value from jsonb_array_elements(p_rows) e loop
    if jsonb_typeof(v_row) <> 'object' or jsonb_typeof(v_row -> 'row') is distinct from 'number'
       or (v_row ->> 'row') !~ '^[0-9]{1,4}$'
       or coalesce(jsonb_typeof(v_row -> 'name_key'), 'string') <> 'string'
       or coalesce(jsonb_typeof(v_row -> 'website'), 'string') <> 'string'
       or coalesce(jsonb_typeof(v_row -> 'phone'), 'string') <> 'string' then
      raise exception 'invalid row' using errcode = '22023';
    end if;
    v_no := (v_row ->> 'row')::int;
    v_lead := null;
    if not (v_row ? 'error') then
      v_nk := nullif(btrim(coalesce(v_row ->> 'name_key', '')), '');
      v_web := v_row ->> 'website';
      v_phone := v_row ->> 'phone';
      v_lead := public.find_lead(v_imp.workspace_id, v_nk, public.company_domain_key(v_web), public.company_phone_key(v_phone), null);
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('row', v_no, 'lead_id', v_lead));
  end loop;
  return v_out;
end;
$$;

-- One batch of rows (<= 500; <= 5,000 per import). The whole import logic lives in this one body.
create or replace function public.import_lead_rows(p_import uuid, p_rows jsonb)
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
  v_fields constant text[] := array['website', 'phone', 'email', 'address', 'city', 'state', 'zip', 'contact_name', 'contact_title', 'note'];
begin
  v_imp := public.lead_import_guard(p_import, array['importing'], true);
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
    values (v_ws, v_lead, 'name', v_vals ->> 'name', v_nk, 'import', p_import::text, 'unverified')
    on conflict do nothing;
    for v_k in select unnest(v_fields) loop
      if v_vals ? v_k then
        insert into public.lead_fields (workspace_id, lead_id, field, value, source, source_ref, status)
        values (v_ws, v_lead, v_k, v_vals ->> v_k, 'import', p_import::text, 'unverified')
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

create or replace function public.finish_lead_import(p_import uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.lead_import_guard(p_import, array['importing'], true);
  update public.lead_imports set status = 'done', finished_at = now() where id = p_import;
end;
$$;

-- K-9: deletes the leads this import created unless something else is on them; always removes this import's values and rows.
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
begin
  v_imp := public.lead_import_guard(p_import, array['importing', 'done'], true);
  v_ws := v_imp.workspace_id;
  perform pg_advisory_xact_lock(hashtext('lead:' || v_ws::text));

  for v_lead in
    select l.id, l.origin_import_id
      from public.leads l
     where l.workspace_id = v_ws
       and (l.origin_import_id = p_import
            or exists (select 1 from public.lead_fields f where f.lead_id = l.id and f.workspace_id = v_ws and f.source = 'import' and f.source_ref = p_import::text))
     order by l.created_at, l.id
  loop
    if v_lead.origin_import_id is not distinct from p_import
       and not exists (select 1 from public.research_candidates c where c.lead_id = v_lead.id)
       and not exists (select 1 from public.lead_fields f where f.lead_id = v_lead.id and not (f.source = 'import' and f.source_ref = p_import::text))
       and not exists (select 1 from public.leads w where w.id = v_lead.id and (w.status <> 'new' or w.owner_id is not null)) then
      delete from public.leads where id = v_lead.id and workspace_id = v_ws;
      v_deleted := v_deleted + 1;
    else
      v_kept := v_kept + 1;
      if v_lead.origin_import_id is not distinct from p_import then
        select i.id into v_other
          from public.lead_fields f
          join public.lead_imports i on i.id::text = f.source_ref and i.workspace_id = v_ws
         where f.lead_id = v_lead.id and f.source = 'import' and f.source_ref <> p_import::text and i.status <> 'undone'
         order by i.created_at, i.id
         limit 1;
        -- the oldest other list takes over; with none, origin_kind stays 'import' and the list id goes null
        update public.leads set origin_import_id = v_other, updated_at = now() where id = v_lead.id;
      end if;
    end if;
  end loop;

  delete from public.lead_fields where workspace_id = v_ws and source = 'import' and source_ref = p_import::text;
  delete from public.lead_import_rows where import_id = p_import;
  update public.lead_imports set status = 'undone' where id = p_import;
  return jsonb_build_object('deleted', v_deleted, 'kept', v_kept);
end;
$$;

-- The Caçador's known companies: leads with a best candidate, plus import-only leads (their oldest non-refuted
-- name/website/phone values). Same token gate, signature, ordering and 2000 limit as 0010.
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
        select l.id, l.last_seen_at,
               coalesce(c.name, (select f.value from public.lead_fields f where f.lead_id = l.id and f.workspace_id = l.workspace_id and f.field = 'name' and f.status <> 'refuted' order by f.created_at, f.id limit 1)) as name,
               case when c.id is not null then c.website
                    else (select f.value from public.lead_fields f where f.lead_id = l.id and f.workspace_id = l.workspace_id and f.field = 'website' and f.status <> 'refuted' order by f.created_at, f.id limit 1) end as website,
               case when c.id is not null then c.phone
                    else (select f.value from public.lead_fields f where f.lead_id = l.id and f.workspace_id = l.workspace_id and f.field = 'phone' and f.status <> 'refuted' order by f.created_at, f.id limit 1) end as phone
          from public.leads l
          left join public.research_candidates c on c.id = l.best_candidate_id
         where l.workspace_id = v_ws and l.origin_run_id is distinct from p_run
         order by l.last_seen_at desc, l.id
         limit 2000
      ) x
     where x.name is not null
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.lead_import_guard(uuid, text[], boolean) from public, anon, authenticated;
revoke all on function public.create_lead_import(uuid, text, text, text, jsonb, boolean) from public, anon;
revoke all on function public.preview_import_rows(uuid, jsonb) from public, anon;
revoke all on function public.import_lead_rows(uuid, jsonb) from public, anon;
revoke all on function public.finish_lead_import(uuid) from public, anon;
revoke all on function public.undo_lead_import(uuid) from public, anon;
grant execute on function public.create_lead_import(uuid, text, text, text, jsonb, boolean) to authenticated;
grant execute on function public.preview_import_rows(uuid, jsonb) to authenticated;
grant execute on function public.import_lead_rows(uuid, jsonb) to authenticated;
grant execute on function public.finish_lead_import(uuid) to authenticated;
grant execute on function public.undo_lead_import(uuid) to authenticated;
revoke all on function public.hunter_known_companies(uuid, uuid) from public, authenticated;
grant execute on function public.hunter_known_companies(uuid, uuid) to anon;
