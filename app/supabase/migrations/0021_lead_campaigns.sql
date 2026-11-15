-- 0021 Leads into campaigns (F4 Task 2).
--   * email_prospects.lead_id: the lead a prospect belongs to (plain FK to leads; workspace match checked by guard_prospect_lead). Back-filled from the
--     research candidate; new prospects with a candidate get it from the trigger (import_list_into_campaign unchanged).
--   * R18 for lead addresses: email_source 'lead' carries email_source_ref = '<lead_fields.source>:<source_ref or field id>'.
--     A refuted e-mail field is never used. A person typing an address makes it 'manual' (the lead source is dropped).
--   * C3 one active campaign per lead: lead_campaign_locks, primary key = the lead. A prospect holds the lock while it is
--     'active' and its campaign is not done/archived. A second campaign gets the prospect 'stopped'/'in_other_campaign'
--     (insert) or 23505 (update to active). Ending a campaign frees its locks; reopening it re-takes them, and its
--     prospects whose lead is now elsewhere are stopped.
--   * The lead moves forward only: new|call_list -> in_campaign on lock; a reply moves new|call_list|in_campaign -> replied.
--   * lead_blocks_email (C2 + ruling D5): discarded, do_not_call, with_closer, meeting, won, lost never get e-mail.
--   * add_leads_to_campaign: owner/sdr put up to 500 leads into a campaign; returns a count per outcome.
--   * Closer scope (0017) and lead_in_active_campaign (0020) also follow email_prospects.lead_id.
-- Depends on 0001-0020. Re-runnable.

-- ---------------------------------------------------------------- columns and checks
-- 0020 (F5) already adds it; repeated so either order works.
alter table public.leads add column if not exists do_not_call boolean not null default false;

alter table public.email_prospects
  add column if not exists lead_id uuid,
  add column if not exists email_source_ref text;

-- Plain FK on purpose: a composite FK on leads_id_ws_key would stop 0011 from being re-run (it drops and re-adds that
-- key). The workspace match is checked by guard_prospect_lead; lock rows are written only by the definer triggers.
alter table public.email_prospects drop constraint if exists email_prospects_lead_ws_fkey;
alter table public.email_prospects drop constraint if exists email_prospects_lead_fkey;
alter table public.email_prospects
  add constraint email_prospects_lead_fkey foreign key (lead_id) references public.leads (id) on delete set null;
create index if not exists email_prospects_lead_idx on public.email_prospects (lead_id) where lead_id is not null;

alter table public.email_prospects drop constraint if exists email_prospects_email_source_ref;
alter table public.email_prospects
  add constraint email_prospects_email_source_ref check (email_source_ref is null or char_length(email_source_ref) between 1 and 2000);

alter table public.email_prospects drop constraint if exists email_prospects_email_source;
alter table public.email_prospects
  add constraint email_prospects_email_source check (email_source in ('research', 'manual', 'lead'));

alter table public.email_prospects drop constraint if exists email_prospects_stop_reason;
alter table public.email_prospects
  add constraint email_prospects_stop_reason check (
    stop_reason in ('unsubscribed', 'bounced', 'suppressed', 'asked_to_stop', 'replied', 'in_other_campaign',
                    'lead_discarded', 'do_not_call', 'lead_status')
  );

-- R18: no invented addresses. A research address carries its source URL, a lead address its field source; anything typed is 'manual'.
alter table public.email_prospects drop constraint if exists email_prospects_r18;
alter table public.email_prospects
  add constraint email_prospects_r18 check (
    (email is null and email_source is null and email_source_url is null)
    or (email is not null and email_source = 'manual')
    or (email is not null and email_source = 'research' and email_source_url is not null)
    or (email is not null and email_source = 'lead' and email_source_ref is not null)
  );

-- ---------------------------------------------------------------- C3 lock table
create table if not exists public.lead_campaign_locks (
  lead_id uuid primary key references public.leads (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  campaign_id uuid not null references public.email_campaigns (id) on delete cascade,
  prospect_id uuid not null references public.email_prospects (id) on delete cascade
    constraint lead_campaign_locks_prospect_key unique,
  locked_at timestamptz not null default now()
);
create index if not exists lead_campaign_locks_campaign_idx on public.lead_campaign_locks (campaign_id);

revoke all on table public.lead_campaign_locks from public, anon, authenticated;
grant select on table public.lead_campaign_locks to authenticated;
alter table public.lead_campaign_locks enable row level security;
alter table public.lead_campaign_locks force row level security;
-- owner/sdr read; nobody writes from a client (only the definer triggers below)
drop policy if exists lead_campaign_locks_select on public.lead_campaign_locks;
create policy lead_campaign_locks_select on public.lead_campaign_locks
  for select to authenticated using (public.is_workspace_sender(workspace_id));

-- ---------------------------------------------------------------- helpers
-- C2 + D5: the lead must not get e-mail. Internal (plain, no client grant): called from definer code.
create or replace function public.lead_blocks_email(p_lead uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.leads l
     where l.id = p_lead
       and (l.do_not_call or l.status in ('discarded', 'with_closer', 'meeting', 'won', 'lost'))
  );
$$;
revoke all on function public.lead_blocks_email(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- back-fill (before the triggers exist)
drop trigger if exists guard_prospect_lead on public.email_prospects;
drop trigger if exists sync_lead_lock on public.email_prospects;
drop trigger if exists sync_campaign_locks on public.email_campaigns;

update public.email_prospects p
   set lead_id = c.lead_id
  from public.research_candidates c
 where p.lead_id is null and c.id = p.candidate_id and c.workspace_id = p.workspace_id and c.lead_id is not null;

-- the oldest active prospect of a lead (in an open campaign) takes the lock; the others are stopped
insert into public.lead_campaign_locks (lead_id, workspace_id, campaign_id, prospect_id)
select distinct on (p.lead_id) p.lead_id, p.workspace_id, p.campaign_id, p.id
  from public.email_prospects p
  join public.email_campaigns c on c.id = p.campaign_id
 where p.lead_id is not null and p.status = 'active' and c.status not in ('done', 'archived')
 order by p.lead_id, p.created_at, p.id
on conflict do nothing;

with loser as (
  update public.email_prospects p
     set status = 'stopped', stop_reason = 'in_other_campaign'
    from public.email_campaigns c
   where c.id = p.campaign_id and p.lead_id is not null and p.status = 'active' and c.status not in ('done', 'archived')
     and exists (select 1 from public.lead_campaign_locks k where k.lead_id = p.lead_id and k.prospect_id <> p.id)
  returning p.id
)
select public.cancel_pending_steps(loser.id, 'in_other_campaign') from loser;

update public.leads l
   set status = 'in_campaign', updated_at = now()
  from public.lead_campaign_locks k
 where k.lead_id = l.id and l.status in ('new', 'call_list');

-- ---------------------------------------------------------------- triggers
-- BEFORE: fills lead_id from the candidate and applies C3 before the row is written. Definer: it must see every lock
-- of the workspace whoever writes the prospect. A per-lead advisory lock serializes two writers of the same lead.
create or replace function public.guard_prospect_lead()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and new.lead_id is null and new.candidate_id is not null then
    select c.lead_id into new.lead_id
      from public.research_candidates c
     where c.id = new.candidate_id and c.workspace_id = new.workspace_id;
  end if;
  if new.lead_id is not null and (tg_op = 'INSERT' or new.lead_id is distinct from old.lead_id)
     and not exists (select 1 from public.leads l where l.id = new.lead_id and l.workspace_id = new.workspace_id) then
    raise exception 'lead not in this workspace' using errcode = '42501';
  end if;
  if new.lead_id is null or new.status <> 'active' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'active' and old.lead_id is not distinct from new.lead_id then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('lead-campaign:' || new.lead_id::text, 0));
  if exists (select 1 from public.lead_campaign_locks k where k.lead_id = new.lead_id and k.prospect_id <> new.id) then
    if tg_op = 'INSERT' then
      new.status := 'stopped';
      new.stop_reason := 'in_other_campaign';
    else
      raise exception 'C3: lead already in an active campaign' using errcode = '23505';
    end if;
  end if;
  return new;
end;
$$;

-- AFTER: takes or drops the lock; moves the lead forward (never back).
create or replace function public.sync_lead_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hold boolean;
begin
  if tg_op = 'DELETE' then
    delete from public.lead_campaign_locks where prospect_id = old.id;
    return null;
  end if;
  v_hold := new.lead_id is not null and new.status = 'active'
            and exists (select 1 from public.email_campaigns c where c.id = new.campaign_id and c.status not in ('done', 'archived'));
  delete from public.lead_campaign_locks
   where prospect_id = new.id and (not v_hold or lead_id is distinct from new.lead_id);
  if v_hold and not exists (select 1 from public.lead_campaign_locks k where k.prospect_id = new.id) then
    -- no "on conflict": a lock held by another prospect here is a C3 violation (23505)
    insert into public.lead_campaign_locks (lead_id, workspace_id, campaign_id, prospect_id)
    values (new.lead_id, new.workspace_id, new.campaign_id, new.id);
    update public.leads set status = 'in_campaign', updated_at = now()
     where id = new.lead_id and status in ('new', 'call_list');
  end if;
  if new.lead_id is not null and new.status = 'replied' and (tg_op = 'INSERT' or old.status is distinct from 'replied') then
    update public.leads set status = 'replied', updated_at = now()
     where id = new.lead_id and status in ('new', 'call_list', 'in_campaign');
  end if;
  return null;
end;
$$;

-- A campaign that ends frees its leads; one that is reopened takes them back where they are still free.
create or replace function public.sync_campaign_locks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  p record;
begin
  if new.status in ('done', 'archived') and old.status not in ('done', 'archived') then
    delete from public.lead_campaign_locks where campaign_id = new.id;
  elsif old.status in ('done', 'archived') and new.status not in ('done', 'archived') then
    -- lock order: messages (by id) before prospects, as the claim core and the 0022 trigger do (no deadlock)
    perform 1
      from public.email_messages m
     where m.prospect_id in (select x.id from public.email_prospects x
                              where x.campaign_id = new.id and x.status = 'active' and x.lead_id is not null)
     order by m.id
       for update;
    for p in
      select x.id, x.lead_id, x.workspace_id
        from public.email_prospects x
       where x.campaign_id = new.id and x.status = 'active' and x.lead_id is not null
       order by x.lead_id, x.id   -- same advisory-lock order as add_leads_to_campaign (no deadlock)
    loop
      perform pg_advisory_xact_lock(hashtextextended('lead-campaign:' || p.lead_id::text, 0));
      if exists (select 1 from public.lead_campaign_locks k where k.lead_id = p.lead_id and k.prospect_id <> p.id) then
        update public.email_prospects set status = 'stopped', stop_reason = 'in_other_campaign' where id = p.id;
        perform public.cancel_pending_steps(p.id, 'in_other_campaign');
      elsif not exists (select 1 from public.lead_campaign_locks k where k.prospect_id = p.id) then
        insert into public.lead_campaign_locks (lead_id, workspace_id, campaign_id, prospect_id)
        values (p.lead_id, p.workspace_id, new.id, p.id);
        update public.leads set status = 'in_campaign', updated_at = now()
         where id = p.lead_id and status in ('new', 'call_list');
      end if;
    end loop;
  end if;
  return null;
end;
$$;

create trigger guard_prospect_lead
  before insert or update of status, lead_id on public.email_prospects
  for each row execute function public.guard_prospect_lead();
create trigger sync_lead_lock
  after insert or update of status, lead_id, campaign_id or delete on public.email_prospects
  for each row execute function public.sync_lead_lock();
create trigger sync_campaign_locks
  after update of status on public.email_campaigns
  for each row when (old.status is distinct from new.status)
  execute function public.sync_campaign_locks();

revoke all on function public.guard_prospect_lead() from public, anon, authenticated;
revoke all on function public.sync_lead_lock() from public, anon, authenticated;
revoke all on function public.sync_campaign_locks() from public, anon, authenticated;

-- 0003 body; added: a typed address also drops the lead source reference (R18).
create or replace function public.guard_email_prospect()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_email text;
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    return new;
  end if;
  if public.is_client_role() then
    -- R18: an address typed (or a suggestion confirmed) by a person is 'manual', stamped with who did it; it never
    -- inherits the research source. Changing the address drops the approvals given for the old one (R1).
    if new.email is distinct from old.email then
      v_email := nullif(lower(btrim(coalesce(new.email, ''))), '');
      if v_email is distinct from old.email then
        new.email := v_email;
        new.email_source := case when v_email is null then null else 'manual' end;
        new.email_source_url := null;
        new.email_source_ref := null;
        new.email_confirmed_by := case when v_email is null then null else auth.uid() end;
        if v_email is not null then
          new.suggested_email := null;
          new.suggested_email_url := null;
        end if;
        perform public.reset_prospect_approvals(old.id);
      else
        new.email := old.email;
      end if;
    end if;
    if new.status is distinct from old.status
       and not ((old.status = 'active' and new.status = 'skipped') or (old.status = 'skipped' and new.status = 'active'))
    then
      raise exception 'prospect status can only change between active and skipped here' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_email_prospect() from public, anon, authenticated;

-- ---------------------------------------------------------------- closer scope and calls follow lead_id
-- 0017 body; the lead is the prospect's own lead_id, else (older rows) its candidate's lead.
create or replace function public.prospect_visible_to_assignee(p_prospect uuid, p_ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.email_prospects p
      left join public.research_candidates c on c.id = p.candidate_id and c.workspace_id = p.workspace_id
      join public.leads l on l.id = coalesce(p.lead_id, c.lead_id) and l.workspace_id = p.workspace_id
     where p.id = p_prospect
       and p.workspace_id = p_ws
       and l.owner_id = auth.uid()
       and public.is_workspace_member(p_ws)
  );
$$;
revoke all on function public.prospect_visible_to_assignee(uuid, uuid) from public, anon;
grant execute on function public.prospect_visible_to_assignee(uuid, uuid) to authenticated;

-- 0020 body; added: a prospect linked by lead_id (leads put into a campaign directly).
create or replace function public.lead_in_active_campaign(p_lead uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.leads l where l.id = p_lead and l.status = 'in_campaign')
      or exists (
        select 1
          from public.email_prospects p
          join public.research_candidates c on c.id = p.candidate_id
         where c.lead_id = p_lead and p.status = 'active'
      )
      or exists (select 1 from public.email_prospects p where p.lead_id = p_lead and p.status = 'active');
$$;
revoke all on function public.lead_in_active_campaign(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- add_leads_to_campaign
-- Owner/sdr of the campaign's workspace put up to 500 leads into a campaign that is not archived. Per lead, in order:
-- blocked (lead_blocks_email) / in_other_campaign (locked by another campaign) / already (a prospect of this lead is in
-- this campaign) / no_email (no non-refuted, valid e-mail field) / suppressed / added. Ids that are not leads of the
-- workspace are ignored. The address: confirmed first, then the newest seen_at (R18: 'lead' + its field source).
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

  return jsonb_build_object('added', v_added, 'no_email', v_no_email, 'blocked', v_blocked,
                            'in_other_campaign', v_other, 'suppressed', v_suppressed, 'already', v_already);
end;
$$;

-- The best value of one field of a lead: not refuted, confirmed first, then the newest. Internal (plain, no grant).
create or replace function public.best_lead_field(p_lead uuid, p_field text)
returns text
language sql
stable
set search_path = ''
as $$
  select f.value from public.lead_fields f
   where f.lead_id = p_lead and f.field = p_field and f.status <> 'refuted'
   order by (f.status = 'confirmed') desc, f.seen_at desc, f.id
   limit 1;
$$;
revoke all on function public.best_lead_field(uuid, text) from public, anon, authenticated;

revoke all on function public.add_leads_to_campaign(uuid, uuid[]) from public, anon;
grant execute on function public.add_leads_to_campaign(uuid, uuid[]) to authenticated;
