-- 0034 RapidAPI as a fourth connected source. ONE key covers two APIs:
--   B2B Lead Finder         kind 'b2b': decision-makers of companies (a list "Decisores: <setor> <UF> (dd/mm)", lead_fields
--                           source 'rapidapi_b2b'). Cap: calls per rolling 30 days (monthly_records, default 10 = free plan).
--   Website Contact Finder  kind 'contact' with provider 'rapidapi': the e-mails a company's own site shows (lead_fields
--                           source 'rapidapi_contact', the page as proof). Asked BEFORE the paid Apify contact scraper, by the
--                           Qualificador (qualifier_request_contacts) and by "Achar e-mail" (request_site_contact).
--                           Cap: sites per rolling 30 days (new column monthly_sites, default 30 = free plan).
--   list_source_connections  + monthly_sites, used_sites (return type changes: dropped and recreated)
--   set_source_connection / set_source_cap / delete_source_connection / enqueue_source_run / import_rows_core /
--   undo_lead_import / source_next_work / source_import (0033), requeue_lead_on_import (0019), source_add_contacts /
--   qualifier_request_contacts (0016): the same functions with 'rapidapi' added.
-- Depends on 0013, 0016, 0019, 0033. Re-runnable. Nothing is dropped or rewritten in the data.

-- ---------------------------------------------------------------- constraints
alter table public.lead_imports drop constraint if exists lead_imports_kind;
alter table public.lead_imports add constraint lead_imports_kind check (kind in ('file', 'apify_maps', 'apollo', 'shovels', 'rapidapi_b2b'));

alter table public.lead_fields drop constraint if exists lead_fields_source;
alter table public.lead_fields add constraint lead_fields_source check (source in
  ('import', 'site', 'places', 'ai', 'research', 'apify_maps', 'apollo', 'apify_contact', 'pattern', 'shovels', 'rapidapi_b2b', 'rapidapi_contact'));

alter table public.source_connections add column if not exists monthly_sites integer;
alter table public.source_connections drop constraint if exists source_connections_provider;
alter table public.source_connections add constraint source_connections_provider check (provider in ('apify', 'apollo', 'shovels', 'rapidapi'));
alter table public.source_connections drop constraint if exists source_connections_caps;
alter table public.source_connections add constraint source_connections_caps check (
  (provider = 'apify' and daily_calls is null and monthly_records is null and monthly_sites is null and (daily_cap_usd is null or daily_cap_usd between 0.50 and 50))
  or (provider = 'apollo' and daily_cap_usd is null and monthly_records is null and monthly_sites is null and (daily_calls is null or daily_calls between 1 and 200))
  or (provider = 'shovels' and daily_cap_usd is null and daily_calls is null and monthly_sites is null and (monthly_records is null or monthly_records between 50 and 50000))
  or (provider = 'rapidapi' and daily_cap_usd is null and daily_calls is null
      and (monthly_records is null or monthly_records between 1 and 5000) and (monthly_sites is null or monthly_sites between 1 and 50000))
);

alter table public.source_runs drop constraint if exists source_runs_provider;
alter table public.source_runs add constraint source_runs_provider check (provider in ('apify', 'apollo', 'shovels', 'rapidapi'));
alter table public.source_runs drop constraint if exists source_runs_kind;
alter table public.source_runs add constraint source_runs_kind check (kind in ('maps', 'apollo', 'contact', 'shovels', 'b2b'));
alter table public.source_runs drop constraint if exists source_runs_provider_kind;
alter table public.source_runs add constraint source_runs_provider_kind check (
  (provider = 'apify' and kind in ('maps', 'contact')) or (provider = 'apollo' and kind = 'apollo') or (provider = 'shovels' and kind = 'shovels')
  or (provider = 'rapidapi' and kind in ('b2b', 'contact')));

-- ---------------------------------------------------------------- re-queue trigger: RapidAPI values are imported values
drop trigger if exists requeue_lead_on_import on public.lead_fields;
create trigger requeue_lead_on_import
  after insert on public.lead_fields
  for each row
  when (new.source in ('import', 'apify_maps', 'apollo', 'apify_contact', 'shovels', 'rapidapi_b2b', 'rapidapi_contact'))
  execute function public.requeue_lead_on_import();

-- ---------------------------------------------------------------- RapidAPI use in the rolling 30 days
-- p_kind 'b2b': calls (one per run). p_kind 'contact': company sites read (one call each).
-- A queued/running run counts what it may still use (1 call, or its leads); an imported one what it used (contact: found
-- = the sites really asked). A failed run counts as used, except for the codes that happen before any call (no credits,
-- key refused or unreadable, disconnected, unsupported, no leads, a 429 plan-limit answer). Any other 4xx counts: it is
-- not known whether RapidAPI bills it. Refused runs count 0.
-- 31 days, not 30: a billing month of up to 31 days then never holds more than the cap. (Shovels' own window in 0033's
-- source_month_records is not touched here.)
create or replace function public.source_month_rapidapi(p_ws uuid, p_kind text)
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(
    case when r.status in ('queued', 'running') then (case when r.kind = 'b2b' then 1 else n.leads end)
         when r.status = 'imported' then (case when r.kind = 'b2b' then 1 else coalesce(r.found, n.leads) end)
         when r.status = 'failed' and coalesce(r.error, '') not in ('credits', 'key', 'key_unreadable', 'disconnected', 'unsupported', 'no_leads')
              and coalesce(r.error, '') <> 'http_429' then (case when r.kind = 'b2b' then 1 else n.leads end)
         else 0 end), 0)::int
    from public.source_runs r
    cross join lateral (select count(*)::int as leads from public.source_run_leads l where l.run_id = r.id) n
   where r.workspace_id = p_ws and r.provider = 'rapidapi' and r.kind = p_kind and r.created_at >= now() - interval '31 days';
$$;

-- Puts a lead's site in the workspace's open RapidAPI contact run (or opens one). The caller holds the workspace's
-- 'source:' lock. True = the lead is (now, or already) in an open RapidAPI contact run. False = nothing asked: no RapidAPI
-- connection, no site left this month, or RapidAPI already read this lead's site in the last 30 days.
create or replace function public.source_queue_site_contact(p_ws uuid, p_lead uuid, p_url text, p_by uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cap integer;
  v_run uuid;
begin
  select coalesce(c.monthly_sites, 30) into v_cap from public.source_connections c where c.workspace_id = p_ws and c.provider = 'rapidapi';
  if not found then
    return false;
  end if;
  if exists (select 1 from public.source_run_leads l join public.source_runs r on r.id = l.run_id
              where l.lead_id = p_lead and r.kind = 'contact' and r.status in ('queued', 'running')) then -- an open Apify run counts too
    return true;
  end if;
  if exists (select 1 from public.source_run_leads l join public.source_runs r on r.id = l.run_id
              where l.lead_id = p_lead and r.provider = 'rapidapi' and r.kind = 'contact' and r.created_at > now() - interval '30 days'
                and (r.status = 'imported' or (r.status = 'failed' and coalesce(r.error, '') not in ('key', 'key_unreadable', 'disconnected')))) then
    return false;
  end if;
  if public.source_month_rapidapi(p_ws, 'contact') + 1 > v_cap then
    return false;
  end if;
  select r.id into v_run
    from public.source_runs r
   where r.workspace_id = p_ws and r.provider = 'rapidapi' and r.kind = 'contact' and r.status = 'queued' and r.start_claimed_at is null
     and (select count(*) from public.source_run_leads l where l.run_id = r.id) < 10
   order by r.created_at, r.id
   limit 1
     for update;
  if v_run is null then
    insert into public.source_runs (workspace_id, provider, kind, requested_by, query, max_results, reserve_usd)
    values (p_ws, 'rapidapi', 'contact', p_by, jsonb_build_object('label', 'E-mails do site'), 10, 0)
    returning id into v_run;
  end if;
  insert into public.source_run_leads (run_id, lead_id, start_url) values (v_run, p_lead, p_url);
  return true;
end;
$$;

-- "Achar e-mail" (a sender, in the app): ask RapidAPI for the e-mails one lead's own site shows. Same answer as above.
create or replace function public.request_site_contact(p_ws uuid, p_lead uuid, p_url text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text := btrim(p_url);
begin
  if auth.uid() is null or p_ws is null or not public.is_workspace_sender(p_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_lead is null or not exists (select 1 from public.leads l where l.id = p_lead and l.workspace_id = p_ws) then
    raise exception 'lead not found' using errcode = '22023';
  end if;
  if v_url is null or char_length(v_url) > 2000 or v_url !~* '^https?://[^/?#[:space:]]+' or v_url ~ '[[:space:]]' or not public.is_safe_url(v_url) then
    raise exception 'invalid url' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('source:' || p_ws::text));
  return public.source_queue_site_contact(p_ws, p_lead, v_url, auth.uid());
end;
$$;

-- ---------------------------------------------------------------- connections: RPCs
drop function if exists public.list_source_connections(uuid);
create function public.list_source_connections(p_ws uuid)
returns table (provider text, last4 text, daily_cap_usd numeric, daily_calls integer, spent_today_usd numeric, calls_today integer,
               monthly_records integer, used_month integer, monthly_sites integer, used_sites integer, updated_at timestamptz)
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
           case when c.provider = 'shovels' then coalesce(c.monthly_records, 500) when c.provider = 'rapidapi' then coalesce(c.monthly_records, 10) end,
           case when c.provider = 'shovels' then public.source_month_records(c.workspace_id)
                when c.provider = 'rapidapi' then public.source_month_rapidapi(c.workspace_id, 'b2b') end,
           case when c.provider = 'rapidapi' then coalesce(c.monthly_sites, 30) end,
           case when c.provider = 'rapidapi' then public.source_month_rapidapi(c.workspace_id, 'contact') end,
           c.updated_at
      from public.source_connections c
     where c.workspace_id = p_ws
     order by c.provider;
end;
$$;

-- 0033's set_source_connection + 'rapidapi' (its p_cap is the B2B calls per 30 days -> monthly_records).
create or replace function public.set_source_connection(p_ws uuid, p_provider text, p_ciphertext text, p_last4 text, p_cap numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_usd numeric(8,2);
  v_calls integer;
  v_records integer;
begin
  if auth.uid() is null or p_ws is null or not public.is_workspace_owner(p_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_provider is null or p_provider not in ('apify', 'apollo', 'shovels', 'rapidapi') then
    raise exception 'invalid provider' using errcode = '22023';
  end if;
  if p_provider = 'apify' then
    v_usd := p_cap;
  elsif p_cap is not null then
    if p_cap <> trunc(p_cap) then
      raise exception 'invalid cap' using errcode = '22023';
    end if;
    if p_provider = 'apollo' then
      v_calls := p_cap::int;
    else
      v_records := p_cap::int;
    end if;
  end if;
  insert into public.source_connections (workspace_id, provider, secret_ciphertext, last4, daily_cap_usd, daily_calls, monthly_records, created_by)
  values (p_ws, p_provider, p_ciphertext, p_last4, v_usd, v_calls, v_records, auth.uid())
  on conflict (workspace_id, provider) do update
    set secret_ciphertext = excluded.secret_ciphertext,
        last4 = excluded.last4,
        daily_cap_usd = coalesce(excluded.daily_cap_usd, public.source_connections.daily_cap_usd),
        daily_calls = coalesce(excluded.daily_calls, public.source_connections.daily_calls),
        monthly_records = coalesce(excluded.monthly_records, public.source_connections.monthly_records),
        created_by = auth.uid(),
        updated_at = now();
end;
$$;
-- 0033's set_source_cap + 'rapidapi' (B2B calls) and 'rapidapi_sites' (the e-mail cap of the same connection).
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
  if p_provider is null or p_provider not in ('apify', 'apollo', 'shovels', 'rapidapi', 'rapidapi_sites') or p_cap is null then
    raise exception 'invalid cap' using errcode = '22023';
  end if;
  if p_provider <> 'apify' and p_cap <> trunc(p_cap) then
    raise exception 'invalid cap' using errcode = '22023';
  end if;
  if p_provider = 'rapidapi_sites' then
    -- 0034: the second RapidAPI cap (company sites read per 30 days); the B2B cap is left as it is
    update public.source_connections c
       set monthly_sites = p_cap::int, updated_at = now()
     where c.workspace_id = p_ws and c.provider = 'rapidapi';
    if not found then
      raise exception 'source_not_connected' using errcode = '22023';
    end if;
    return;
  end if;
  update public.source_connections c
     set daily_cap_usd = case when p_provider = 'apify' then p_cap end,
         daily_calls = case when p_provider = 'apollo' then p_cap::int end,
         monthly_records = case when p_provider in ('shovels', 'rapidapi') then p_cap::int end,
         updated_at = now()
   where c.workspace_id = p_ws and c.provider = p_provider;
  if not found then
    raise exception 'source_not_connected' using errcode = '22023';
  end if;
end;
$$;

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
  if p_provider is null or p_provider not in ('apify', 'apollo', 'shovels', 'rapidapi') then
    raise exception 'invalid provider' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('source:' || p_ws::text));
  update public.source_runs r
     set status = 'refused', error = 'disconnected', finished_at = now()
   where r.workspace_id = p_ws and r.provider = p_provider and r.status = 'queued';
  delete from public.source_connections c where c.workspace_id = p_ws and c.provider = p_provider;
end;
$$;

-- ---------------------------------------------------------------- enqueue (0033 + b2b: one call per run, the monthly call cap)
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
  v_max int := p_max;
  v_left int;
  v_id uuid;
  v_query jsonb := p_query;
  v_page int;
begin
  if auth.uid() is null or p_ws is null or not public.is_workspace_sender(p_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('maps', 'apollo', 'shovels', 'b2b') then
    raise exception 'invalid kind' using errcode = '22023';
  end if;
  if p_max is null or p_max not between 1 and 200 or p_query is null or jsonb_typeof(p_query) <> 'object' or octet_length(p_query::text) > 4000 then
    raise exception 'invalid query' using errcode = '22023';
  end if;
  v_provider := case p_kind when 'maps' then 'apify' when 'shovels' then 'shovels' when 'b2b' then 'rapidapi' else 'apollo' end;

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
  elsif p_kind = 'shovels' then
    -- 0033: a MA place ('' = the whole state; the clock resolves it), a permit-type preset, 1..100 records (one page)
    select array_agg(k) into v_keys from jsonb_object_keys(p_query) k where k <> all (array['place', 'tag', 'label']);
    if v_keys is not null or p_max > 100
       or jsonb_typeof(p_query -> 'place') is distinct from 'string' or char_length(p_query ->> 'place') > 80
       or jsonb_typeof(p_query -> 'tag') is distinct from 'string' or (p_query ->> 'tag') not in ('all', 'new_construction', 'hvac')
       or (p_query ? 'label' and (jsonb_typeof(p_query -> 'label') <> 'string' or char_length(p_query ->> 'label') > 60)) then
      raise exception 'invalid query' using errcode = '22023';
    end if;
  elsif p_kind = 'b2b' then
    -- 0034: RapidAPI B2B Lead Finder presets (one call = one page; the page number is set here, never by the client)
    select array_agg(k) into v_keys from jsonb_object_keys(p_query) k where k <> all (array['state', 'sector', 'size', 'role', 'label']);
    if v_keys is not null
       or jsonb_typeof(p_query -> 'state') is distinct from 'string' or (p_query ->> 'state') not in ('MA', 'CT', 'RI', 'NH', 'ME', 'VT', 'NY')
       or jsonb_typeof(p_query -> 'sector') is distinct from 'string' or (p_query ->> 'sector') not in ('construction', 'real_estate', 'architecture')
       or jsonb_typeof(p_query -> 'size') is distinct from 'string' or (p_query ->> 'size') not in ('1-10', '11-50', '51-200', '201-500')
       or jsonb_typeof(p_query -> 'role') is distinct from 'string' or (p_query ->> 'role') not in ('founder', 'partner', 'c-suite', 'director', 'manager')
       or (p_query ? 'label' and (jsonb_typeof(p_query -> 'label') <> 'string' or char_length(p_query ->> 'label') > 60)) then
      raise exception 'invalid query' using errcode = '22023';
    end if;
    v_max := 100;
  else
    select array_agg(k) into v_keys from jsonb_object_keys(p_query) k where k <> all (array['locations', 'naics', 'pages', 'label']);
    if v_keys is not null
       or (p_query ? 'locations' and (jsonb_typeof(p_query -> 'locations') <> 'array' or jsonb_array_length(p_query -> 'locations') > 5
           or exists (select 1 from jsonb_array_elements(p_query -> 'locations') e where jsonb_typeof(e) <> 'string' or char_length(btrim(e #>> '{}')) not between 1 and 120)))
       or (p_query ? 'naics' and (jsonb_typeof(p_query -> 'naics') <> 'array' or jsonb_array_length(p_query -> 'naics') > 5
           or exists (select 1 from jsonb_array_elements(p_query -> 'naics') e where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^[0-9]{2,6}$')))
       or (p_query ? 'pages' and (jsonb_typeof(p_query -> 'pages') <> 'number' or (p_query ->> 'pages') !~ '^[1-4]$'))
       or (p_query ? 'label' and (jsonb_typeof(p_query -> 'label') <> 'string' or char_length(p_query ->> 'label') > 60)) then
      raise exception 'invalid query' using errcode = '22023';
    end if;
    -- Apollo needs at least one filter
    if coalesce(jsonb_array_length(p_query -> 'locations'), 0) + coalesce(jsonb_array_length(p_query -> 'naics'), 0) = 0 then
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
  elsif v_provider = 'shovels' then
    -- never ask for more records than the monthly cap leaves: the run is clamped, and refused when nothing is left
    v_left := coalesce(v_conn.monthly_records, 500) - public.source_month_records(p_ws);
    if v_left < 1 then
      raise exception 'source_cap';
    end if;
    v_max := least(p_max, v_left);
  elsif v_provider = 'rapidapi' then
    -- 0034: one B2B call per run, counted against the calls per rolling 30 days
    if public.source_month_rapidapi(p_ws, 'b2b') + 1 > coalesce(v_conn.monthly_records, 10) then
      raise exception 'source_cap';
    end if;
    -- the next page for the same filters: pages already imported with results since the last empty page (an empty page = the end, start over)
    select count(*) + 1 into v_page
      from public.source_runs r
     where r.workspace_id = p_ws and r.kind = 'b2b' and (r.status in ('queued', 'running') or (r.status = 'imported' and coalesce(r.found, 0) > 0))
       and (r.query - 'label' - 'page') = (p_query - 'label')
       and r.created_at > coalesce((select max(x.created_at) from public.source_runs x
                                     where x.workspace_id = p_ws and x.kind = 'b2b' and x.status = 'imported' and coalesce(x.found, 0) = 0
                                       and (x.query - 'label' - 'page') = (p_query - 'label')), '-infinity'::timestamptz);
    v_query := p_query || jsonb_build_object('page', least(v_page, 1000));
  elsif public.source_calls_today(p_ws) >= coalesce(v_conn.daily_calls, 20) then
    raise exception 'source_cap';
  end if;

  insert into public.source_runs (workspace_id, provider, kind, requested_by, query, max_results, reserve_usd)
  values (p_ws, v_provider, p_kind, auth.uid(), v_query, v_max, v_reserve)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- the import core (0033 + rapidapi_b2b)
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
  if p_source is null or not ((p_source = 'import' and v_imp.kind = 'file') or (p_source = v_imp.kind and p_source in ('apify_maps', 'apollo', 'shovels', 'rapidapi_b2b'))) then
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

-- K-9 undo (0033) also recognises values written by the RapidAPI B2B search.
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
            or exists (select 1 from public.lead_fields f where f.lead_id = l.id and f.workspace_id = v_ws and f.source in ('import', 'apify_maps', 'apollo', 'shovels', 'rapidapi_b2b') and f.source_ref = p_import::text))
     order by l.created_at, l.id
  loop
    if v_lead.origin_import_id is not distinct from p_import
       and not exists (select 1 from public.research_candidates c where c.lead_id = v_lead.id)
       and not exists (select 1 from public.lead_fields f where f.lead_id = v_lead.id and not (f.source in ('import', 'apify_maps', 'apollo', 'shovels', 'rapidapi_b2b') and f.source_ref = p_import::text))
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
         where f.lead_id = v_lead.id and f.source in ('import', 'apify_maps', 'apollo', 'shovels', 'rapidapi_b2b') and f.source_ref <> p_import::text and i.status <> 'undone'
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
   where f.workspace_id = v_ws and f.source in ('import', 'apify_maps', 'apollo', 'shovels', 'rapidapi_b2b') and f.source_ref = p_import::text
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

-- ---------------------------------------------------------------- tick path
-- 0033's source_next_work + the RapidAPI caps; a RapidAPI contact run has no minimum charge, so it does not wait for company.
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
  v_cap_records integer;
  v_cap_sites integer;
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
    if v.kind = 'contact' and v.provider = 'apify' and v.created_at > now() - interval '10 minutes'
       and (select count(*) from public.source_run_leads l where l.run_id = v.id) < 10 then
      continue;
    end if;
    select c.secret_ciphertext, c.daily_cap_usd, c.daily_calls, c.monthly_records, c.monthly_sites into v_ct, v_cap_usd, v_cap_calls, v_cap_records, v_cap_sites
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
    elsif v.provider = 'shovels' then
      -- 0033: records in the rolling 30 days; a queued run counts its max_results (younger queued runs left out)
      v_over := public.source_month_records(v.workspace_id) - coalesce((
          select sum(x.max_results) from public.source_runs x
           where x.workspace_id = v.workspace_id and x.provider = 'shovels' and x.status = 'queued' and x.created_at >= now() - interval '30 days' and (x.created_at, x.id) > (v.created_at, v.id)), 0)
        > coalesce(v_cap_records, 500);
    elsif v.provider = 'rapidapi' and v.kind = 'b2b' then
      -- 0034: B2B calls in the rolling 30 days (younger queued runs left out)
      v_over := public.source_month_rapidapi(v.workspace_id, 'b2b') - (
          select count(*) from public.source_runs x
           where x.workspace_id = v.workspace_id and x.provider = 'rapidapi' and x.kind = 'b2b' and x.status = 'queued' and x.created_at >= now() - interval '31 days' and (x.created_at, x.id) > (v.created_at, v.id))
        > coalesce(v_cap_records, 10);
    elsif v.provider = 'rapidapi' then
      -- 0034: company sites in the rolling 30 days; a queued run counts its leads (younger queued runs left out)
      v_over := public.source_month_rapidapi(v.workspace_id, 'contact') - coalesce((
          select count(*) from public.source_run_leads l join public.source_runs x on x.id = l.run_id
           where x.workspace_id = v.workspace_id and x.provider = 'rapidapi' and x.kind = 'contact' and x.status = 'queued' and x.created_at >= now() - interval '31 days' and (x.created_at, x.id) > (v.created_at, v.id)), 0)
        > coalesce(v_cap_sites, 30);
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

-- 0033's source_import + b2b: list "Decisores: <setor> <UF> (dd/mm)" (or the label).
create or replace function public.source_import(p_tick uuid, p_run uuid, p_rows jsonb, p_found int, p_dropped int, p_cost numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.source_runs;
  v_imp uuid;
  v_kind text;
  v_label text;
  v_total int;
  v_off int := 0;
  v_new int := 0;
  v_merged int := 0;
  v_res jsonb;
  v_day text;
begin
  perform public.source_assert_tick(p_tick);
  select * into v_run from public.source_runs r where r.id = p_run for update;
  if not found or not (v_run.status = 'running' or (v_run.status = 'succeeded' and v_run.import_id is null)) or v_run.import_id is not null then
    raise exception 'run is not importable' using errcode = '22023';
  end if;
  if v_run.kind not in ('maps', 'apollo', 'shovels', 'b2b') then
    raise exception 'invalid kind' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > v_run.max_results + 20
     or p_found is null or p_dropped is null or p_found not between 0 and 10000 or p_dropped not between 0 and 10000
     or (p_cost is not null and (p_cost < 0 or p_cost > 1000)) then
    raise exception 'invalid rows' using errcode = '22023';
  end if;
  v_kind := case v_run.kind when 'maps' then 'apify_maps' when 'shovels' then 'shovels' when 'b2b' then 'rapidapi_b2b' else 'apollo' end;
  v_label := coalesce(nullif(btrim(v_run.query ->> 'label'), ''),
                      case when v_run.kind = 'shovels' then coalesce(nullif(btrim(v_run.query ->> 'place'), ''), 'MA')
                           when v_run.kind = 'b2b' then (case v_run.query ->> 'sector' when 'construction' then 'Construção' when 'real_estate' then 'Imóveis' when 'architecture' then 'Arquitetura' else 'B2B' end)
                                                        || ' ' || coalesce(v_run.query ->> 'state', '')
                           else 'busca' end);
  v_day := to_char(now() at time zone 'America/New_York', 'DD/MM');
  insert into public.lead_imports (workspace_id, created_by, kind, file_name, list_name, status)
  values (v_run.workspace_id, v_run.requested_by, v_kind,
          case v_run.kind when 'maps' then 'Google Maps (Apify)' when 'shovels' then 'Shovels (alvarás)' when 'b2b' then 'RapidAPI (decisores)' else 'Apollo' end,
          case when v_run.kind = 'shovels' then 'Shovels: ' || left(v_label, 60) || ' (' || v_day || ')'
               when v_run.kind = 'b2b' then 'Decisores: ' || left(v_label, 60) || ' (' || v_day || ')'
               else left(case v_run.kind when 'maps' then 'Maps' else 'Apollo' end || ' · ' || v_label, 72) || ' · ' || v_day end,
          'importing')
  returning id into v_imp;
  v_total := jsonb_array_length(p_rows);
  while v_off < v_total loop
    select coalesce(jsonb_agg(e.value order by e.ord), '[]'::jsonb) into v_res
      from jsonb_array_elements(p_rows) with ordinality e(value, ord)
     where e.ord > v_off and e.ord <= v_off + 500;
    v_res := public.import_rows_core(v_imp, v_res, v_kind);
    v_new := v_new + (v_res ->> 'new')::int;
    v_merged := v_merged + (v_res ->> 'merged')::int;
    v_off := v_off + 500;
  end loop;
  update public.lead_imports set status = 'done', finished_at = now() where id = v_imp and status = 'importing';
  update public.source_runs
     set status = 'imported', import_id = v_imp, found = p_found, dropped = p_dropped, finished_at = now(),
         cost_usd = round(coalesce(p_cost, reserve_usd), 2)
   where id = p_run;
  return jsonb_build_object('new', v_new, 'merged', v_merged);
end;
$$;

-- ---------------------------------------------------------------- 0019's import trigger function: rapidapi_contact = apify_contact
create or replace function public.requeue_lead_on_import()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.qualifier_queue q
     set next_step = case when new.source in ('apify_contact', 'rapidapi_contact') then 'p5' else 'p1' end, -- 0019: a contact e-mail skips P2-P4
         done_reason = null, fail_step = null, fail_streak = 0,
         enqueued_at = now(), locked_by = null, locked_until = null
   where q.lead_id = new.lead_id and q.next_step = 'done' and q.done_reason is distinct from 'dead';
  -- whatever the lead's state: a claim that is open now did not see this value (the claim resets the marks)
  update public.qualifier_queue q
     set data_since_claim = true, import_since_claim = q.import_since_claim or new.source not in ('apify_contact', 'rapidapi_contact')
   where q.lead_id = new.lead_id;
  return null;
end;
$$;

-- 0016's source_add_contacts: a RapidAPI contact run writes 'rapidapi_contact' (the page is still the proof).
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
    values (v_run.workspace_id, (r ->> 'lead_id')::uuid, 'email', v_value,
            case when v_run.provider = 'rapidapi' then 'rapidapi_contact' else 'apify_contact' end, v_url, 'confirmed')
    on conflict do nothing;
    get diagnostics v_i = row_count;
    v_n := v_n + v_i;
  end loop;
  -- 0034: a RapidAPI run reads its sites in lead_id order (source_contact_leads) and p_found is how many it read: the
  -- leads it never reached leave the run, so they are not taken as read and can be asked again
  if v_run.provider = 'rapidapi' then
    delete from public.source_run_leads l
     where l.run_id = p_run
       and l.lead_id not in (select x.lead_id from public.source_run_leads x where x.run_id = p_run order by x.lead_id limit p_found);
  end if;
  update public.source_runs
     set status = 'imported', found = p_found,
         dropped = greatest(p_found - (jsonb_array_length(p_rows) - v_skipped), 0),
         finished_at = now(), cost_usd = round(coalesce(p_cost, reserve_usd), 2)
   where id = p_run;
  return v_n;
end;
$$;

-- 0016's qualifier_request_contacts: RapidAPI first; the Apify checks only look at Apify runs.
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
  -- 0034: the RapidAPI site reader first (no minimum charge); when it is not connected, out of room or already
  -- answered for this lead, the Apify contact scraper as before
  if public.source_queue_site_contact(v_ws, p_lead, v_url, null) then
    return true;
  end if;
  select * into v_conn from public.source_connections c where c.workspace_id = v_ws and c.provider = 'apify';
  if not found then
    return false;
  end if;
  if exists (select 1 from public.source_run_leads l join public.source_runs r on r.id = l.run_id
              where l.lead_id = p_lead and r.kind = 'contact' and r.provider = 'apify' and r.status in ('queued', 'running')) then
    return true;
  end if;
  -- answered, or paid for and failed (stale, start_unknown, import_refused...), in the last 30 days: never pay twice.
  -- Free failures (no_leads, a definite refusal, disconnected, refused at the cap) may try again.
  if exists (select 1 from public.source_run_leads l join public.source_runs r on r.id = l.run_id
              where l.lead_id = p_lead and r.kind = 'contact' and r.provider = 'apify' and r.created_at > now() - interval '30 days'
                and (r.status = 'imported' or (r.status = 'failed' and coalesce(r.cost_usd, 0) > 0))) then
    return false;
  end if;
  select r.id into v_run
    from public.source_runs r
   where r.workspace_id = v_ws and r.kind = 'contact' and r.provider = 'apify' and r.status = 'queued' and r.start_claimed_at is null
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

-- ---------------------------------------------------------------- privileges (same as 0033/0016; the recreated list function needs its grant again)
revoke all on function public.source_month_rapidapi(uuid, text) from public, anon, authenticated;
revoke all on function public.source_queue_site_contact(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.request_site_contact(uuid, uuid, text) from public, anon;
revoke all on function public.list_source_connections(uuid) from public, anon;
revoke all on function public.set_source_connection(uuid, text, text, text, numeric) from public, anon;
revoke all on function public.set_source_cap(uuid, text, numeric) from public, anon;
revoke all on function public.delete_source_connection(uuid, text) from public, anon;
revoke all on function public.enqueue_source_run(uuid, text, jsonb, int) from public, anon;
revoke all on function public.import_rows_core(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.undo_lead_import(uuid) from public, anon;
revoke all on function public.source_next_work(uuid) from public, authenticated;
revoke all on function public.source_import(uuid, uuid, jsonb, int, int, numeric) from public, authenticated;
revoke all on function public.requeue_lead_on_import() from public, anon, authenticated;
revoke all on function public.source_add_contacts(uuid, uuid, jsonb, int, numeric) from public, authenticated;
revoke all on function public.qualifier_request_contacts(uuid, uuid, text) from public, authenticated;
grant execute on function public.request_site_contact(uuid, uuid, text) to authenticated;
grant execute on function public.list_source_connections(uuid) to authenticated;
grant execute on function public.set_source_connection(uuid, text, text, text, numeric) to authenticated;
grant execute on function public.set_source_cap(uuid, text, numeric) to authenticated;
grant execute on function public.delete_source_connection(uuid, text) to authenticated;
grant execute on function public.enqueue_source_run(uuid, text, jsonb, int) to authenticated;
grant execute on function public.undo_lead_import(uuid) to authenticated;
grant execute on function public.source_next_work(uuid) to anon;
grant execute on function public.source_import(uuid, uuid, jsonb, int, int, numeric) to anon;
grant execute on function public.source_add_contacts(uuid, uuid, jsonb, int, numeric) to anon;
grant execute on function public.qualifier_request_contacts(uuid, uuid, text) to anon;
