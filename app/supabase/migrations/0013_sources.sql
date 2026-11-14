-- 0013 Connected sources (F3d-1): each workspace connects its OWN Apify / Apollo keys (encrypted by the server,
-- never readable by clients), searches are queued on a ledger (source_runs) under a daily cap, and results enter
-- LEADS through the same import core as uploaded files.
--   source_connections   encrypted key + last 4 + caps (no client grant at all)
--   agent_source_settings what a Caçador searches on its own
--   source_runs          one row per external run = the sources ledger (cost, reserve, status)
--   lead_imports.kind    'file' | 'apify_maps' | 'apollo';  lead_fields.source widened
--   import_rows_core     the import logic of 0011 moved here (internal); import_lead_rows wraps it
-- Depends on 0001-0011. Re-runnable. (Numbered 0013: 0012 is on another branch.)

-- ---------------------------------------------------------------- imports: kind and wider sources
alter table public.lead_imports add column if not exists kind text not null default 'file';
alter table public.lead_imports drop constraint if exists lead_imports_kind;
alter table public.lead_imports add constraint lead_imports_kind check (kind in ('file', 'apify_maps', 'apollo'));

alter table public.lead_fields drop constraint if exists lead_fields_source;
alter table public.lead_fields add constraint lead_fields_source check (source in
  ('import', 'site', 'places', 'ai', 'research', 'apify_maps', 'apollo', 'apify_contact'));

-- ---------------------------------------------------------------- helper: a text[] within limits
create or replace function public.source_array_ok(a text[], max_n int, max_len int, pat text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select a is null or (
    coalesce(cardinality(a), 0) <= max_n
    and not exists (select 1 from unnest(a) e where e is null or char_length(e) not between 1 and max_len or e !~ pat)
  );
$$;

-- ---------------------------------------------------------------- connections (no client grant)
create table if not exists public.source_connections (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  provider text not null constraint source_connections_provider check (provider in ('apify', 'apollo')),
  -- AES-256-GCM ciphertext of the key (aad "source:<ws>:<provider>"). Never granted to clients; read only through source_secret().
  secret_ciphertext text not null constraint source_connections_secret_len check (char_length(secret_ciphertext) between 20 and 1000),
  last4 text not null constraint source_connections_last4 check (last4 ~ '^[A-Za-z0-9]{4}$'),
  daily_cap_usd numeric(8,2),
  daily_calls integer,
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, provider),
  constraint source_connections_caps check (
    (provider = 'apify' and daily_calls is null and (daily_cap_usd is null or daily_cap_usd between 0.50 and 50))
    or (provider = 'apollo' and daily_cap_usd is null and (daily_calls is null or daily_calls between 1 and 200))
  )
);

-- ---------------------------------------------------------------- what a Caçador searches on its own
create table if not exists public.agent_source_settings (
  agent_id uuid primary key references public.agents (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  maps_on boolean not null default false,
  maps_terms text[] constraint agent_source_settings_terms check (maps_terms is null or (cardinality(maps_terms) between 1 and 5 and public.source_array_ok(maps_terms, 5, 80, '[^[:space:]]'))),
  maps_location text constraint agent_source_settings_location check (maps_location is null or char_length(maps_location) between 1 and 120),
  maps_max integer not null default 50 constraint agent_source_settings_max check (maps_max between 1 and 200),
  apollo_on boolean not null default false,
  apollo_locations text[] not null default '{}' constraint agent_source_settings_locations check (public.source_array_ok(apollo_locations, 5, 120, '[^[:space:]]')),
  apollo_naics text[] not null default '{}' constraint agent_source_settings_naics check (public.source_array_ok(apollo_naics, 5, 5, '^[0-9]{2,5}$')),
  apollo_pages integer not null default 1 constraint agent_source_settings_pages check (apollo_pages between 1 and 4),
  updated_at timestamptz not null default now(),
  constraint agent_source_settings_maps_ready check (not maps_on or (maps_terms is not null and maps_location is not null))
);
create index if not exists agent_source_settings_ws_idx on public.agent_source_settings (workspace_id);

-- ---------------------------------------------------------------- the ledger
create table if not exists public.source_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  provider text not null constraint source_runs_provider check (provider in ('apify', 'apollo')),
  kind text not null constraint source_runs_kind check (kind in ('maps', 'apollo', 'contact')),
  agent_id uuid references public.agents (id) on delete set null,
  research_run_id uuid references public.research_runs (id) on delete set null,
  requested_by uuid references auth.users (id) on delete set null,
  query jsonb not null default '{}'::jsonb
    constraint source_runs_query check (jsonb_typeof(query) = 'object' and octet_length(query::text) <= 4000),
  max_results integer not null constraint source_runs_max check (max_results between 1 and 200),
  reserve_usd numeric(8,2) not null default 0 constraint source_runs_reserve check (reserve_usd >= 0),
  cost_usd numeric(8,2) constraint source_runs_cost check (cost_usd is null or cost_usd >= 0),
  status text not null default 'queued'
    constraint source_runs_status check (status in ('queued', 'running', 'succeeded', 'imported', 'failed', 'refused')),
  external_run_id text constraint source_runs_external check (external_run_id is null or char_length(external_run_id) <= 100),
  dataset_id text constraint source_runs_dataset check (dataset_id is null or char_length(dataset_id) <= 100),
  error text constraint source_runs_error check (error is null or char_length(error) <= 60),
  found integer,
  dropped integer,
  import_id uuid references public.lead_imports (id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint source_runs_provider_kind check ((provider = 'apify' and kind in ('maps', 'contact')) or (provider = 'apollo' and kind = 'apollo'))
);
create index if not exists source_runs_ws_idx on public.source_runs (workspace_id, created_at desc);
create index if not exists source_runs_open_idx on public.source_runs (status) where status in ('queued', 'running');
create unique index if not exists source_runs_research_kind on public.source_runs (research_run_id, kind) where research_run_id is not null;

-- ---------------------------------------------------------------- day, spend, calls
-- Midnight America/New_York (own helper; no other migration's).
create or replace function public.source_day_start()
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York';
$$;

-- Apify USD today: a queued/running run counts its reserve (or its cost if higher), a finished one its cost.
create or replace function public.source_spent_today(p_ws uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(
    case when r.status in ('queued', 'running') then greatest(r.reserve_usd, coalesce(r.cost_usd, 0))
         when r.status = 'refused' then 0
         else coalesce(r.cost_usd, 0) end), 0)::numeric
    from public.source_runs r
   where r.workspace_id = p_ws and r.provider = 'apify' and r.created_at >= public.source_day_start();
$$;

-- Apollo calls today (every run that was not refused).
create or replace function public.source_calls_today(p_ws uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::int
    from public.source_runs r
   where r.workspace_id = p_ws and r.provider = 'apollo' and r.status <> 'refused' and r.created_at >= public.source_day_start();
$$;

-- ---------------------------------------------------------------- connections: RPCs
create or replace function public.list_source_connections(p_ws uuid)
returns table (provider text, last4 text, daily_cap_usd numeric, daily_calls integer, spent_today_usd numeric, calls_today integer, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_ws is null or not public.is_workspace_sender(p_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select c.provider, c.last4,
           case when c.provider = 'apify' then coalesce(c.daily_cap_usd, 2.00) end,
           case when c.provider = 'apollo' then coalesce(c.daily_calls, 20) end,
           case when c.provider = 'apify' then public.source_spent_today(c.workspace_id) end,
           case when c.provider = 'apollo' then public.source_calls_today(c.workspace_id) end,
           c.updated_at
      from public.source_connections c
     where c.workspace_id = p_ws
     order by c.provider;
end;
$$;

-- p_cap: USD for apify, calls for apollo; null keeps the existing cap (or the default). Out of range -> 23514.
create or replace function public.set_source_connection(p_ws uuid, p_provider text, p_ciphertext text, p_last4 text, p_cap numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_usd numeric(8,2);
  v_calls integer;
begin
  if auth.uid() is null or p_ws is null or not public.is_workspace_owner(p_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_provider is null or p_provider not in ('apify', 'apollo') then
    raise exception 'invalid provider' using errcode = '22023';
  end if;
  if p_provider = 'apify' then
    v_usd := p_cap;
  elsif p_cap is not null then
    if p_cap <> trunc(p_cap) then
      raise exception 'invalid cap' using errcode = '22023';
    end if;
    v_calls := p_cap::int;
  end if;
  insert into public.source_connections (workspace_id, provider, secret_ciphertext, last4, daily_cap_usd, daily_calls, created_by)
  values (p_ws, p_provider, p_ciphertext, p_last4, v_usd, v_calls, auth.uid())
  on conflict (workspace_id, provider) do update
    set secret_ciphertext = excluded.secret_ciphertext,
        last4 = excluded.last4,
        daily_cap_usd = coalesce(excluded.daily_cap_usd, public.source_connections.daily_cap_usd),
        daily_calls = coalesce(excluded.daily_calls, public.source_connections.daily_calls),
        created_by = auth.uid(),
        updated_at = now();
end;
$$;

create or replace function public.set_source_cap(p_ws uuid, p_provider text, p_cap numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_ws is null or not public.is_workspace_owner(p_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_provider is null or p_provider not in ('apify', 'apollo') or p_cap is null then
    raise exception 'invalid cap' using errcode = '22023';
  end if;
  if p_provider = 'apollo' and p_cap <> trunc(p_cap) then
    raise exception 'invalid cap' using errcode = '22023';
  end if;
  update public.source_connections c
     set daily_cap_usd = case when p_provider = 'apify' then p_cap end,
         daily_calls = case when p_provider = 'apollo' then p_cap::int end,
         updated_at = now()
   where c.workspace_id = p_ws and c.provider = p_provider;
  if not found then
    raise exception 'source_not_connected' using errcode = '22023';
  end if;
end;
$$;

-- Deleting the key refuses what is still waiting for it.
create or replace function public.delete_source_connection(p_ws uuid, p_provider text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_ws is null or not public.is_workspace_owner(p_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_provider is null or p_provider not in ('apify', 'apollo') then
    raise exception 'invalid provider' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('source:' || p_ws::text));
  update public.source_runs r
     set status = 'refused', error = 'disconnected', finished_at = now()
   where r.workspace_id = p_ws and r.provider = p_provider and r.status = 'queued';
  delete from public.source_connections c where c.workspace_id = p_ws and c.provider = p_provider;
end;
$$;

-- The ciphertext, for the clock's route to decrypt in memory. Token-gated like 0010's hunter_* (scheduler token header,
-- anon key only); no client can read a stored ciphertext. The old session function is revoked from every client role.
-- source_secret(p_ws, p_provider) (owner session read) is kept only as a revoked stub: no role may execute it.
create or replace function public.source_secret(p_ws uuid, p_provider text)
returns text
language sql
stable
security definer
set search_path = ''
as $$ select null::text $$;
create or replace function public.source_secret_for_tick(p_ws uuid, p_provider text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ct text;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select c.secret_ciphertext into v_ct from public.source_connections c where c.workspace_id = p_ws and c.provider = p_provider;
  return v_ct;
end;
$$;

-- ---------------------------------------------------------------- agent source settings
create or replace function public.set_agent_source_settings(p_agent uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  v_cur public.agent_source_settings;
  v_keys text[];
  v_maps_on boolean;
  v_terms text[];
  v_loc text;
  v_max integer;
  v_apollo_on boolean;
  v_locs text[];
  v_naics text[];
  v_pages integer;
begin
  select a.workspace_id into v_ws from public.agents a where a.id = p_agent;
  if v_ws is null or auth.uid() is null or not public.is_workspace_sender(v_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'invalid settings' using errcode = '22023';
  end if;
  select array_agg(k) into v_keys from jsonb_object_keys(p) k
   where k <> all (array['maps_on', 'maps_terms', 'maps_location', 'maps_max', 'apollo_on', 'apollo_locations', 'apollo_naics', 'apollo_pages']);
  if v_keys is not null then
    raise exception 'invalid settings' using errcode = '22023';
  end if;

  select * into v_cur from public.agent_source_settings s where s.agent_id = p_agent;
  v_maps_on := coalesce(v_cur.maps_on, false);
  v_terms := v_cur.maps_terms;
  v_loc := v_cur.maps_location;
  v_max := coalesce(v_cur.maps_max, 50);
  v_apollo_on := coalesce(v_cur.apollo_on, false);
  v_locs := coalesce(v_cur.apollo_locations, '{}');
  v_naics := coalesce(v_cur.apollo_naics, '{}');
  v_pages := coalesce(v_cur.apollo_pages, 1);

  if p ? 'maps_on' then
    if jsonb_typeof(p -> 'maps_on') <> 'boolean' then raise exception 'invalid settings' using errcode = '22023'; end if;
    v_maps_on := (p ->> 'maps_on')::boolean;
  end if;
  if p ? 'apollo_on' then
    if jsonb_typeof(p -> 'apollo_on') <> 'boolean' then raise exception 'invalid settings' using errcode = '22023'; end if;
    v_apollo_on := (p ->> 'apollo_on')::boolean;
  end if;
  if p ? 'maps_location' then
    if jsonb_typeof(p -> 'maps_location') not in ('string', 'null') then raise exception 'invalid settings' using errcode = '22023'; end if;
    v_loc := nullif(btrim(p ->> 'maps_location'), '');
  end if;
  if p ? 'maps_max' then
    if jsonb_typeof(p -> 'maps_max') <> 'number' or (p ->> 'maps_max') !~ '^[0-9]{1,4}$' then raise exception 'invalid settings' using errcode = '22023'; end if;
    v_max := (p ->> 'maps_max')::int;
  end if;
  if p ? 'apollo_pages' then
    if jsonb_typeof(p -> 'apollo_pages') <> 'number' or (p ->> 'apollo_pages') !~ '^[0-9]{1,4}$' then raise exception 'invalid settings' using errcode = '22023'; end if;
    v_pages := (p ->> 'apollo_pages')::int;
  end if;
  if p ? 'maps_terms' then
    if jsonb_typeof(p -> 'maps_terms') = 'null' then
      v_terms := null;
    elsif jsonb_typeof(p -> 'maps_terms') <> 'array' or exists (select 1 from jsonb_array_elements(p -> 'maps_terms') e where jsonb_typeof(e) <> 'string') then
      raise exception 'invalid settings' using errcode = '22023';
    else
      v_terms := array(select btrim(e) from jsonb_array_elements_text(p -> 'maps_terms') e);
    end if;
  end if;
  if p ? 'apollo_locations' then
    if jsonb_typeof(p -> 'apollo_locations') <> 'array' or exists (select 1 from jsonb_array_elements(p -> 'apollo_locations') e where jsonb_typeof(e) <> 'string') then
      raise exception 'invalid settings' using errcode = '22023';
    end if;
    v_locs := array(select btrim(e) from jsonb_array_elements_text(p -> 'apollo_locations') e);
  end if;
  if p ? 'apollo_naics' then
    if jsonb_typeof(p -> 'apollo_naics') <> 'array' or exists (select 1 from jsonb_array_elements(p -> 'apollo_naics') e where jsonb_typeof(e) <> 'string') then
      raise exception 'invalid settings' using errcode = '22023';
    end if;
    v_naics := array(select btrim(e) from jsonb_array_elements_text(p -> 'apollo_naics') e);
  end if;

  -- value limits (length, count, range) are the table's checks: 23514
  insert into public.agent_source_settings (agent_id, workspace_id, maps_on, maps_terms, maps_location, maps_max, apollo_on, apollo_locations, apollo_naics, apollo_pages)
  values (p_agent, v_ws, v_maps_on, v_terms, v_loc, v_max, v_apollo_on, v_locs, v_naics, v_pages)
  on conflict (agent_id) do update
    set maps_on = excluded.maps_on, maps_terms = excluded.maps_terms, maps_location = excluded.maps_location, maps_max = excluded.maps_max,
        apollo_on = excluded.apollo_on, apollo_locations = excluded.apollo_locations, apollo_naics = excluded.apollo_naics,
        apollo_pages = excluded.apollo_pages, updated_at = now();
end;
$$;

-- ---------------------------------------------------------------- enqueue (the only way a client starts a search)
-- Errors: 42501 not allowed; 22023 bad input or source_not_connected; P0001 source_cap (daily cap reached).
create or replace function public.enqueue_source_run(p_ws uuid, p_kind text, p_query jsonb, p_max int)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider text;
  v_conn public.source_connections;
  v_keys text[];
  v_reserve numeric(8,2) := 0;
  v_id uuid;
begin
  if auth.uid() is null or p_ws is null or not public.is_workspace_sender(p_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('maps', 'apollo') then
    raise exception 'invalid kind' using errcode = '22023';
  end if;
  if p_max is null or p_max not between 1 and 200 or p_query is null or jsonb_typeof(p_query) <> 'object' or octet_length(p_query::text) > 4000 then
    raise exception 'invalid query' using errcode = '22023';
  end if;
  v_provider := case p_kind when 'maps' then 'apify' else 'apollo' end;

  if p_kind = 'maps' then
    select array_agg(k) into v_keys from jsonb_object_keys(p_query) k where k <> all (array['terms', 'location', 'label']);
    if v_keys is not null
       or jsonb_typeof(p_query -> 'terms') is distinct from 'array'
       or jsonb_array_length(p_query -> 'terms') not between 1 and 5
       or exists (select 1 from jsonb_array_elements(p_query -> 'terms') e where jsonb_typeof(e) <> 'string' or char_length(btrim(e #>> '{}')) not between 1 and 80)
       or jsonb_typeof(p_query -> 'location') is distinct from 'string'
       or char_length(btrim(p_query ->> 'location')) not between 1 and 120
       or (p_query ? 'label' and (jsonb_typeof(p_query -> 'label') <> 'string' or char_length(p_query ->> 'label') > 60)) then
      raise exception 'invalid query' using errcode = '22023';
    end if;
    v_reserve := greatest(0.50, ceil(p_max * 0.004 * 100) / 100);
  else
    select array_agg(k) into v_keys from jsonb_object_keys(p_query) k where k <> all (array['locations', 'naics', 'pages', 'label']);
    if v_keys is not null
       or (p_query ? 'locations' and (jsonb_typeof(p_query -> 'locations') <> 'array' or jsonb_array_length(p_query -> 'locations') > 5
           or exists (select 1 from jsonb_array_elements(p_query -> 'locations') e where jsonb_typeof(e) <> 'string' or char_length(btrim(e #>> '{}')) not between 1 and 120)))
       or (p_query ? 'naics' and (jsonb_typeof(p_query -> 'naics') <> 'array' or jsonb_array_length(p_query -> 'naics') > 5
           or exists (select 1 from jsonb_array_elements(p_query -> 'naics') e where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^[0-9]{2,5}$')))
       or (p_query ? 'pages' and (jsonb_typeof(p_query -> 'pages') <> 'number' or (p_query ->> 'pages') !~ '^[1-4]$'))
       or (p_query ? 'label' and (jsonb_typeof(p_query -> 'label') <> 'string' or char_length(p_query ->> 'label') > 60)) then
      raise exception 'invalid query' using errcode = '22023';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('source:' || p_ws::text));

  select * into v_conn from public.source_connections c where c.workspace_id = p_ws and c.provider = v_provider;
  if not found then
    raise exception 'source_not_connected' using errcode = '22023';
  end if;
  if v_provider = 'apify' then
    if public.source_spent_today(p_ws) + v_reserve > coalesce(v_conn.daily_cap_usd, 2.00) then
      raise exception 'source_cap';
    end if;
  elsif public.source_calls_today(p_ws) >= coalesce(v_conn.daily_calls, 20) then
    raise exception 'source_cap';
  end if;

  insert into public.source_runs (workspace_id, provider, kind, requested_by, query, max_results, reserve_usd)
  values (p_ws, v_provider, p_kind, auth.uid(), p_query, p_max, v_reserve)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- the import core (moved from import_lead_rows, 0011)
-- Internal: no grant. Callers authorize; p_source is 'import' (files) | 'apify_maps' | 'apollo' and must match the import's kind.
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
  select * into v_imp from public.lead_imports i where i.id = p_import for update;
  if not found then
    raise exception 'import not found' using errcode = '22023';
  end if;
  if v_imp.status <> 'importing' then
    raise exception 'import is %', v_imp.status using errcode = '22023';
  end if;
  if p_source is null or not ((p_source = 'import' and v_imp.kind = 'file') or (p_source = v_imp.kind and p_source in ('apify_maps', 'apollo'))) then
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

-- The file path (F3c-1): authorization here, the whole import logic in import_rows_core. Behavior unchanged.
create or replace function public.import_lead_rows(p_import uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_imp public.lead_imports;
begin
  v_imp := public.lead_import_guard(p_import, array['importing'], true);
  if v_imp.kind <> 'file' then
    raise exception 'import is %', v_imp.kind using errcode = '22023';
  end if;
  return public.import_rows_core(p_import, p_rows, 'import');
end;
$$;

-- K-9 undo (0011) now also recognises values written by the sources.
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
            or exists (select 1 from public.lead_fields f where f.lead_id = l.id and f.workspace_id = v_ws and f.source in ('import', 'apify_maps', 'apollo') and f.source_ref = p_import::text))
     order by l.created_at, l.id
  loop
    if v_lead.origin_import_id is not distinct from p_import
       and not exists (select 1 from public.research_candidates c where c.lead_id = v_lead.id)
       and not exists (select 1 from public.lead_fields f where f.lead_id = v_lead.id and not (f.source in ('import', 'apify_maps', 'apollo') and f.source_ref = p_import::text))
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
         where f.lead_id = v_lead.id and f.source in ('import', 'apify_maps', 'apollo') and f.source_ref <> p_import::text and i.status <> 'undone'
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
   where f.workspace_id = v_ws and f.source in ('import', 'apify_maps', 'apollo') and f.source_ref = p_import::text
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

-- ---------------------------------------------------------------- privileges and RLS
revoke all on function public.source_array_ok(text[], int, int, text) from public, anon, authenticated;
revoke all on function public.source_day_start() from public, anon, authenticated;
revoke all on function public.source_spent_today(uuid) from public, anon, authenticated;
revoke all on function public.source_calls_today(uuid) from public, anon, authenticated;
revoke all on function public.import_rows_core(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.list_source_connections(uuid) from public, anon;
revoke all on function public.set_source_connection(uuid, text, text, text, numeric) from public, anon;
revoke all on function public.set_source_cap(uuid, text, numeric) from public, anon;
revoke all on function public.delete_source_connection(uuid, text) from public, anon;
revoke all on function public.source_secret(uuid, text) from public, anon, authenticated;
revoke all on function public.source_secret_for_tick(uuid, text) from public, authenticated;
revoke all on function public.set_agent_source_settings(uuid, jsonb) from public, anon;
revoke all on function public.enqueue_source_run(uuid, text, jsonb, int) from public, anon;
revoke all on function public.import_lead_rows(uuid, jsonb) from public, anon;
revoke all on function public.undo_lead_import(uuid) from public, anon;
grant execute on function public.list_source_connections(uuid) to authenticated;
grant execute on function public.set_source_connection(uuid, text, text, text, numeric) to authenticated;
grant execute on function public.set_source_cap(uuid, text, numeric) to authenticated;
grant execute on function public.delete_source_connection(uuid, text) to authenticated;
grant execute on function public.source_secret_for_tick(uuid, text) to anon;
grant execute on function public.set_agent_source_settings(uuid, jsonb) to authenticated;
grant execute on function public.enqueue_source_run(uuid, text, jsonb, int) to authenticated;
grant execute on function public.import_lead_rows(uuid, jsonb) to authenticated;
grant execute on function public.undo_lead_import(uuid) to authenticated;

revoke all on table public.source_connections from public, anon, authenticated;
revoke all on table public.agent_source_settings from public, anon, authenticated;
revoke all on table public.source_runs from public, anon, authenticated;
grant select on table public.agent_source_settings to authenticated;
grant select on table public.source_runs to authenticated;

alter table public.source_connections enable row level security;
alter table public.source_connections force row level security;
alter table public.agent_source_settings enable row level security;
alter table public.agent_source_settings force row level security;
alter table public.source_runs enable row level security;
alter table public.source_runs force row level security;

drop policy if exists agent_source_settings_select on public.agent_source_settings;
create policy agent_source_settings_select on public.agent_source_settings
  for select to authenticated using (public.is_workspace_sender(workspace_id));
drop policy if exists source_runs_select on public.source_runs;
create policy source_runs_select on public.source_runs
  for select to authenticated using (public.is_workspace_sender(workspace_id));
