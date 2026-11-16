-- 0027 Leads phase 1 (Apollo-style base, docs/apollo-plano.md items 1-5).
--   1 leads.first_contacted_at / last_touch_at, set by the database only:
--       a logged call (call_logs insert), a REAL e-mail that went out (email_send_log result 'sent' with mode 'real'; a
--       dry_run rehearsal or a test e-mail never counts) and a hand-off to the closer (handed_off_at set, or the status
--       becoming with_closer). Existing rows are back-filled once.
--   2 lead_contact_values(ws) + lead_facets(ws, filters): counts per tab (new/contacted/all), city (top 12), level, has
--       phone, has e-mail and origin. Security invoker: RLS decides which leads are counted (the closer: hers only).
--       City/phone/e-mail mirror displayOf (src/lib/leads/view.ts): the best candidate's value, else the oldest
--       non-refuted lead_fields value.
--   3 lead_views: saved filters per user and workspace, at most one default.
--   4 lists + list_leads: named lists of leads (research_lists of 0002 hold research candidates, not leads, and feed
--       e-mail campaigns, so they are not reused). Owner/sdr only; the closer reads none. list_stats(ws) for the page.
--   5 tasks: one row per to-do on a lead. A logged call with a next-step date creates one (kind 'call', due at that
--       date, assigned to whoever called). Read and updated (done_at, due_at) like call_logs: senders, or the closer
--       assigned to the lead.
-- Depends on 0001-0026. Re-runnable.

-- ---------------------------------------------------------------- 1 contacted tracking
alter table public.leads
  add column if not exists first_contacted_at timestamptz,
  add column if not exists last_touch_at timestamptz;

create index if not exists leads_contacted_idx on public.leads (workspace_id, first_contacted_at);

-- ---------------------------------------------------------------- 5 tasks (before the call trigger that writes them)
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid not null,
  kind text not null default 'follow_up'
    constraint tasks_kind check (kind in ('call', 'email', 'follow_up', 'other')),
  -- empty = the screen shows a default for the kind
  title text not null default ''
    constraint tasks_title_len check (char_length(title) <= 200),
  due_at timestamptz not null,
  done_at timestamptz,
  assignee_id uuid references auth.users (id) on delete set null,
  created_from_call_id uuid,
  created_at timestamptz not null default now()
);
-- Plain FKs on purpose (like call_logs, 0020): a composite FK on leads (id, workspace_id) would block re-running 0011.
alter table public.tasks drop constraint if exists tasks_lead_fkey;
alter table public.tasks
  add constraint tasks_lead_fkey foreign key (lead_id) references public.leads (id) on delete cascade;
alter table public.tasks drop constraint if exists tasks_call_fkey;
alter table public.tasks
  add constraint tasks_call_fkey foreign key (created_from_call_id) references public.call_logs (id) on delete set null;
create unique index if not exists tasks_call_key on public.tasks (created_from_call_id) where created_from_call_id is not null;
create index if not exists tasks_open_idx on public.tasks (workspace_id, due_at) where done_at is null;
create index if not exists tasks_lead_idx on public.tasks (lead_id);

revoke all on table public.tasks from public, anon, authenticated;
grant select on table public.tasks to authenticated;
grant update (done_at, due_at) on table public.tasks to authenticated;
alter table public.tasks enable row level security;
alter table public.tasks force row level security;
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks
  for select to authenticated
  using (public.is_workspace_sender(workspace_id) or public.lead_visible_to_assignee(lead_id, workspace_id));
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks
  for update to authenticated
  using (public.is_workspace_sender(workspace_id) or public.lead_visible_to_assignee(lead_id, workspace_id))
  with check (public.is_workspace_sender(workspace_id) or public.lead_visible_to_assignee(lead_id, workspace_id));

-- ---------------------------------------------------------------- 1 triggers
-- Definer like the other cross-table triggers (0009 link_candidate_lead, 0020 release_member_leads): it writes leads and
-- tasks, which clients cannot write, and must never make log_call fail for the caller's lack of grants.
create or replace function public.after_call_logged()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.leads
     set first_contacted_at = coalesce(first_contacted_at, new.called_at),
         last_touch_at = greatest(last_touch_at, new.called_at)
   where id = new.lead_id;
  -- "do not call" ends the conversation: no follow-up task even if a date was typed
  if new.next_step_at is not null and new.outcome <> 'do_not_call' then
    insert into public.tasks (workspace_id, lead_id, kind, title, due_at, assignee_id, created_from_call_id)
    values (new.workspace_id, new.lead_id, 'call', new.next_step, new.next_step_at, new.called_by, new.id)
    on conflict do nothing;
  end if;
  return null;
end;
$$;

drop trigger if exists after_call_logged on public.call_logs;
create trigger after_call_logged
  after insert on public.call_logs
  for each row execute function public.after_call_logged();

-- Only a real send counts: a rehearsal ends as 'dry_run' and a test e-mail has mode 'test' and no prospect.
-- Definer for the same reason as above: the send log is finished by definer RPCs, and this must never fail them.
create or replace function public.mark_lead_emailed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_at timestamptz := coalesce(new.finished_at, now());
begin
  if new.mode = 'real' and new.result = 'sent' and new.prospect_id is not null
     and (tg_op = 'INSERT' or old.result is distinct from 'sent') then
    update public.leads l
       set first_contacted_at = coalesce(l.first_contacted_at, v_at),
           last_touch_at = greatest(l.last_touch_at, v_at)
      from public.email_prospects p
     where p.id = new.prospect_id and p.lead_id = l.id and l.workspace_id = new.workspace_id;
  end if;
  return null;
end;
$$;

drop trigger if exists mark_lead_emailed on public.email_send_log;
create trigger mark_lead_emailed
  after insert or update of result on public.email_send_log
  for each row execute function public.mark_lead_emailed();

-- Hand-off: hand_off_lead sets handed_off_at; any other path that moves the lead to with_closer counts too.
-- Invoker: it only edits the row being written.
create or replace function public.mark_lead_handed_off()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  if new.handed_off_at is not null and new.handed_off_at is distinct from old.handed_off_at then
    v_at := new.handed_off_at;
  elsif new.status = 'with_closer' and old.status is distinct from 'with_closer' then
    v_at := now();
  else
    return new;
  end if;
  new.first_contacted_at := coalesce(new.first_contacted_at, v_at);
  new.last_touch_at := greatest(new.last_touch_at, v_at);
  return new;
end;
$$;

drop trigger if exists mark_lead_handed_off on public.leads;
create trigger mark_lead_handed_off
  before update of handed_off_at, status on public.leads
  for each row execute function public.mark_lead_handed_off();

-- Back-fill once (only leads still without a first contact, so re-running changes nothing).
update public.leads l
   set first_contacted_at = s.first_at, last_touch_at = s.last_at
  from (
    select e.lead_id, min(e.at) as first_at, max(e.at) as last_at
      from (
        select k.lead_id, k.called_at as at from public.call_logs k
        union all
        select p.lead_id, coalesce(g.finished_at, g.claimed_at)
          from public.email_send_log g
          join public.email_prospects p on p.id = g.prospect_id and p.workspace_id = g.workspace_id
         where g.mode = 'real' and g.result = 'sent' and p.lead_id is not null
        union all
        select x.id, x.handed_off_at from public.leads x where x.handed_off_at is not null
      ) e
     group by e.lead_id
  ) s
 where l.id = s.lead_id and l.first_contacted_at is null;

-- ---------------------------------------------------------------- 4 lists
create table if not exists public.lists (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null
    constraint lists_name_len check (char_length(btrim(name)) between 1 and 120),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint lists_name_key unique (workspace_id, name)
);

create table if not exists public.list_leads (
  list_id uuid not null references public.lists (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (list_id, lead_id)
);
create index if not exists list_leads_lead_idx on public.list_leads (lead_id);

revoke all on table public.lists from public, anon, authenticated;
revoke all on table public.list_leads from public, anon, authenticated;
grant select, delete on table public.lists to authenticated;
grant insert (workspace_id, name) on table public.lists to authenticated;
grant update (name) on table public.lists to authenticated;
grant select, delete on table public.list_leads to authenticated;
grant insert (list_id, lead_id, workspace_id) on table public.list_leads to authenticated;

alter table public.lists enable row level security;
alter table public.lists force row level security;
alter table public.list_leads enable row level security;
alter table public.list_leads force row level security;

drop policy if exists lists_select on public.lists;
create policy lists_select on public.lists
  for select to authenticated using (public.is_workspace_sender(workspace_id));
drop policy if exists lists_insert on public.lists;
create policy lists_insert on public.lists
  for insert to authenticated with check (public.is_workspace_sender(workspace_id));
drop policy if exists lists_update on public.lists;
create policy lists_update on public.lists
  for update to authenticated
  using (public.is_workspace_sender(workspace_id))
  with check (public.is_workspace_sender(workspace_id));
drop policy if exists lists_delete on public.lists;
create policy lists_delete on public.lists
  for delete to authenticated using (public.is_workspace_sender(workspace_id));

drop policy if exists list_leads_select on public.list_leads;
create policy list_leads_select on public.list_leads
  for select to authenticated using (public.is_workspace_sender(workspace_id));
-- list and lead must both be of the row's workspace (the sender sees every lead and list of it)
drop policy if exists list_leads_insert on public.list_leads;
create policy list_leads_insert on public.list_leads
  for insert to authenticated
  with check (
    public.is_workspace_sender(workspace_id)
    and exists (select 1 from public.lists x where x.id = list_id and x.workspace_id = list_leads.workspace_id)
    and exists (select 1 from public.leads l where l.id = lead_id and l.workspace_id = list_leads.workspace_id)
  );
drop policy if exists list_leads_delete on public.list_leads;
create policy list_leads_delete on public.list_leads
  for delete to authenticated using (public.is_workspace_sender(workspace_id));

-- ---------------------------------------------------------------- 3 saved views
create table if not exists public.lead_views (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null
    constraint lead_views_name_len check (char_length(btrim(name)) between 1 and 60),
  filters jsonb not null default '{}'::jsonb
    constraint lead_views_filters check (jsonb_typeof(filters) = 'object' and pg_column_size(filters) <= 4000),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  constraint lead_views_name_key unique (workspace_id, user_id, name)
);
create unique index if not exists lead_views_one_default on public.lead_views (workspace_id, user_id) where is_default;

revoke all on table public.lead_views from public, anon, authenticated;
grant select, delete on table public.lead_views to authenticated;
grant insert (workspace_id, name, filters, is_default) on table public.lead_views to authenticated;
grant update (name, filters, is_default) on table public.lead_views to authenticated;
alter table public.lead_views enable row level security;
alter table public.lead_views force row level security;
drop policy if exists lead_views_own on public.lead_views;
create policy lead_views_own on public.lead_views
  for all to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------- 2 facets and list stats
-- One row per lead the caller can see, with what the list shows (invoker: RLS on leads, candidates and fields applies).
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
                        order by f.seen_at, f.created_at, f.id limit 1) fe on true
   where l.workspace_id = p_ws
     -- the list skips a lead whose best candidate the caller cannot see; so do the counts
     and (l.best_candidate_id is null or c.id is not null);
$$;

-- p_filters: { contact: 'new'|'contacted'|'all', cities: text[], levels: int[], hasPhone: bool, hasEmail: bool,
-- origins: text[], listId: uuid }. Each facet is counted with every OTHER filter applied (its own is left out), so a
-- picked value never hides its siblings; the tabs are counted with every facet filter applied.
create or replace function public.lead_facets(p_ws uuid, p_filters jsonb default '{}'::jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with f as (
    select coalesce(p_filters ->> 'contact', 'all') as contact,
           array(select jsonb_array_elements_text(case when jsonb_typeof(p_filters -> 'cities') = 'array' then p_filters -> 'cities' else '[]'::jsonb end)) as cities,
           array(select x::smallint from jsonb_array_elements_text(case when jsonb_typeof(p_filters -> 'levels') = 'array' then p_filters -> 'levels' else '[]'::jsonb end) x
                  where x ~ '^[0-4]$') as levels,
           coalesce(p_filters ->> 'hasPhone', '') = 'true' as has_phone,
           coalesce(p_filters ->> 'hasEmail', '') = 'true' as has_email,
           array(select jsonb_array_elements_text(case when jsonb_typeof(p_filters -> 'origins') = 'array' then p_filters -> 'origins' else '[]'::jsonb end)) as origins,
           case when coalesce(p_filters ->> 'listId', '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                then (p_filters ->> 'listId')::uuid end as list_id
  ),
  m as (
    select v.*,
           case f.contact when 'new' then not v.contacted when 'contacted' then v.contacted else true end as m_tab,
           (cardinality(f.cities) = 0 or v.city = any (f.cities)) as m_city,
           (cardinality(f.levels) = 0 or v.level = any (f.levels)) as m_level,
           (not f.has_phone or v.phone is not null) as m_phone,
           (not f.has_email or v.email is not null) as m_email,
           (cardinality(f.origins) = 0 or v.origin_kind = any (f.origins)) as m_origin
      from public.lead_contact_values(p_ws) v
     cross join f
     where f.list_id is null
        or exists (select 1 from public.list_leads x where x.list_id = f.list_id and x.lead_id = v.lead_id)
  )
  select jsonb_build_object(
    'tabs', (select jsonb_build_object('new', count(*) filter (where not contacted), 'contacted', count(*) filter (where contacted), 'all', count(*))
               from m where m_city and m_level and m_phone and m_email and m_origin),
    'cities', (select coalesce(jsonb_agg(jsonb_build_object('value', s.city, 'n', s.n) order by s.n desc, s.city), '[]'::jsonb)
                 from (select city, count(*)::integer as n from m
                        where city is not null and m_tab and m_level and m_phone and m_email and m_origin
                        group by city order by count(*) desc, city limit 12) s),
    'levels', (select coalesce(jsonb_agg(jsonb_build_object('value', s.level, 'n', s.n) order by s.level desc), '[]'::jsonb)
                 from (select level, count(*)::integer as n from m
                        where m_tab and m_city and m_phone and m_email and m_origin group by level) s),
    'phone', (select count(*) filter (where phone is not null) from m where m_tab and m_city and m_level and m_email and m_origin),
    'email', (select count(*) filter (where email is not null) from m where m_tab and m_city and m_level and m_phone and m_origin),
    'origins', (select coalesce(jsonb_agg(jsonb_build_object('value', s.origin_kind, 'n', s.n) order by s.n desc, s.origin_kind), '[]'::jsonb)
                  from (select origin_kind, count(*)::integer as n from m
                         where m_tab and m_city and m_level and m_phone and m_email group by origin_kind) s)
  );
$$;

-- The Listas page: per list, its leads the caller can see, how many were contacted and how many have a phone.
create or replace function public.list_stats(p_ws uuid)
returns table (id uuid, name text, created_at timestamptz, leads integer, contacted integer, with_phone integer)
language sql
stable
security invoker
set search_path = ''
as $$
  select x.id, x.name, x.created_at,
         count(v.lead_id)::integer,
         count(v.lead_id) filter (where v.contacted)::integer,
         count(v.lead_id) filter (where v.phone is not null)::integer
    from public.lists x
    left join public.list_leads ll on ll.list_id = x.id
    left join public.lead_contact_values(p_ws) v on v.lead_id = ll.lead_id
   where x.workspace_id = p_ws
   group by x.id, x.name, x.created_at
   order by x.created_at desc, x.id;
$$;

-- ---------------------------------------------------------------- privileges (functions)
revoke all on function public.after_call_logged() from public, anon, authenticated;
revoke all on function public.mark_lead_emailed() from public, anon, authenticated;
revoke all on function public.mark_lead_handed_off() from public, anon, authenticated;
revoke all on function public.lead_contact_values(uuid) from public, anon;
revoke all on function public.lead_facets(uuid, jsonb) from public, anon;
revoke all on function public.list_stats(uuid) from public, anon;
grant execute on function public.lead_contact_values(uuid) to authenticated;
grant execute on function public.lead_facets(uuid, jsonb) to authenticated;
grant execute on function public.list_stats(uuid) to authenticated;
