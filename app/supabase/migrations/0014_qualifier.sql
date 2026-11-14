-- 0014 Qualificador (F3c-2), part 1: lead level, settings, queue, step log, ai_calls per lead.
--   Q1 a verified candidate copies its values onto its lead as lead_fields (source 'research').
--   Q2 leads.level 0-4 is computed from non-refuted lead_fields plus the proof of linked candidates;
--      a lower level leaves a visible leads.level_note until the sender acknowledges it (K-3).
--   Q3 one `qualifiers` row per workspace (created by the database); clients move only on <-> paused and the caps.
--   Q4 qualifier_queue (one row per lead) and qualifier_step_log; every new lead is enqueued, new imported values re-queue.
--   Q5 ai_calls gets lead_id and the Qualificador's tasks; settled cost adds to the lead's queue row.
--   Q6 the Qualificador's day is New York's; qualifier_status(ws) feeds its card.
-- Depends on 0001-0011 and 0013 (0012 is not required). Re-runnable.

-- ================================================================ Q2 columns first (functions below read them)
alter table public.leads
  add column if not exists level smallint not null default 0,
  add column if not exists level_note jsonb;
alter table public.leads drop constraint if exists leads_level;
alter table public.leads add constraint leads_level check (level between 0 and 4);

-- ================================================================ Q1 candidate values -> lead fields
create or replace function public.copy_candidate_fields(p_candidate uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.research_candidates;
  v_proof boolean;
  v_n integer;
begin
  select * into c from public.research_candidates x where x.id = p_candidate;
  if not found or c.lead_id is null or c.verified_at is null then
    return 0;
  end if;
  v_proof := exists (
    select 1
      from public.research_checks k
     where k.candidate_id = c.id and k.kind = 'decision_maker' and k.result = 'ok'
       and exists (select 1 from public.research_evidence e where e.check_id = k.id)
  );
  with vals (field, value, key, status) as (
    values
      ('name',          c.name,         c.name_key, 'confirmed'),
      ('website',       c.website,      null,       'confirmed'),
      ('phone',         c.phone,        null,       case when c.phone_source_url is not null then 'confirmed' else 'unverified' end),
      ('email',         c.public_email, null,       case when c.email_source_url is not null then 'confirmed' else 'unverified' end),
      ('city',          c.city,         null,       'confirmed'),
      ('state',         c.state,        null,       'confirmed'),
      ('contact_name',  c.ask_for_name, null,       case when v_proof then 'confirmed' else 'unverified' end),
      ('contact_title', c.ask_for_title, null,      case when v_proof then 'confirmed' else 'unverified' end)
  ), ins as (
    insert into public.lead_fields (workspace_id, lead_id, field, value, key, source, source_ref, status, seen_at)
    select c.workspace_id, c.lead_id, v.field, btrim(v.value), v.key, 'research', c.id::text, v.status, c.verified_at
      from vals v
     where v.value is not null and btrim(v.value) <> ''
    on conflict do nothing
    returning 1
  )
  select count(*) into v_n from ins;
  return v_n;
end;
$$;

create or replace function public.copy_candidate_fields_trg()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.copy_candidate_fields(new.id);
  return null;
end;
$$;

drop trigger if exists copy_candidate_fields on public.research_candidates;
create trigger copy_candidate_fields
  after insert or update of verified_at, lead_id on public.research_candidates
  for each row
  when (new.verified_at is not null and new.lead_id is not null)
  execute function public.copy_candidate_fields_trg();

-- A deleted candidate takes the values it copied with it (they have no other source). Runs before unlink_candidate_lead.
create or replace function public.delete_candidate_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.lead_fields f
   where f.lead_id = old.lead_id and f.source = 'research' and f.source_ref = old.id::text;
  return old;
end;
$$;

drop trigger if exists delete_candidate_fields on public.research_candidates;
create trigger delete_candidate_fields
  before delete on public.research_candidates
  for each row when (old.lead_id is not null)
  execute function public.delete_candidate_fields();

-- ================================================================ Q2 level
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
    when exists (select 1 from public.lead_fields f where f.lead_id = p_lead and f.field in ('phone', 'email') and f.status <> 'refuted') then 1
    else 0
  end::smallint;
$$;

-- p_field null = silent (no note), e.g. the back-fill and anything that can only raise the level.
create or replace function public.refresh_lead_level(p_lead uuid, p_field text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new smallint := public.lead_level(p_lead);
begin
  update public.leads l
     set level = v_new,
         level_note = case
           when p_field is not null and v_new < l.level
             then jsonb_build_object('from', l.level, 'to', v_new, 'field', p_field)
           else l.level_note
         end
   where l.id = p_lead and l.level is distinct from v_new;
end;
$$;

create or replace function public.level_from_lead_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.refresh_lead_level(new.lead_id, null);
  elsif tg_op = 'UPDATE' then
    perform public.refresh_lead_level(new.lead_id, new.field);
    if old.lead_id is distinct from new.lead_id then
      perform public.refresh_lead_level(old.lead_id, old.field);
    end if;
  else
    perform public.refresh_lead_level(old.lead_id, old.field);
  end if;
  return null;
end;
$$;

drop trigger if exists level_from_lead_fields on public.lead_fields;
create trigger level_from_lead_fields
  after insert or update or delete on public.lead_fields
  for each row execute function public.level_from_lead_fields();

create or replace function public.level_from_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lead uuid;
begin
  select c.lead_id into v_lead from public.research_candidates c where c.id = new.candidate_id;
  if v_lead is not null then
    perform public.refresh_lead_level(v_lead, null);
  end if;
  return null;
end;
$$;

drop trigger if exists level_from_check on public.research_checks;
create trigger level_from_check
  after insert on public.research_checks
  for each row execute function public.level_from_check();

-- Evidence is written after its check: the proof only counts once it exists.
create or replace function public.level_from_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lead uuid;
begin
  select c.lead_id into v_lead
    from public.research_checks k
    join public.research_candidates c on c.id = k.candidate_id
   where k.id = new.check_id;
  if v_lead is not null then
    perform public.refresh_lead_level(v_lead, null);
  end if;
  return null;
end;
$$;

drop trigger if exists level_from_evidence on public.research_evidence;
create trigger level_from_evidence
  after insert on public.research_evidence
  for each row execute function public.level_from_evidence();

create or replace function public.level_from_candidate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.refresh_lead_level(
    new.lead_id,
    case
      when new.second_pass is distinct from old.second_pass then 'second_pass'
      when new.temperature is distinct from old.temperature then 'temperature'
      else 'ask_for_name'
    end);
  return null;
end;
$$;

drop trigger if exists level_from_candidate on public.research_candidates;
create trigger level_from_candidate
  after update of temperature, second_pass, ask_for_name on public.research_candidates
  for each row
  when (new.lead_id is not null)
  execute function public.level_from_candidate();

-- The sender dismisses the "Nível caiu" note.
create or replace function public.ack_level_note(p_lead uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  select l.workspace_id into v_ws from public.leads l where l.id = p_lead;
  if auth.uid() is null or v_ws is null or not public.is_workspace_sender(v_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.leads set level_note = null where id = p_lead;
end;
$$;

-- ================================================================ Q3 qualifiers (one per workspace)
create table if not exists public.qualifiers (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  status text not null default 'on' constraint qualifiers_status check (status in ('on', 'paused')),
  paused_reason text constraint qualifiers_paused_reason check
    (paused_reason is null or paused_reason in ('user', 'daily_cap', 'workspace_cap', 'user_cap', 'global_cap', 'no_access')),
  paused_until timestamptz,
  daily_cap_usd numeric(6, 2) not null default 5 constraint qualifiers_daily_cap check (daily_cap_usd >= 0 and daily_cap_usd <= 100),
  lead_cap_usd numeric(6, 2) not null default 0.50 constraint qualifiers_lead_cap check (lead_cap_usd >= 0.05 and lead_cap_usd <= 5),
  auto_deep boolean not null default true,
  charge_user_id uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create or replace function public.create_workspace_qualifier()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.qualifiers (workspace_id, charge_user_id)
  values (new.id, new.created_by)
  on conflict (workspace_id) do nothing;
  return null;
end;
$$;

drop trigger if exists create_workspace_qualifier on public.workspaces;
create trigger create_workspace_qualifier
  after insert on public.workspaces
  for each row execute function public.create_workspace_qualifier();

-- Back-fill: the creator pays, else the oldest owner.
insert into public.qualifiers (workspace_id, charge_user_id)
select w.id,
       coalesce(
         w.created_by,
         (select m.user_id from public.workspace_members m where m.workspace_id = w.id and m.role = 'owner' order by m.created_at, m.user_id limit 1))
  from public.workspaces w
on conflict (workspace_id) do nothing;

-- The workspace's own daily cap, readable by its senders from the guard (which runs as the client).
create or replace function public.qualifier_workspace_cap(p_ws uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.is_workspace_sender(p_ws)
              then coalesce((select s.ai_daily_cap_usd from public.workspace_settings s where s.workspace_id = p_ws), 10)
         end;
$$;

-- Not security definer on purpose (like guard_agent): is_client_role() reads current_user.
create or replace function public.guard_qualifier()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_max numeric;
begin
  new.workspace_id := old.workspace_id;
  if public.is_client_role() then
    if new.status is distinct from old.status then
      if old.status = 'on' and new.status = 'paused' then
        new.paused_reason := 'user';
        new.paused_until := null;
      elsif old.status = 'paused' and new.status = 'on' then
        new.paused_reason := null;
        new.paused_until := null;
      else
        raise exception 'Q1: the Qualificador only moves between on and paused' using errcode = '23514';
      end if;
    end if;
    if new.daily_cap_usd is distinct from old.daily_cap_usd then
      v_max := least(coalesce(public.qualifier_workspace_cap(old.workspace_id), 10), 100);
      if new.daily_cap_usd < 0 or new.daily_cap_usd > v_max then
        raise exception 'Q1: the daily cap goes from 0 to US$ %', v_max using errcode = '23514';
      end if;
    end if;
    if new.lead_cap_usd is distinct from old.lead_cap_usd and (new.lead_cap_usd < 0.05 or new.lead_cap_usd > 5) then
      raise exception 'Q1: the lead cap goes from US$ 0.05 to US$ 5.00' using errcode = '23514';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists guard_qualifier on public.qualifiers;
create trigger guard_qualifier
  before update on public.qualifiers
  for each row execute function public.guard_qualifier();

-- ================================================================ Q4 queue and step log
create table if not exists public.qualifier_queue (
  lead_id uuid primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  next_step text not null default 'p1' constraint qualifier_queue_next_step check (next_step in ('p1', 'p2', 'p3', 'p4', 'p5', 'done')),
  done_reason text constraint qualifier_queue_done_reason check (done_reason is null or done_reason in ('complete', 'lead_cap', 'dead')),
  fail_step text constraint qualifier_queue_fail_step check (fail_step is null or fail_step in ('p1', 'p2', 'p3', 'p4', 'p5')),
  fail_streak integer not null default 0 constraint qualifier_queue_fail_streak check (fail_streak >= 0),
  spent_usd numeric(10, 6) not null default 0,
  priority_hunter boolean not null default false,
  profile_match boolean not null default false,
  manual_at timestamptz,
  deep_requested boolean not null default false,
  notes jsonb not null default '{}'::jsonb,
  enqueued_at timestamptz not null default now(),
  last_step_at timestamptz,
  locked_by uuid,
  locked_until timestamptz
);
alter table public.qualifier_queue drop constraint if exists qualifier_queue_lead_fkey;
alter table public.qualifier_queue
  add constraint qualifier_queue_lead_fkey foreign key (lead_id) references public.leads (id) on delete cascade;
create index if not exists qualifier_queue_claim_idx on public.qualifier_queue (workspace_id, next_step, enqueued_at) where next_step <> 'done';
create index if not exists qualifier_queue_done_idx on public.qualifier_queue (workspace_id, last_step_at) where next_step = 'done';

create table if not exists public.qualifier_step_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid not null,
  step text not null constraint qualifier_step_log_step check (step in ('p1', 'p2', 'p3', 'p4', 'p5')),
  outcome text not null constraint qualifier_step_log_outcome check (char_length(outcome) between 1 and 30),
  at timestamptz not null default now()
);
alter table public.qualifier_step_log drop constraint if exists qualifier_step_log_lead_fkey;
alter table public.qualifier_step_log
  add constraint qualifier_step_log_lead_fkey foreign key (lead_id) references public.leads (id) on delete cascade;
create index if not exists qualifier_step_log_ws_at_idx on public.qualifier_step_log (workspace_id, at);
create index if not exists qualifier_step_log_lead_idx on public.qualifier_step_log (lead_id);

create or replace function public.enqueue_lead_for_qualifier()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.qualifier_queue (lead_id, workspace_id, priority_hunter)
  values (new.id, new.workspace_id, new.origin_kind = 'agent')
  on conflict (lead_id) do nothing;
  return null;
end;
$$;

drop trigger if exists enqueue_lead_for_qualifier on public.leads;
create trigger enqueue_lead_for_qualifier
  after insert on public.leads
  for each row execute function public.enqueue_lead_for_qualifier();

-- New imported values (list file, Apify Maps, Apollo; 0013 widened the sources) re-queue a finished lead, not a dead one.
create or replace function public.requeue_lead_on_import()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.qualifier_queue q
     set next_step = 'p1', done_reason = null, fail_step = null, fail_streak = 0,
         enqueued_at = now(), locked_by = null, locked_until = null
   where q.lead_id = new.lead_id and q.next_step = 'done' and q.done_reason is distinct from 'dead';
  return null;
end;
$$;

drop trigger if exists requeue_lead_on_import on public.lead_fields;
create trigger requeue_lead_on_import
  after insert on public.lead_fields
  for each row
  when (new.source in ('import', 'apify_maps', 'apollo'))
  execute function public.requeue_lead_on_import();

-- ================================================================ Q5 ai_calls per lead
alter table public.ai_calls add column if not exists lead_id uuid references public.leads (id) on delete set null;
create index if not exists ai_calls_lead_idx on public.ai_calls (lead_id) where lead_id is not null;

alter table public.ai_calls drop constraint if exists ai_calls_task;
alter table public.ai_calls add constraint ai_calls_task check (
  task in ('research_questions', 'research_plan', 'research_discover', 'research_collect', 'research_verify',
           'research_second_pass', 'classify', 'email_draft', 'email_classify', 'email_reply_draft',
           'email_closer_brief', 'qualify_light', 'qualify_deep', 'qualify_places', 'profile_learn')
);

-- Gastos is read by owner and sdr only (0010 already did this; kept here so the screen's rule has one owner).
drop policy if exists ai_calls_select on public.ai_calls;
create policy ai_calls_select on public.ai_calls
  for select to authenticated using (public.is_workspace_sender(workspace_id));

-- Lead spend follows settled cost (insert and the one settling update), like add_ai_cost_to_run.
create or replace function public.add_ai_cost_to_lead()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delta numeric;
begin
  if new.lead_id is null then
    return null;
  end if;
  v_delta := new.cost_usd - case when tg_op = 'UPDATE' then old.cost_usd else 0 end;
  if v_delta <> 0 then
    update public.qualifier_queue q
       set spent_usd = q.spent_usd + v_delta
     where q.lead_id = new.lead_id and q.workspace_id = new.workspace_id;
  end if;
  return null;
end;
$$;

drop trigger if exists add_ai_cost_to_lead on public.ai_calls;
create trigger add_ai_cost_to_lead
  after insert or update of cost_usd on public.ai_calls
  for each row execute function public.add_ai_cost_to_lead();

-- ================================================================ Q6 New York day, today's spend, status
create or replace function public.qualifier_day_start_at(p_now timestamptz)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select date_trunc('day', p_now at time zone 'America/New_York') at time zone 'America/New_York';
$$;

create or replace function public.qualifier_day_start()
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select public.qualifier_day_start_at(now());
$$;

-- Internal: what the Qualificador spent today (a pending row counts at max(reserve, cost), like the caps do).
create or replace function public.qualifier_spent_today(p_ws uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(case when c.status = 'pending' then greatest(c.reserve_usd, c.cost_usd) else c.cost_usd end), 0)
    from public.ai_calls c
   where c.workspace_id = p_ws and c.lead_id is not null and left(c.task, 8) = 'qualify_'
     and c.created_at >= public.qualifier_day_start();
$$;

create or replace function public.qualifier_status(p_ws uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  q public.qualifiers;
  v_day timestamptz := public.qualifier_day_start();
begin
  if auth.uid() is null or p_ws is null or not public.is_workspace_sender(p_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into q from public.qualifiers x where x.workspace_id = p_ws;
  if not found then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'status', q.status,
    'paused_reason', q.paused_reason,
    'paused_until', q.paused_until,
    'daily_cap_usd', q.daily_cap_usd,
    'lead_cap_usd', q.lead_cap_usd,
    'auto_deep', q.auto_deep,
    'queued', (select count(*) from public.qualifier_queue z where z.workspace_id = p_ws and z.next_step <> 'done'),
    'done_today', (select count(*) from public.qualifier_queue z where z.workspace_id = p_ws and z.next_step = 'done' and z.last_step_at >= v_day),
    'spent_today', public.qualifier_spent_today(p_ws),
    'levels', (
      select jsonb_object_agg(g.n::text, coalesce(t.c, 0) order by g.n)
        from generate_series(0, 4) g (n)
        left join (select l.level, count(*) c from public.leads l where l.workspace_id = p_ws group by l.level) t on t.level = g.n
    ),
    'steps_today', jsonb_build_object(
      'free',   (select count(*) from public.qualifier_step_log s where s.workspace_id = p_ws and s.at >= v_day and s.outcome = 'ok' and s.step in ('p1', 'p2')),
      'places', (select count(*) from public.qualifier_step_log s where s.workspace_id = p_ws and s.at >= v_day and s.outcome = 'ok' and s.step = 'p3'),
      'light',  (select count(*) from public.qualifier_step_log s where s.workspace_id = p_ws and s.at >= v_day and s.outcome = 'ok' and s.step = 'p4'),
      'deep',   (select count(*) from public.qualifier_step_log s where s.workspace_id = p_ws and s.at >= v_day and s.outcome = 'ok' and s.step = 'p5')
    )
  );
end;
$$;

-- ================================================================ privileges and RLS
revoke all on function public.copy_candidate_fields(uuid) from public, anon, authenticated;
revoke all on function public.copy_candidate_fields_trg() from public, anon, authenticated;
revoke all on function public.delete_candidate_fields() from public, anon, authenticated;
revoke all on function public.lead_level(uuid) from public, anon, authenticated;
revoke all on function public.refresh_lead_level(uuid, text) from public, anon, authenticated;
revoke all on function public.level_from_lead_fields() from public, anon, authenticated;
revoke all on function public.level_from_check() from public, anon, authenticated;
revoke all on function public.level_from_evidence() from public, anon, authenticated;
revoke all on function public.level_from_candidate() from public, anon, authenticated;
revoke all on function public.ack_level_note(uuid) from public, anon;
grant execute on function public.ack_level_note(uuid) to authenticated;
revoke all on function public.create_workspace_qualifier() from public, anon, authenticated;
revoke all on function public.qualifier_workspace_cap(uuid) from public, anon;
grant execute on function public.qualifier_workspace_cap(uuid) to authenticated;
revoke all on function public.guard_qualifier() from public, anon, authenticated;
revoke all on function public.enqueue_lead_for_qualifier() from public, anon, authenticated;
revoke all on function public.requeue_lead_on_import() from public, anon, authenticated;
revoke all on function public.add_ai_cost_to_lead() from public, anon, authenticated;
revoke all on function public.qualifier_day_start_at(timestamptz) from public, anon;
revoke all on function public.qualifier_day_start() from public, anon;
grant execute on function public.qualifier_day_start_at(timestamptz) to authenticated;
grant execute on function public.qualifier_day_start() to authenticated;
revoke all on function public.qualifier_spent_today(uuid) from public, anon, authenticated;
revoke all on function public.qualifier_status(uuid) from public, anon;
grant execute on function public.qualifier_status(uuid) to authenticated;

revoke all on table public.qualifiers from public, anon, authenticated;
revoke all on table public.qualifier_queue from public, anon, authenticated;
revoke all on table public.qualifier_step_log from public, anon, authenticated;
grant select on table public.qualifiers to authenticated;
grant update (status, daily_cap_usd, lead_cap_usd, auto_deep) on table public.qualifiers to authenticated;
grant select on table public.qualifier_queue to authenticated;
grant select on table public.qualifier_step_log to authenticated;

alter table public.qualifiers enable row level security;
alter table public.qualifiers force row level security;
alter table public.qualifier_queue enable row level security;
alter table public.qualifier_queue force row level security;
alter table public.qualifier_step_log enable row level security;
alter table public.qualifier_step_log force row level security;

drop policy if exists qualifiers_select on public.qualifiers;
create policy qualifiers_select on public.qualifiers
  for select to authenticated using (public.is_workspace_sender(workspace_id));
drop policy if exists qualifiers_update on public.qualifiers;
create policy qualifiers_update on public.qualifiers
  for update to authenticated
  using (public.is_workspace_sender(workspace_id))
  with check (public.is_workspace_sender(workspace_id));
drop policy if exists qualifier_queue_select on public.qualifier_queue;
create policy qualifier_queue_select on public.qualifier_queue
  for select to authenticated using (public.is_workspace_sender(workspace_id));
drop policy if exists qualifier_step_log_select on public.qualifier_step_log;
create policy qualifier_step_log_select on public.qualifier_step_log
  for select to authenticated using (public.is_workspace_sender(workspace_id));

-- ================================================================ back-fill (silent: no level notes)
insert into public.qualifier_queue (lead_id, workspace_id, priority_hunter)
select l.id, l.workspace_id, l.origin_kind = 'agent'
  from public.leads l
on conflict (lead_id) do nothing;

select public.copy_candidate_fields(c.id)
  from public.research_candidates c
 where c.lead_id is not null and c.verified_at is not null;

select public.refresh_lead_level(l.id, null) from public.leads l;
