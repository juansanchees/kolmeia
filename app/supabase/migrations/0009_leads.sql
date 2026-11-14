-- 0009 Leads (F3a): one row per company per workspace, fed by verified research candidates.
--   L1 company keys in SQL (domain and phone), the same rule as src/lib/research/dedupe.ts (pinned by shared vectors).
--   L2 a candidate that becomes verified joins the lead of the same company (name key, domain or last 10 phone digits)
--      or creates one, stamped with the origin of its run (agent or "pesquisa avulsa").
--   L3 deleting a candidate (or its run) re-points the lead to its newest remaining candidate, or removes the lead.
--   L4 old verified candidates are back-filled once at the end of this migration (C1).
--   L5 leads are read-only for clients: owner/sdr see all of the workspace, the closer only what is assigned to her.
-- Depends on 0001-0008. Re-runnable.

-- ---------------------------------------------------------------- runs: which agent started them (F3b writes it)
alter table public.research_runs
  add column if not exists agent_id uuid references public.agents (id) on delete set null;
create index if not exists research_runs_agent_idx on public.research_runs (agent_id, created_at desc);

-- ---------------------------------------------------------------- L1 company keys
-- Same list as SHARED_HOSTS in dedupe.ts: directory / social hosts never identify one company.
create or replace function public.company_domain_key(website text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when h.h is null then null
    when exists (
      select 1
        from unnest(array['facebook.com', 'instagram.com', 'yelp.com', 'google.com', 'houzz.com', 'bbb.org', 'angi.com',
                          'homeadvisor.com', 'nextdoor.com', 'x.com', 'twitter.com', 'sites.google.com', 'wixsite.com',
                          'squarespace.com']) s
       where h.h = s or h.h like '%.' || s
    ) then null
    else h.h
  end
  from (select public.url_host(website) as h) h;
$$;

-- Last 10 digits (US numbers with or without +1); fewer than 10 digits identify nobody.
create or replace function public.company_phone_key(phone text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when char_length(d.d) >= 10 then right(d.d, 10) end
  from (select regexp_replace(coalesce(phone, ''), '\D', '', 'g') as d) d;
$$;

-- ---------------------------------------------------------------- leads
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  best_candidate_id uuid references public.research_candidates (id) on delete set null deferrable initially deferred,
  status text not null default 'new'
    constraint leads_status check (status in ('new', 'call_list', 'in_campaign', 'replied', 'with_closer', 'meeting', 'won', 'lost', 'discarded')),
  origin_kind text not null
    constraint leads_origin_kind check (origin_kind in ('agent', 'one_off')),
  origin_agent_id uuid references public.agents (id) on delete set null,
  origin_run_id uuid references public.research_runs (id) on delete set null,
  owner_id uuid references auth.users (id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists leads_workspace_idx on public.leads (workspace_id, last_seen_at desc);

alter table public.research_candidates
  add column if not exists domain_key text generated always as (public.company_domain_key(website)) stored,
  add column if not exists phone_key text generated always as (public.company_phone_key(phone)) stored,
  add column if not exists lead_id uuid references public.leads (id) on delete set null;

create index if not exists research_candidates_ws_name_idx on public.research_candidates (workspace_id, name_key);
create index if not exists research_candidates_ws_domain_idx on public.research_candidates (workspace_id, domain_key) where domain_key is not null;
create index if not exists research_candidates_ws_phone_idx on public.research_candidates (workspace_id, phone_key) where phone_key is not null;
create index if not exists research_candidates_lead_idx on public.research_candidates (lead_id);

-- ---------------------------------------------------------------- L2 link (or create) the lead of a verified candidate
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

  -- Priority: name, then domain, then phone; several matches -> the oldest lead.
  select c.lead_id into v_lead
    from public.research_candidates c
    join public.leads l on l.id = c.lead_id
   where c.workspace_id = p_ws
     and c.lead_id is not null
     and c.id <> p_candidate
     and (
       c.name_key = p_name_key
       or (v_domain is not null and c.domain_key = v_domain)
       or (v_phone is not null and c.phone_key = v_phone)
     )
   order by case
              when c.name_key = p_name_key then 1
              when v_domain is not null and c.domain_key = v_domain then 2
              else 3
            end,
            l.created_at, l.id
   limit 1;

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

create or replace function public.link_candidate_lead()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.verified_at is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if old.verified_at is not null then
      return new; -- already counted
    end if;
    if new.lead_id is not null then -- verified again after being cleared: same lead, newest verification
      update public.leads set best_candidate_id = new.id, last_seen_at = greatest(last_seen_at, new.verified_at), updated_at = now() where id = new.lead_id;
      return new;
    end if;
  end if;
  new.lead_id := public.link_lead(new.workspace_id, new.run_id, new.id, new.name_key, new.website, new.phone, new.verified_at);
  return new;
end;
$$;

drop trigger if exists link_candidate_lead on public.research_candidates;
create trigger link_candidate_lead
  before insert or update of verified_at on public.research_candidates
  for each row execute function public.link_candidate_lead();

-- ---------------------------------------------------------------- L3 a deleted candidate re-points or removes its lead
create or replace function public.unlink_candidate_lead()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_best uuid;
begin
  -- same per-workspace lock as link_lead: a delete cannot race a link and drop a lead that just gained a candidate
  perform pg_advisory_xact_lock(hashtext('lead:' || old.workspace_id::text));
  select c.id into v_best
    from public.research_candidates c
   where c.lead_id = old.lead_id and c.verified_at is not null
   order by c.verified_at desc, c.created_at desc, c.id
   limit 1;
  if v_best is null then
    delete from public.leads where id = old.lead_id;
  else
    update public.leads set best_candidate_id = v_best, updated_at = now() where id = old.lead_id;
  end if;
  return null;
end;
$$;

drop trigger if exists unlink_candidate_lead on public.research_candidates;
create trigger unlink_candidate_lead
  after delete on public.research_candidates
  for each row when (old.lead_id is not null)
  execute function public.unlink_candidate_lead();

-- ---------------------------------------------------------------- L4 back-fill (C1)
create or replace function public.backfill_leads()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select c.id, c.workspace_id, c.run_id, c.name_key, c.website, c.phone, c.verified_at
      from public.research_candidates c
     where c.verified_at is not null and c.lead_id is null
     order by c.verified_at, c.created_at, c.id
  loop
    update public.research_candidates
       set lead_id = public.link_lead(r.workspace_id, r.run_id, r.id, r.name_key, r.website, r.phone, r.verified_at)
     where id = r.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ---------------------------------------------------------------- privileges
revoke all on function public.link_lead(uuid, uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.link_candidate_lead() from public, anon, authenticated;
revoke all on function public.unlink_candidate_lead() from public, anon, authenticated;
revoke all on function public.backfill_leads() from public, anon, authenticated;
revoke all on function public.company_domain_key(text) from public, anon;
revoke all on function public.company_phone_key(text) from public, anon;
grant execute on function public.company_domain_key(text) to authenticated;
grant execute on function public.company_phone_key(text) to authenticated;

revoke all on table public.leads from public, anon, authenticated;
grant select on table public.leads to authenticated;

-- ---------------------------------------------------------------- L5 RLS
alter table public.leads enable row level security;
alter table public.leads force row level security;

drop policy if exists leads_select on public.leads;
create policy leads_select on public.leads
  for select to authenticated
  using (public.is_workspace_sender(workspace_id) or owner_id = auth.uid());

-- C1: Juan's old verified searches become leads ("pesquisa avulsa"). Running it again changes nothing.
select public.backfill_leads();
