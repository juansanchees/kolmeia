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

-- ================================================================ J2 the closer leaves research (F2 blocker 4)
-- Research tables are owner/sdr only. The closer reads the proof (candidates, checks, evidence) of the leads
-- assigned to her, and nothing else. is_workspace_sender is owner/sdr (0003); closers and clients are not senders.
create or replace function public.candidate_visible_to_assignee(p_candidate uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.research_candidates c
      join public.leads l on l.id = c.lead_id and l.workspace_id = c.workspace_id
     where c.id = p_candidate and l.owner_id = auth.uid()
  );
$$;

create or replace function public.check_visible_to_assignee(p_check uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.research_checks k
      join public.research_candidates c on c.id = k.candidate_id
      join public.leads l on l.id = c.lead_id and l.workspace_id = c.workspace_id
     where k.id = p_check and l.owner_id = auth.uid()
  );
$$;

revoke all on function public.candidate_visible_to_assignee(uuid) from public, anon;
revoke all on function public.check_visible_to_assignee(uuid) from public, anon;
grant execute on function public.candidate_visible_to_assignee(uuid) to authenticated;
grant execute on function public.check_visible_to_assignee(uuid) to authenticated;

-- research_runs
drop policy if exists research_runs_select on public.research_runs;
create policy research_runs_select on public.research_runs
  for select to authenticated using (public.is_workspace_sender(workspace_id));
drop policy if exists research_runs_insert on public.research_runs;
create policy research_runs_insert on public.research_runs
  for insert to authenticated with check (public.is_workspace_sender(workspace_id));
drop policy if exists research_runs_update on public.research_runs;
create policy research_runs_update on public.research_runs
  for update to authenticated
  using (public.is_workspace_sender(workspace_id))
  with check (public.is_workspace_sender(workspace_id));
drop policy if exists research_runs_delete on public.research_runs;
create policy research_runs_delete on public.research_runs
  for delete to authenticated
  using (public.is_workspace_owner(workspace_id) or (created_by = auth.uid() and public.is_workspace_sender(workspace_id)));

-- research_sources
drop policy if exists research_sources_select on public.research_sources;
create policy research_sources_select on public.research_sources
  for select to authenticated using (public.is_workspace_sender(workspace_id));
drop policy if exists research_sources_insert on public.research_sources;
create policy research_sources_insert on public.research_sources
  for insert to authenticated
  with check (public.is_workspace_sender(workspace_id) and public.run_in_workspace(run_id, workspace_id));
drop policy if exists research_sources_update on public.research_sources;
create policy research_sources_update on public.research_sources
  for update to authenticated
  using (public.is_workspace_sender(workspace_id))
  with check (public.is_workspace_sender(workspace_id));

-- research_jobs
drop policy if exists research_jobs_select on public.research_jobs;
create policy research_jobs_select on public.research_jobs
  for select to authenticated using (public.is_workspace_sender(workspace_id));
drop policy if exists research_jobs_insert on public.research_jobs;
create policy research_jobs_insert on public.research_jobs
  for insert to authenticated
  with check (public.is_workspace_sender(workspace_id) and public.run_in_workspace(run_id, workspace_id));

-- research_candidates: the closer may read the ones of her assigned leads; writes (verified_at, decisions) are sender-only
drop policy if exists research_candidates_select on public.research_candidates;
create policy research_candidates_select on public.research_candidates
  for select to authenticated
  using (public.is_workspace_sender(workspace_id) or public.candidate_visible_to_assignee(id));
drop policy if exists research_candidates_insert on public.research_candidates;
create policy research_candidates_insert on public.research_candidates
  for insert to authenticated
  with check (public.is_workspace_sender(workspace_id) and public.run_in_workspace(run_id, workspace_id));
drop policy if exists research_candidates_update on public.research_candidates;
create policy research_candidates_update on public.research_candidates
  for update to authenticated
  using (public.is_workspace_sender(workspace_id))
  with check (public.is_workspace_sender(workspace_id));

-- research_checks / research_evidence
drop policy if exists research_checks_select on public.research_checks;
create policy research_checks_select on public.research_checks
  for select to authenticated
  using (public.is_workspace_sender(workspace_id) or public.candidate_visible_to_assignee(candidate_id));
drop policy if exists research_checks_insert on public.research_checks;
create policy research_checks_insert on public.research_checks
  for insert to authenticated with check (public.is_workspace_sender(workspace_id));
drop policy if exists research_evidence_select on public.research_evidence;
create policy research_evidence_select on public.research_evidence
  for select to authenticated
  using (public.is_workspace_sender(workspace_id) or public.check_visible_to_assignee(check_id));
drop policy if exists research_evidence_insert on public.research_evidence;
create policy research_evidence_insert on public.research_evidence
  for insert to authenticated with check (public.is_workspace_sender(workspace_id));

-- research_lists / research_list_items
drop policy if exists research_lists_select on public.research_lists;
create policy research_lists_select on public.research_lists
  for select to authenticated using (public.is_workspace_sender(workspace_id));
drop policy if exists research_lists_insert on public.research_lists;
create policy research_lists_insert on public.research_lists
  for insert to authenticated
  with check (
    public.is_workspace_sender(workspace_id)
    and (run_id is null or public.run_in_workspace(run_id, workspace_id))
  );
drop policy if exists research_lists_update on public.research_lists;
create policy research_lists_update on public.research_lists
  for update to authenticated
  using (public.is_workspace_sender(workspace_id))
  with check (public.is_workspace_sender(workspace_id));
drop policy if exists research_lists_delete on public.research_lists;
create policy research_lists_delete on public.research_lists
  for delete to authenticated using (public.is_workspace_sender(workspace_id));

drop policy if exists research_list_items_select on public.research_list_items;
create policy research_list_items_select on public.research_list_items
  for select to authenticated using (public.is_workspace_sender(workspace_id));
drop policy if exists research_list_items_insert on public.research_list_items;
create policy research_list_items_insert on public.research_list_items
  for insert to authenticated with check (public.is_workspace_sender(workspace_id));
drop policy if exists research_list_items_delete on public.research_list_items;
create policy research_list_items_delete on public.research_list_items
  for delete to authenticated using (public.is_workspace_sender(workspace_id));

-- RPCs: same bodies as 0002/0004, sender instead of member
create or replace function public.claim_research_step(p_run uuid, p_holder uuid, p_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  update public.research_runs r
     set locked_until = now() + make_interval(secs => least(greatest(coalesce(p_seconds, 60), 10), 900)),
         locked_by = p_holder
   where r.id = p_run
     and public.is_workspace_sender(r.workspace_id)
     and (r.locked_until is null or r.locked_until < now() or r.locked_by = p_holder);
  return found;
end;
$$;

create or replace function public.release_research_step(p_run uuid, p_holder uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.research_runs r
     set locked_until = null, locked_by = null
   where r.id = p_run and r.locked_by = p_holder and public.is_workspace_sender(r.workspace_id);
end;
$$;

create or replace function public.add_research_check(
  p_candidate uuid,
  p_kind text,
  p_pass integer,
  p_result text,
  p_summary text,
  p_evidence jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  v_id uuid;
  e jsonb;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select c.workspace_id into v_ws from public.research_candidates c where c.id = p_candidate;
  if v_ws is null or not public.is_workspace_sender(v_ws) then
    raise exception 'candidate not found' using errcode = '42501';
  end if;
  insert into public.research_checks (workspace_id, candidate_id, kind, pass, result, summary)
  values (v_ws, p_candidate, p_kind, p_pass, p_result, coalesce(p_summary, ''))
  on conflict (candidate_id, kind, pass)
  do update set result = excluded.result, summary = excluded.summary, created_at = now()
  returning id into v_id;
  delete from public.research_evidence ev where ev.check_id = v_id;
  for e in select * from jsonb_array_elements(coalesce(p_evidence, '[]'::jsonb)) loop
    insert into public.research_evidence (workspace_id, check_id, url, title, excerpt, seen_at)
    values (
      v_ws, v_id, e ->> 'url', coalesce(e ->> 'title', ''), coalesce(e ->> 'excerpt', ''),
      coalesce((e ->> 'seen_at')::timestamptz, now())
    );
  end loop;
  return v_id;
end;
$$;
