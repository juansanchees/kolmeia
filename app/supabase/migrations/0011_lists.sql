-- 0011 Lists (F3c-1): upload a CSV/XLSX, every row becomes a lead, every value keeps its source.
--   T1 (this part) lead_fields (one row per value with its source), lead_imports, lead_import_rows, leads.origin_import_id,
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
  import_id uuid not null references public.lead_imports (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  row_number integer not null constraint lead_import_rows_row_number check (row_number between 1 and 5001),
  data jsonb not null constraint lead_import_rows_data check (octet_length(data::text) <= 4000),
  lead_id uuid references public.leads (id) on delete set null,
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

-- ---------------------------------------------------------------- lead_fields: "de onde veio"
create table if not exists public.lead_fields (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
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
create index if not exists lead_fields_key_idx on public.lead_fields (workspace_id, field, key) where key is not null;
create index if not exists lead_fields_lead_idx on public.lead_fields (lead_id);
-- K-2: the same value from another list (another source_ref) is another row; the same value twice from one source is one row.
create unique index if not exists lead_fields_distinct
  on public.lead_fields (lead_id, field, coalesce(key, lower(btrim(value))), source, coalesce(source_ref, ''));

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
    join public.leads l on l.id = m.lead_id
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
create or replace function public.lead_visible_to_assignee(p_lead uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.leads l where l.id = p_lead and l.owner_id = auth.uid());
$$;

-- ---------------------------------------------------------------- privileges and RLS
revoke all on function public.lead_field_key() from public, anon, authenticated;
revoke all on function public.find_lead(uuid, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.link_lead(uuid, uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.unlink_candidate_lead() from public, anon, authenticated;
revoke all on function public.lead_visible_to_assignee(uuid) from public, anon;
grant execute on function public.lead_visible_to_assignee(uuid) to authenticated;

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
  using (public.is_workspace_sender(workspace_id) or public.lead_visible_to_assignee(lead_id));
