-- 0040 Shared base (kb_*): companies, people, sourced values, signals (permits/projects), coverage jobs, source notes,
--   delivery links. No workspace_id; RLS on, no policy, no grants to anon/authenticated: only service_role (the robot
--   and the server functions) touches them. kb_ingest(items) dedupes and writes; it is service_role only.
--   Pilot deltas over Plan A: kb_signals.company_id is nullable (a permit may name a firm we do not know yet) with
--   link_status confirmed/pending/none + kb_signal_candidates; kb_jobs gets kind 'pilot' + coverage columns;
--   kb_source_meta says what each source allows. Source allowlist (D8) is the same list in every check below.
-- Depends on 0001-0039 (company_domain_key / company_phone_key from 0009). Re-runnable. One transaction.

begin;

-- ---------------------------------------------------------------- tables
create table if not exists public.kb_companies (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null check (char_length(name) between 1 and 200),
  name_key text not null check (char_length(name_key) between 1 and 200),
  domain text,
  phone text,
  phone_key text,
  address text check (char_length(address) <= 300),
  city text check (char_length(city) <= 100),
  state text default 'MA',
  zip text check (char_length(zip) <= 10),
  company_type text,
  naics text check (char_length(naics) <= 6),
  site_read_at timestamptz,
  site_outcome text,
  updated_at timestamptz not null default now(),
  removed_at timestamptz
);
create index if not exists kb_companies_domain_idx on public.kb_companies (domain) where removed_at is null;
create index if not exists kb_companies_phone_key_idx on public.kb_companies (phone_key) where removed_at is null;
create index if not exists kb_companies_name_city_idx on public.kb_companies (name_key, lower(city)) where removed_at is null;

-- D13: people carry only name, title, license. No phone, e-mail or address column exists.
create table if not exists public.kb_people (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  company_id uuid not null references public.kb_companies (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  name_key text not null,
  title text check (char_length(title) <= 120),
  license text check (char_length(license) <= 40),
  removed_at timestamptz,
  unique (company_id, name_key)
);

create table if not exists public.kb_values (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  entity text not null check (entity in ('company', 'person')),
  entity_id uuid not null,
  field text not null check (field in ('name', 'website', 'phone', 'email', 'address', 'city', 'state', 'zip', 'company_type', 'category', 'license', 'title', 'note')),
  value text not null check (char_length(value) between 1 and 1000),
  source text not null check (source in ('maps_robot', 'permit', 'project', 'crosswalk', 'license_csl', 'license_hic', 'corp_registry', 'site_robot')),
  source_url text check (char_length(source_url) <= 500 and source_url ~ '^https?://'),
  seen_at timestamptz not null,
  confidence text check (confidence in ('high', 'medium', 'low')),
  check (entity = 'company' or field in ('name', 'title', 'license'))
);
create unique index if not exists kb_values_uniq on public.kb_values (entity, entity_id, field, md5(lower(btrim(value))), source);

create table if not exists public.kb_signals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  company_id uuid references public.kb_companies (id) on delete cascade,
  kind text not null check (kind in ('permit', 'project')),
  source text not null check (source in ('maps_robot', 'permit', 'project', 'crosswalk', 'license_csl', 'license_hic', 'corp_registry', 'site_robot')),
  source_ref text not null check (char_length(source_ref) between 1 and 120),
  address text,
  town text,
  value_usd numeric,
  work_class text,
  use text,
  issued_on date,
  description text check (char_length(description) <= 300),
  source_url text,
  seen_at timestamptz not null default now(),
  applicant_name text check (char_length(applicant_name) <= 200),
  permit_no text check (char_length(permit_no) <= 60),
  link_status text not null default 'none' check (link_status in ('confirmed', 'pending', 'none')),
  link_note text check (char_length(link_note) <= 300),
  unique (source, source_ref)
);
create index if not exists kb_signals_company_idx on public.kb_signals (company_id);

create table if not exists public.kb_signal_candidates (
  signal_id uuid not null references public.kb_signals (id) on delete cascade,
  company_id uuid not null references public.kb_companies (id) on delete cascade,
  reason text check (char_length(reason) <= 120),
  primary key (signal_id, company_id)
);

create table if not exists public.kb_jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('load', 'sites', 'maps', 'permits', 'licenses', 'projects', 'pilot')),
  source text,
  city text,
  state text default 'MA',
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  progress jsonb not null default '{}',
  error text check (char_length(error) <= 300),
  requested_by_run uuid references public.research_runs (id) on delete set null,
  workspace_id uuid references public.workspaces (id) on delete set null,
  finished_at timestamptz,
  outcome text check (outcome in ('ok', 'partial', 'blocked', 'robots', 'down', 'login', 'empty', 'skipped')),
  queried int default 0,
  rows_in int default 0,
  reason text check (char_length(reason) <= 300)
);

create table if not exists public.kb_lead_links (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  company_id uuid not null references public.kb_companies (id) on delete cascade,
  import_id uuid,
  created_at timestamptz not null default now(),
  primary key (workspace_id, company_id)
);

create table if not exists public.kb_source_meta (
  source text primary key check (source in ('maps_robot', 'permit', 'project', 'crosswalk', 'license_csl', 'license_hic', 'corp_registry', 'site_robot')),
  label text not null,
  terms_url text,
  allowed_uses text check (char_length(allowed_uses) <= 300),
  restrictions text check (char_length(restrictions) <= 300)
);

insert into public.kb_source_meta (source, label, allowed_uses, restrictions) values
  ('maps_robot', 'Business listings from a public map service (own robot)', 'internal use, modest volume, no resale', 'The service''s terms restrict automated collection; the owner accepted that risk. Not for resale.'),
  ('permit', 'Town building permits', 'public record', 'Town portals differ; some block automated access and are then marked blocked.'),
  ('project', 'Public project listings', 'internal use, public pages only', 'Only what is shown publicly; no login.'),
  ('crosswalk', 'Our own matching of one firm across sources', 'internal use', 'Derived from other sources; keeps their limits.'),
  ('license_csl', 'State construction supervisor license list', 'public record', 'No home address and no personal phone stored.'),
  ('license_hic', 'State home improvement contractor registrations', 'public record', 'No home address and no personal phone stored.'),
  ('corp_registry', 'State company registry', 'public record', 'Only used if a free path that robots.txt allows exists; not confirmed.'),
  ('site_robot', 'Company websites read by our robot', 'public company pages, robots.txt honoured', 'Public pages only; no login; about 1 request per second per site.')
on conflict (source) do nothing;

-- Closed to the API roles (RLS on, no policy, no grants).
alter table public.kb_companies enable row level security;
alter table public.kb_people enable row level security;
alter table public.kb_values enable row level security;
alter table public.kb_signals enable row level security;
alter table public.kb_signal_candidates enable row level security;
alter table public.kb_jobs enable row level security;
alter table public.kb_lead_links enable row level security;
alter table public.kb_source_meta enable row level security;
revoke all on public.kb_companies, public.kb_people, public.kb_values, public.kb_signals, public.kb_signal_candidates,
  public.kb_jobs, public.kb_lead_links, public.kb_source_meta from public, anon, authenticated;
grant all on public.kb_companies, public.kb_people, public.kb_values, public.kb_signals, public.kb_signal_candidates,
  public.kb_jobs, public.kb_lead_links, public.kb_source_meta to service_role;

-- ---------------------------------------------------------------- kb_ingest
-- Item shape: see Plan A Task 3 (+ signals may carry applicant_name, permit_no). Counters count rows newly written.
create or replace function public.kb_ingest(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  it jsonb;
  c jsonb;
  v jsonb;
  pp jsonb;
  s jsonb;
  v_id uuid;
  v_cands uuid[];
  v_dom text;
  v_pk text;
  v_city text;
  v_name text;
  v_nk text;
  v_status text;
  v_reason text := 'same name_key';
  v_new boolean;
  v_pid uuid;
  v_created int := 0;
  v_matched int := 0;
  v_values int := 0;
  v_people int := 0;
  v_signals int := 0;
  v_unlinked int := 0;
  v_pending int := 0;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'invalid item' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > 500 then
    raise exception 'too many items' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('kb'));

  for it in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(it) <> 'object'
       or exists (select 1 from jsonb_object_keys(it) k where k <> all (array['company_id', 'match_only', 'company', 'values', 'people', 'signals', 'site_read'])) then
      raise exception 'invalid item' using errcode = '22023';
    end if;
    c := it -> 'company';
    -- reset per item: nothing may leak from the previous one
    v_name := nullif(btrim(c ->> 'name'), '');
    v_nk := nullif(btrim(c ->> 'name_key'), '');
    v_dom := public.company_domain_key(c ->> 'website');
    v_pk := public.company_phone_key(c ->> 'phone');
    v_city := nullif(btrim(c ->> 'city'), '');
    v_id := null;
    v_cands := null;
    v_reason := 'same name_key';
    if c is not null and (jsonb_typeof(c) <> 'object'
       or exists (select 1 from jsonb_object_keys(c) k where k <> all (array['name', 'name_key', 'website', 'phone', 'address', 'city', 'state', 'zip', 'company_type']))) then
      raise exception 'invalid item' using errcode = '22023';
    end if;
    if (it ->> 'company_id') is null and (c is null or nullif(btrim(c ->> 'name'), '') is null or nullif(btrim(c ->> 'name_key'), '') is null) then
      -- a permit with no applicant is kept (unlinked); anything else needs a company
      if coalesce((it ->> 'match_only')::boolean, false) and jsonb_array_length(coalesce(it -> 'signals', '[]'::jsonb)) > 0 then
        for s in select * from jsonb_array_elements(it -> 'signals') loop
          v_signals := v_signals + public.kb_write_signal(s, null, 'none', null, null, null);
          v_unlinked := v_unlinked + 1;
        end loop;
        continue;
      end if;
      raise exception 'invalid item' using errcode = '22023';
    end if;


    -- ---- find the company (live only; ties -> oldest)
    if (it ->> 'company_id') is not null then
      select id into v_id from public.kb_companies where id = (it ->> 'company_id')::uuid and removed_at is null;
      if v_id is null then
        raise exception 'invalid item' using errcode = '22023';
      end if;
    else
      if v_dom is not null then
        select id into v_id from public.kb_companies where removed_at is null and domain = v_dom order by created_at, id limit 1;
      end if;
      if v_id is null and v_pk is not null then
        select id into v_id from public.kb_companies where removed_at is null and phone_key = v_pk order by created_at, id limit 1;
      end if;
      if v_id is null and v_city is not null then
        select id into v_id from public.kb_companies where removed_at is null and name_key = v_nk and lower(city) = lower(v_city) order by created_at, id limit 1;
      end if;
      if v_id is null and v_city is null then
        select array_agg(id order by created_at, id) into v_cands from public.kb_companies where removed_at is null and name_key = v_nk;
        if cardinality(v_cands) = 1 then
          v_id := v_cands[1];
          v_cands := null;
        elsif cardinality(v_cands) >= 2 and not coalesce((it ->> 'match_only')::boolean, false) then
          -- re-run of a city-less item: hit the city-less row created last time instead of adding another
          select id into v_id from public.kb_companies where removed_at is null and name_key = v_nk and city is null order by created_at, id limit 1;
        end if;
      end if;
      if v_id is null and v_cands is null and coalesce((it ->> 'match_only')::boolean, false) then
        -- same name only in other towns: a firm works in many towns, so keep the link pending
        select array_agg(id order by created_at, id) into v_cands from public.kb_companies where removed_at is null and name_key = v_nk;
        v_reason := 'same name, other town';
      end if;
    end if;

    -- ---- no company and match_only: signals only, never create
    if v_id is null and coalesce((it ->> 'match_only')::boolean, false) then
      v_status := case when cardinality(v_cands) >= 1 then 'pending' else 'none' end;
      for s in select * from jsonb_array_elements(coalesce(it -> 'signals', '[]'::jsonb)) loop
        v_signals := v_signals + public.kb_write_signal(s, null, v_status, v_cands, v_name, v_reason);
        if v_status = 'pending' then v_pending := v_pending + 1; else v_unlinked := v_unlinked + 1; end if;
      end loop;
      continue;
    end if;

    -- ---- create or touch
    if v_id is null then
      insert into public.kb_companies (name, name_key, domain, phone, phone_key, address, city, state, zip, company_type)
      values (v_name, v_nk, v_dom, nullif(btrim(c ->> 'phone'), ''), v_pk, nullif(btrim(c ->> 'address'), ''), v_city,
              coalesce(nullif(btrim(c ->> 'state'), ''), 'MA'), nullif(btrim(c ->> 'zip'), ''), nullif(btrim(c ->> 'company_type'), ''))
      returning id into v_id;
      v_created := v_created + 1;
    else
      if c is not null then
        update public.kb_companies k set
          domain = coalesce(k.domain, v_dom),
          phone = coalesce(k.phone, nullif(btrim(c ->> 'phone'), '')),
          phone_key = coalesce(k.phone_key, v_pk),
          address = coalesce(k.address, nullif(btrim(c ->> 'address'), '')),
          city = coalesce(k.city, v_city),
          zip = coalesce(k.zip, nullif(btrim(c ->> 'zip'), '')),
          company_type = coalesce(k.company_type, nullif(btrim(c ->> 'company_type'), '')),
          updated_at = now()
        where k.id = v_id;
      else
        update public.kb_companies set updated_at = now() where id = v_id;
      end if;
      v_matched := v_matched + 1;
    end if;

    if it -> 'site_read' is not null then
      update public.kb_companies set site_read_at = now(), site_outcome = it -> 'site_read' ->> 'outcome' where id = v_id;
    end if;

    -- ---- sourced values
    for v in select * from jsonb_array_elements(coalesce(it -> 'values', '[]'::jsonb)) loop
      if exists (select 1 from jsonb_object_keys(v) k where k <> all (array['field', 'value', 'source', 'source_url', 'seen_at', 'confidence'])) or (v ->> 'seen_at') is null then
        raise exception 'invalid item' using errcode = '22023';
      end if;
      insert into public.kb_values (entity, entity_id, field, value, source, source_url, seen_at, confidence)
      values ('company', v_id, v ->> 'field', btrim(v ->> 'value'), v ->> 'source', v ->> 'source_url', (v ->> 'seen_at')::timestamptz, v ->> 'confidence')
      on conflict (entity, entity_id, field, md5(lower(btrim(value))), source) do update
        set seen_at = greatest(public.kb_values.seen_at, excluded.seen_at),
            source_url = coalesce(excluded.source_url, public.kb_values.source_url)
      returning (xmax = 0) into v_new;
      if v_new then v_values := v_values + 1; end if;
    end loop;

    -- ---- people (name, title, license only)
    for pp in select * from jsonb_array_elements(coalesce(it -> 'people', '[]'::jsonb)) loop
      if exists (select 1 from jsonb_object_keys(pp) k where k <> all (array['name', 'name_key', 'title', 'license', 'source', 'source_url', 'seen_at'])) or (pp ->> 'seen_at') is null then
        raise exception 'invalid item' using errcode = '22023';
      end if;
      insert into public.kb_people (company_id, name, name_key, title, license)
      values (v_id, btrim(pp ->> 'name'), btrim(pp ->> 'name_key'), nullif(btrim(pp ->> 'title'), ''), nullif(btrim(pp ->> 'license'), ''))
      on conflict (company_id, name_key) do update
        set title = coalesce(public.kb_people.title, excluded.title), license = coalesce(public.kb_people.license, excluded.license)
      returning id, (xmax = 0) into v_pid, v_new;
      if v_new then v_people := v_people + 1; end if;
      for v in select jsonb_build_object('field', f, 'value', val) from (values ('name', pp ->> 'name'), ('title', pp ->> 'title'), ('license', pp ->> 'license')) t (f, val) where nullif(btrim(val), '') is not null loop
        insert into public.kb_values (entity, entity_id, field, value, source, source_url, seen_at)
        values ('person', v_pid, v ->> 'field', btrim(v ->> 'value'), pp ->> 'source', pp ->> 'source_url', (pp ->> 'seen_at')::timestamptz)
        on conflict (entity, entity_id, field, md5(lower(btrim(value))), source) do update
          set seen_at = greatest(public.kb_values.seen_at, excluded.seen_at);
      end loop;
    end loop;

    -- ---- signals (attached to this company: confirmed)
    for s in select * from jsonb_array_elements(coalesce(it -> 'signals', '[]'::jsonb)) loop
      v_signals := v_signals + public.kb_write_signal(s, v_id, 'confirmed', null, v_name, null);
    end loop;
  end loop;

  return jsonb_build_object('created', v_created, 'matched', v_matched, 'values', v_values, 'people', v_people,
                            'signals', v_signals, 'signals_unlinked', v_unlinked, 'signals_pending', v_pending);
end;
$$;

-- Writes one signal and its link state. Returns 1 when the signal row is new, else 0.
-- Never downgrades a confirmed link; a unique match upgrades pending/none to confirmed and clears the candidates.
create or replace function public.kb_write_signal(s jsonb, p_company uuid, p_status text, p_cands uuid[], p_applicant text, p_reason text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old record;
  v_sid uuid;
  v_cand uuid;
begin
  if jsonb_typeof(s) <> 'object'
     or exists (select 1 from jsonb_object_keys(s) k where k <> all (array['kind', 'source', 'source_ref', 'address', 'town', 'value_usd', 'work_class', 'use', 'issued_on', 'description', 'source_url', 'applicant_name', 'permit_no'])) then
    raise exception 'invalid item' using errcode = '22023';
  end if;
  select id, link_status into v_old from public.kb_signals where source = s ->> 'source' and source_ref = s ->> 'source_ref';
  if v_old.id is null then
    insert into public.kb_signals (company_id, kind, source, source_ref, address, town, value_usd, work_class, use, issued_on, description, source_url, applicant_name, permit_no, link_status)
    values (p_company, s ->> 'kind', s ->> 'source', s ->> 'source_ref', s ->> 'address', s ->> 'town', (s ->> 'value_usd')::numeric, s ->> 'work_class', s ->> 'use',
            (s ->> 'issued_on')::date, s ->> 'description', s ->> 'source_url', coalesce(s ->> 'applicant_name', p_applicant), s ->> 'permit_no', p_status)
    returning id into v_sid;
    if p_status = 'pending' then
      insert into public.kb_signal_candidates (signal_id, company_id, reason) select v_sid, x, p_reason from unnest(p_cands) x;
    end if;
    return 1;
  end if;
  v_sid := v_old.id;
  update public.kb_signals set seen_at = now() where id = v_sid;
  if v_old.link_status = 'confirmed' then
    return 0;
  elsif p_status = 'confirmed' then
    update public.kb_signals set company_id = p_company, link_status = 'confirmed' where id = v_sid;
    delete from public.kb_signal_candidates where signal_id = v_sid;
  elsif p_status = 'pending' then
    update public.kb_signals set link_status = 'pending' where id = v_sid;
    delete from public.kb_signal_candidates where signal_id = v_sid;
    insert into public.kb_signal_candidates (signal_id, company_id, reason) select v_sid, x, p_reason from unnest(p_cands) x;
  end if;
  return 0;
end;
$$;

revoke all on function public.kb_ingest(jsonb) from public, anon, authenticated;
grant execute on function public.kb_ingest(jsonb) to service_role;
revoke all on function public.kb_write_signal(jsonb, uuid, text, uuid[], text, text) from public, anon, authenticated;
grant execute on function public.kb_write_signal(jsonb, uuid, text, uuid[], text, text) to service_role;

commit;
