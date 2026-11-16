-- 0028 Fase 2 "dados mais confiáveis": e-mail quality (7), e-mail cascade provenance (6). NL search (8) needs no table.
--   * email_checks: one quality verdict per workspace e-mail (verified | catch_all | unknown | invalid), how it was
--     reached (method 'mx' = free syntax + DNS check; 'verifier' = the pluggable paid slot) and when. Senders read and
--     write it through RLS (security invoker: no definer function); the closer reads none (she never sees the badge).
--   * lead_fields.source += 'pattern': e-mail GUESSES built from the contact's name and the site's domain. Senders
--     insert them directly (RLS: only field 'email', source 'pattern', status 'unverified'). A guess is never a fact:
--     it does not raise the level, is not a display value, and never enters a campaign unless the verifier said
--     'verified'.
--   * email_sendable(): the campaign rule. add_leads_to_campaign (0023 body) skips invalid and unverified-guess
--     addresses and falls back to the next one; a BEFORE INSERT trigger on email_prospects drops an invalid address
--     from any other path (import_list_into_campaign of 0003, future ones) so the prospect stays "sem e-mail".
--   * ai_calls_task += 'lead_search' (the natural-language search's LLM layer, in the user's session ledger).
-- Depends on 0001-0027. Re-runnable.

-- ---------------------------------------------------------------- email_checks
create table if not exists public.email_checks (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text not null constraint email_checks_email check (char_length(email) between 3 and 254 and email = lower(btrim(email))),
  status text not null constraint email_checks_status check (status in ('verified', 'catch_all', 'unknown', 'invalid')),
  method text not null constraint email_checks_method check (method in ('mx', 'verifier')),
  detail text constraint email_checks_detail check (detail is null or char_length(detail) <= 200),
  checked_by uuid,
  checked_at timestamptz not null default now(),
  primary key (workspace_id, email)
);

-- Who and when are the database's, never the client's.
create or replace function public.stamp_email_check()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.checked_by := auth.uid();
  new.checked_at := now();
  return new;
end;
$$;
drop trigger if exists stamp_email_check on public.email_checks;
create trigger stamp_email_check before insert or update on public.email_checks
  for each row execute function public.stamp_email_check();

revoke all on table public.email_checks from public, anon, authenticated;
grant select on table public.email_checks to authenticated;
grant insert (workspace_id, email, status, method, detail) on table public.email_checks to authenticated;
-- PostgREST's upsert sets every column it sends, the key included; RLS keeps both rows inside the sender's workspaces.
grant update (workspace_id, email, status, method, detail) on table public.email_checks to authenticated;
alter table public.email_checks enable row level security;
alter table public.email_checks force row level security;
drop policy if exists email_checks_select on public.email_checks;
create policy email_checks_select on public.email_checks
  for select to authenticated using (public.is_workspace_sender(workspace_id));
drop policy if exists email_checks_insert on public.email_checks;
create policy email_checks_insert on public.email_checks
  for insert to authenticated with check (public.is_workspace_sender(workspace_id));
drop policy if exists email_checks_update on public.email_checks;
create policy email_checks_update on public.email_checks
  for update to authenticated using (public.is_workspace_sender(workspace_id)) with check (public.is_workspace_sender(workspace_id));

-- ---------------------------------------------------------------- lead_fields: 'pattern' guesses
alter table public.lead_fields drop constraint if exists lead_fields_source;
alter table public.lead_fields add constraint lead_fields_source check (source in
  ('import', 'site', 'places', 'ai', 'research', 'apify_maps', 'apollo', 'apify_contact', 'pattern'));
-- A guess is unverified and can never be confirmed: only the verifier's email_checks row makes it usable.
alter table public.lead_fields drop constraint if exists lead_fields_pattern_unverified;
alter table public.lead_fields add constraint lead_fields_pattern_unverified check (source <> 'pattern' or (field = 'email' and status <> 'confirmed'));

grant insert (workspace_id, lead_id, field, value, source, source_ref, status, excerpt) on table public.lead_fields to authenticated;
drop policy if exists lead_fields_insert_pattern on public.lead_fields;
create policy lead_fields_insert_pattern on public.lead_fields
  for insert to authenticated
  with check (field = 'email' and source = 'pattern' and status = 'unverified' and public.is_workspace_sender(workspace_id));

-- ---------------------------------------------------------------- the campaign rule
-- An address may go into a campaign unless a check said 'invalid'; a guess only after the verifier said 'verified'.
-- Internal (plain, no grant): called by the definer functions and the trigger below.
create or replace function public.email_sendable(p_ws uuid, p_email text, p_source text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select not exists (select 1 from public.email_checks k where k.workspace_id = p_ws and k.email = p_email and k.status = 'invalid')
     and (p_source is distinct from 'pattern'
          or exists (select 1 from public.email_checks k
                      where k.workspace_id = p_ws and k.email = p_email and k.status = 'verified' and k.method = 'verifier'));
$$;
revoke all on function public.email_sendable(uuid, text, text) from public, anon, authenticated;

-- Any path that inserts a prospect: an address checked 'invalid' is dropped (the prospect stays "sem e-mail"), and so
-- is an invalid suggestion. Runs after guard_email_prospect (trigger names fire in alphabetical order).
create or replace function public.strip_invalid_email()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.email is not null and not public.email_sendable(new.workspace_id, lower(btrim(new.email)), null) then
    new.email := null;
    new.email_source := null;
    new.email_source_url := null;
    new.email_source_ref := null;
  end if;
  if new.suggested_email is not null and not public.email_sendable(new.workspace_id, lower(btrim(new.suggested_email)), null) then
    new.suggested_email := null;
    new.suggested_email_url := null;
  end if;
  return new;
end;
$$;
revoke all on function public.strip_invalid_email() from public, anon, authenticated;
drop trigger if exists strip_invalid_email on public.email_prospects;
create trigger strip_invalid_email before insert on public.email_prospects
  for each row execute function public.strip_invalid_email();

-- ---------------------------------------------------------------- add_leads_to_campaign (0023 body + email_sendable)
create or replace function public.add_leads_to_campaign(p_campaign uuid, p_leads uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record;
  l record;
  e record;
  v_name text;
  v_contact text;
  v_title text;
  v_status text;
  v_added integer := 0;
  v_no_email integer := 0;
  v_blocked integer := 0;
  v_other integer := 0;
  v_suppressed integer := 0;
  v_already integer := 0;
begin
  select * into c from public.email_campaigns where id = p_campaign;
  if auth.uid() is null or c.id is null or not public.is_workspace_sender(c.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_leads), 0) > 500 then
    raise exception 'at most 500 leads at a time' using errcode = '22023';
  end if;
  if c.status = 'archived' then
    raise exception 'campaign archived' using errcode = '55000';
  end if;

  for l in
    select x.id, x.best_candidate_id
      from public.leads x
     where x.workspace_id = c.workspace_id
       and x.id in (select distinct u from unnest(coalesce(p_leads, '{}'::uuid[])) u)
     order by x.id
  loop
    perform pg_advisory_xact_lock(hashtextextended('lead-campaign:' || l.id::text, 0));
    if public.lead_blocks_email(l.id) then
      v_blocked := v_blocked + 1;
      continue;
    end if;
    if exists (select 1 from public.lead_campaign_locks k where k.lead_id = l.id and k.campaign_id <> c.id) then
      v_other := v_other + 1;
      continue;
    end if;
    if exists (select 1 from public.email_prospects p where p.campaign_id = c.id and p.lead_id = l.id) then
      v_already := v_already + 1;
      continue;
    end if;
    select lower(btrim(f.value)) as email, f.source || ':' || coalesce(f.source_ref, f.id::text) as ref into e
      from public.lead_fields f
     where f.lead_id = l.id and f.workspace_id = c.workspace_id and f.field = 'email' and f.status <> 'refuted'
       and public.is_email_address(lower(btrim(f.value)))
       and public.email_sendable(c.workspace_id, lower(btrim(f.value)), f.source)
     order by (f.status = 'confirmed') desc, f.seen_at desc, f.id
     limit 1;
    if e.email is null then
      v_no_email := v_no_email + 1;
      continue;
    end if;
    if public.is_suppressed(c.workspace_id, e.email) then
      v_suppressed := v_suppressed + 1;
      continue;
    end if;
    v_name := public.best_lead_field(l.id, 'name');
    if v_name is null then
      select k.name into v_name from public.research_candidates k where k.id = l.best_candidate_id and k.workspace_id = c.workspace_id;
    end if;
    v_name := left(btrim(coalesce(nullif(btrim(v_name), ''), split_part(e.email, '@', 2))), 200);
    v_contact := left(btrim(regexp_replace(public.best_lead_field(l.id, 'contact_name'), '[\r\n]+', ' ', 'g')), 120);
    v_title := left(btrim(regexp_replace(public.best_lead_field(l.id, 'contact_title'), '[\r\n]+', ' ', 'g')), 120);
    insert into public.email_prospects (workspace_id, campaign_id, lead_id, company_name, contact_name, contact_title,
                                        email, email_source, email_source_ref)
    values (c.workspace_id, c.id, l.id, v_name, nullif(v_contact, ''), nullif(v_title, ''), e.email, 'lead', left(e.ref, 2000))
    returning status into v_status;
    if v_status = 'active' then
      v_added := v_added + 1;
    else
      v_other := v_other + 1;
    end if;
  end loop;

  -- D6: a lead added after the approval goes out with the approved text (no new examples, no new approval).
  -- The result keeps 0021's keys.
  if v_added > 0 then
    perform public.queue_approved_sequence(c.id);
  end if;

  return jsonb_build_object('added', v_added, 'no_email', v_no_email, 'blocked', v_blocked,
                            'in_other_campaign', v_other, 'suppressed', v_suppressed, 'already', v_already);
end;
$$;

revoke all on function public.add_leads_to_campaign(uuid, uuid[]) from public, anon;
grant execute on function public.add_leads_to_campaign(uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------- a guess is not a fact
-- lead_level (0014 body): an e-mail guess does not make a lead level 1.
create or replace function public.lead_level(p_lead uuid)
returns smallint
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (select 1 from public.lead_fields f where f.lead_id = p_lead and f.field = 'active_project' and f.status = 'confirmed')
      or exists (
        select 1
          from public.research_candidates c
          join public.research_checks k on k.candidate_id = c.id and k.kind = 'has_work' and k.result = 'ok'
         where c.lead_id = p_lead and c.temperature in ('very_hot', 'hot') and c.second_pass is distinct from 'refuted'
           and exists (select 1 from public.research_evidence e where e.check_id = k.id)
      ) then 4
    when (exists (select 1 from public.lead_fields f where f.lead_id = p_lead and f.field = 'contact_name' and f.status = 'confirmed')
          and exists (select 1 from public.lead_fields f where f.lead_id = p_lead and f.field = 'contact_title' and f.status = 'confirmed'))
      or exists (
        select 1
          from public.research_candidates c
          join public.research_checks k on k.candidate_id = c.id and k.kind = 'decision_maker' and k.result = 'ok'
         where c.lead_id = p_lead and btrim(coalesce(c.ask_for_name, '')) <> '' and c.second_pass is distinct from 'refuted'
           and exists (select 1 from public.research_evidence e where e.check_id = k.id)
      ) then 3
    when exists (select 1 from public.lead_fields f where f.lead_id = p_lead and f.field = 'website' and f.status = 'confirmed')
     and exists (select 1 from public.lead_fields f where f.lead_id = p_lead and f.field = 'address' and f.status = 'confirmed') then 2
    when exists (select 1 from public.lead_fields f where f.lead_id = p_lead and f.field in ('phone', 'email') and f.status <> 'refuted'
                       and f.source <> 'pattern') then 1
    else 0
  end::smallint;
$$;

-- lead_contact_values (0027 body): the list and its counts never show a guess as the lead's e-mail.
create or replace function public.lead_contact_values(p_ws uuid)
returns table (lead_id uuid, level smallint, origin_kind text, contacted boolean, city text, phone text, email text)
language sql
stable
security invoker
set search_path = ''
as $$
  select l.id, l.level, l.origin_kind, l.first_contacted_at is not null,
         nullif(btrim(case when l.best_candidate_id is not null then c.city else fc.value end), ''),
         nullif(btrim(case when l.best_candidate_id is not null then c.phone else fp.value end), ''),
         nullif(btrim(case when l.best_candidate_id is not null then c.public_email else fe.value end), '')
    from public.leads l
    left join public.research_candidates c on c.id = l.best_candidate_id
    left join lateral (select f.value from public.lead_fields f
                        where l.best_candidate_id is null and f.lead_id = l.id and f.field = 'city' and f.status <> 'refuted'
                        order by f.seen_at, f.created_at, f.id limit 1) fc on true
    left join lateral (select f.value from public.lead_fields f
                        where l.best_candidate_id is null and f.lead_id = l.id and f.field = 'phone' and f.status <> 'refuted'
                        order by f.seen_at, f.created_at, f.id limit 1) fp on true
    left join lateral (select f.value from public.lead_fields f
                        where l.best_candidate_id is null and f.lead_id = l.id and f.field = 'email' and f.status <> 'refuted'
                          and f.source <> 'pattern'
                        order by f.seen_at, f.created_at, f.id limit 1) fe on true
   where l.workspace_id = p_ws
     -- the list skips a lead whose best candidate the caller cannot see; so do the counts
     and (l.best_candidate_id is null or c.id is not null);
$$;

revoke all on function public.lead_level(uuid) from public, anon, authenticated;
revoke all on function public.lead_contact_values(uuid) from public, anon;
grant execute on function public.lead_contact_values(uuid) to authenticated;

-- ---------------------------------------------------------------- AI task: natural-language lead search
alter table public.ai_calls drop constraint if exists ai_calls_task;
alter table public.ai_calls add constraint ai_calls_task check (
  task in ('research_questions', 'research_plan', 'research_discover', 'research_collect', 'research_verify',
           'research_second_pass', 'classify', 'email_draft', 'email_classify', 'email_reply_draft',
           'email_closer_brief', 'qualify_light', 'qualify_deep', 'qualify_places', 'profile_learn', 'email_sequence',
           'lead_search')
);
