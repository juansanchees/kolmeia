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

-- A deleted candidate takes the values it copied with it, on its lead and on any lead P1 merged them into (they have
-- no other source). Runs before unlink_candidate_lead.
create index if not exists lead_fields_research_ref_idx on public.lead_fields (source_ref) where source = 'research';
create or replace function public.delete_candidate_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.lead_fields f
   where f.workspace_id = old.workspace_id and f.source = 'research' and f.source_ref = old.id::text;
  return old;
end;
$$;

drop trigger if exists delete_candidate_fields on public.research_candidates;
create trigger delete_candidate_fields
  before delete on public.research_candidates
  for each row
  execute function public.delete_candidate_fields();

-- The level must follow a candidate that goes away or moves to another lead (the BEFORE DELETE trigger above runs before
-- the row is gone, so it cannot see the final state).
create or replace function public.level_after_candidate_move()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.lead_id is not null then
    perform public.refresh_lead_level(old.lead_id, 'candidate');
  end if;
  if tg_op = 'UPDATE' and new.lead_id is not null then
    perform public.refresh_lead_level(new.lead_id, null);
  end if;
  return null;
end;
$$;
drop trigger if exists level_after_candidate_delete on public.research_candidates;
create trigger level_after_candidate_delete
  after delete on public.research_candidates
  for each row execute function public.level_after_candidate_move();
drop trigger if exists level_after_candidate_relink on public.research_candidates;
create trigger level_after_candidate_relink
  after update of lead_id on public.research_candidates
  for each row when (old.lead_id is distinct from new.lead_id)
  execute function public.level_after_candidate_move();

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
             then jsonb_build_object('from', l.level, 'to', v_new, 'field', p_field, 'tx', txid_current())
           -- the level came back to what the note said it fell from inside the SAME transaction (a check rewritten in
           -- one call): nothing to tell. A later rise never clears a note nobody acknowledged.
           when l.level_note is not null and v_new >= (l.level_note->>'from')::smallint
                and (l.level_note->>'tx')::bigint = txid_current() then null
           else l.level_note
         end
   where l.id = p_lead and (l.level is distinct from v_new
         or (l.level_note is not null and v_new >= (l.level_note->>'from')::smallint and (l.level_note->>'tx')::bigint = txid_current()));
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
    -- a deleted value (undo of an import, a deleted candidate) is not a refutation: silent
    perform public.refresh_lead_level(old.lead_id, null);
  end if;
  return null;
end;
$$;

drop trigger if exists level_from_lead_fields on public.lead_fields;
create trigger level_from_lead_fields
  after insert or update or delete on public.lead_fields
  for each row execute function public.level_from_lead_fields();

-- The contact values of a candidate are 'confirmed' only while its decision_maker proof (an ok check with evidence)
-- exists; without it they stop counting (unverified); with it again they count again. Refuted rows stay refuted.
create or replace function public.sync_candidate_contact(p_candidate uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.research_candidates;
  v_proof boolean;
begin
  select * into c from public.research_candidates x where x.id = p_candidate;
  if not found or c.lead_id is null then
    return;
  end if;
  v_proof := exists (
    select 1 from public.research_checks k
     where k.candidate_id = c.id and k.kind = 'decision_maker' and k.result = 'ok'
       and exists (select 1 from public.research_evidence e where e.check_id = k.id));
  update public.lead_fields f
     set status = case when v_proof then 'confirmed' else 'unverified' end
   where f.workspace_id = c.workspace_id and f.source = 'research' and f.source_ref = c.id::text
     and f.field in ('contact_name', 'contact_title') and f.status <> 'refuted'
     and f.status is distinct from case when v_proof then 'confirmed' else 'unverified' end;
end;
$$;

-- Checks and their evidence change by upsert (result flips) and by delete-then-insert: every such change refreshes the
-- level. A fall writes the note; the level coming back to its old height in the same call clears it again.
create or replace function public.level_from_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cand uuid := case when tg_op = 'DELETE' then old.candidate_id else new.candidate_id end;
  v_lead uuid;
begin
  select c.lead_id into v_lead from public.research_candidates c where c.id = v_cand;
  if v_lead is not null then
    perform public.sync_candidate_contact(v_cand);
    perform public.refresh_lead_level(v_lead, case when tg_op = 'INSERT' then null else (case when tg_op = 'DELETE' then old.kind else new.kind end) end);
  end if;
  return null;
end;
$$;

drop trigger if exists level_from_check on public.research_checks;
create trigger level_from_check
  after insert or update of result or delete on public.research_checks
  for each row execute function public.level_from_check();

-- Evidence is written after its check: the proof only counts once it exists, and stops when it is deleted.
create or replace function public.level_from_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_check uuid := case when tg_op = 'DELETE' then old.check_id else new.check_id end;
  v_lead uuid;
  v_cand uuid;
  v_kind text;
begin
  select c.lead_id, c.id, k.kind into v_lead, v_cand, v_kind
    from public.research_checks k
    join public.research_candidates c on c.id = k.candidate_id
   where k.id = v_check;
  if v_lead is not null then
    perform public.sync_candidate_contact(v_cand);
    perform public.refresh_lead_level(v_lead, case when tg_op = 'DELETE' then v_kind else null end);
  end if;
  return null;
end;
$$;

drop trigger if exists level_from_evidence on public.research_evidence;
create trigger level_from_evidence
  after insert or delete on public.research_evidence
  for each row execute function public.level_from_evidence();

create or replace function public.level_from_candidate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- a refuted candidate's copied values stop counting
  if new.second_pass = 'refuted' and old.second_pass is distinct from 'refuted' then
    update public.lead_fields f set status = 'refuted'
     where f.workspace_id = new.workspace_id and f.source = 'research' and f.source_ref = new.id::text and f.status <> 'refuted';
  end if;
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

-- Pausing by hand while the daily-cap pause is active makes it the user's pause: it must not resume at midnight.
-- (BEFORE UPDATE OF status: fires when the client's UPDATE names status.)
create or replace function public.qualifier_user_pause()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_client_role() and old.status = 'paused' and new.status = 'paused' and old.paused_reason = 'daily_cap' then
    new.paused_reason := 'user';
    new.paused_until := null;
  end if;
  return new;
end;
$$;
drop trigger if exists qualifier_user_pause on public.qualifiers;
create trigger qualifier_user_pause
  before update of status on public.qualifiers
  for each row execute function public.qualifier_user_pause();
revoke all on function public.qualifier_user_pause() from public, anon, authenticated;

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
stable
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
   where c.workspace_id = p_ws and left(c.task, 8) = 'qualify_'
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
-- Session functions (granted to authenticated, the exception to the anon-only tick path of part 2): ack_level_note,
-- qualifier_workspace_cap, qualifier_day_start_at, qualifier_day_start, qualifier_status (and request_qualification below).
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

-- ================================================================ workspace always comes from the lead
create or replace function public.workspace_from_lead()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select l.workspace_id into new.workspace_id from public.leads l where l.id = new.lead_id;
  if new.workspace_id is null then
    raise exception 'lead not found' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists workspace_from_lead on public.qualifier_queue;
create trigger workspace_from_lead before insert or update of lead_id, workspace_id on public.qualifier_queue
  for each row execute function public.workspace_from_lead();
drop trigger if exists workspace_from_lead on public.qualifier_step_log;
create trigger workspace_from_lead before insert or update of lead_id, workspace_id on public.qualifier_step_log
  for each row execute function public.workspace_from_lead();

create or replace function public.ai_call_lead_in_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.lead_id is not null and not exists (select 1 from public.leads l where l.id = new.lead_id and l.workspace_id = new.workspace_id) then
    raise exception 'lead is not in the workspace' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists ai_call_lead_in_workspace on public.ai_calls;
create trigger ai_call_lead_in_workspace before insert or update of lead_id, workspace_id on public.ai_calls
  for each row execute function public.ai_call_lead_in_workspace();
revoke all on function public.workspace_from_lead() from public, anon, authenticated;
revoke all on function public.ai_call_lead_in_workspace() from public, anon, authenticated;
revoke all on function public.sync_candidate_contact(uuid) from public, anon, authenticated;

-- when a tick claimed the lead (new imported values after it re-queue the lead instead of closing it)
alter table public.qualifier_queue add column if not exists claimed_at timestamptz;

-- ============================================================================================================
-- Part 2 (T2): the Qualificador's token-gated path. Same rules as 0010 hunter_* and 0013 source_*: SECURITY DEFINER,
-- empty search_path, scheduler_authorized() first (42501), granted to anon only, every write under the tick's claim of
-- ONE lead; workspace_id always comes from the lead. Caps are the Qualificador's own (day = New York) on the shared
-- ledger: reserve/settle go through reserve_ai_call_core/settle_ai_call_core (0010) with p_run = null.
-- ============================================================================================================
create table if not exists public.qualifier_ticks (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  lease_until timestamptz not null,
  finished_at timestamptz,
  counts jsonb not null default '{}'::jsonb,
  error text constraint qualifier_ticks_error check (char_length(error) <= 60)
);
create index if not exists qualifier_ticks_started_idx on public.qualifier_ticks (started_at desc);
alter table public.qualifier_ticks enable row level security;
alter table public.qualifier_ticks force row level security;
revoke all on table public.qualifier_ticks from public, anon, authenticated;

-- Scope of one call: token, open tick, a lead with a queue row. A write also needs the lead's lock held by this tick
-- and the lead not finished. Returns the lead's workspace. Not SECURITY DEFINER: runs with the entry point's rights.
create or replace function public.qualifier_assert(p_tick uuid, p_lead uuid, p_write boolean)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v record;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from public.qualifier_ticks t where t.id = p_tick and t.finished_at is null and t.lease_until > now()) then
    raise exception 'tick is not open' using errcode = '55000';
  end if;
  select q.workspace_id, q.next_step, q.locked_by, q.locked_until into v
    from public.qualifier_queue q where q.lead_id = p_lead;
  if not found then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_write then
    if v.next_step = 'done' then
      raise exception 'lead is finished' using errcode = '55000';
    end if;
    if v.locked_by is distinct from p_tick or v.locked_until is null or v.locked_until <= now() then
      raise exception 'lead lock not held' using errcode = '55000';
    end if;
  end if;
  return v.workspace_id;
end;
$$;

create or replace function public.qualifier_begin_tick()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('qualifier:tick'));
  delete from public.qualifier_ticks where started_at < now() - interval '30 days';
  if exists (select 1 from public.qualifier_ticks t where t.finished_at is null and t.lease_until > now()) then
    return jsonb_build_object('tick_id', null, 'busy', true);
  end if;
  update public.qualifier_ticks set finished_at = now(), error = 'lease_expired' where finished_at is null;
  insert into public.qualifier_ticks (lease_until) values (now() + interval '330 seconds') returning id into v_id;
  return jsonb_build_object('tick_id', v_id, 'busy', false);
end;
$$;

create or replace function public.qualifier_finish_tick(p_tick uuid, p_counts jsonb, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_counts jsonb;
  v_n integer;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select coalesce(jsonb_object_agg(e.key, least(greatest((e.value #>> '{}')::numeric, 0), 100000)), '{}'::jsonb) into v_counts
    from (
      select j.key, j.value
        from jsonb_each(case when jsonb_typeof(p_counts) = 'object' then p_counts else '{}'::jsonb end) j
       where jsonb_typeof(j.value) = 'number' and j.key ~ '^[a-zA-Z_]{1,30}$'
       limit 10
    ) e;
  update public.qualifier_ticks t
     set finished_at = now(), counts = v_counts, error = left(p_error, 60)
   where t.id = p_tick and t.finished_at is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'tick is not open' using errcode = '55000';
  end if;
  -- no lead lock outlives its tick
  update public.qualifier_queue q set locked_by = null, locked_until = null where q.locked_by = p_tick;
end;
$$;

-- The next lead (K-4): first a daily-cap pause whose New York midnight has passed ends; then manual requests (oldest
-- first), then Caçador-born or profile-matching leads, then higher level, then oldest enqueued. Locks it for 180 s.
create or replace function public.qualifier_claim_next(p_tick uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lead uuid;
  v_ws uuid;
  v_out jsonb;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from public.qualifier_ticks t where t.id = p_tick and t.finished_at is null and t.lease_until > now()) then
    raise exception 'tick is not open' using errcode = '55000';
  end if;
  update public.qualifiers z
     set status = 'on', paused_reason = null, paused_until = null
   where z.status = 'paused' and z.paused_reason = 'daily_cap' and z.paused_until is not null and z.paused_until <= now();

  select q.lead_id, q.workspace_id into v_lead, v_ws
    from public.qualifier_queue q
    join public.qualifiers z on z.workspace_id = q.workspace_id and z.status = 'on'
    join public.leads l on l.id = q.lead_id
   where q.next_step <> 'done' and (q.locked_until is null or q.locked_until <= now())
   order by (q.manual_at is not null) desc, q.manual_at asc,
            (q.priority_hunter or q.profile_match) desc, l.level desc, q.enqueued_at asc, q.lead_id
   limit 1
     for update of q skip locked;
  if v_lead is null then
    return null;
  end if;
  update public.qualifier_queue q set locked_by = p_tick, locked_until = now() + interval '180 seconds', claimed_at = now() where q.lead_id = v_lead;

  select jsonb_build_object(
    'lead_id', q.lead_id,
    'workspace_id', q.workspace_id,
    'next_step', q.next_step,
    'level', l.level,
    'spent_usd', q.spent_usd,
    'fail_step', q.fail_step,
    'fail_streak', q.fail_streak,
    'deep_requested', q.deep_requested,
    'manual', q.manual_at is not null,
    'profile_match', q.profile_match,
    'notes', q.notes,
    'fields', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'lead_id', f.lead_id, 'field', f.field, 'value', f.value, 'source', f.source,
                                          'source_ref', f.source_ref, 'status', f.status, 'excerpt', f.excerpt, 'seen_at', f.seen_at)
                       order by f.seen_at, f.id)
        from public.lead_fields f where f.lead_id = q.lead_id), '[]'::jsonb),
    'best', (
      select jsonb_build_object('name', c.name, 'website', c.website, 'phone', c.phone, 'city', c.city, 'state', c.state)
        from public.research_candidates c where c.id = l.best_candidate_id and c.workspace_id = q.workspace_id),
    'settings', jsonb_build_object(
      'daily_cap_usd', z.daily_cap_usd, 'lead_cap_usd', z.lead_cap_usd, 'auto_deep', z.auto_deep,
      'spent_today', public.qualifier_spent_today(q.workspace_id)),
    -- F3c-3 sets the approved company profile; until then there is none
    'company_profile', null
  ) into v_out
    from public.qualifier_queue q
    join public.leads l on l.id = q.lead_id
    join public.qualifiers z on z.workspace_id = q.workspace_id
   where q.lead_id = v_lead;
  return v_out;
end;
$$;

-- P1 juntar (free): the lead's linked candidates copy their values; unlinked candidates of the workspace that share a
-- key (name, site domain, phone) add theirs as unverified. Never overwrites: another value is another row.
create or replace function public.qualifier_merge(p_tick uuid, p_lead uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  v_n integer := 0;
  v_m integer;
  v_c uuid;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_ws := public.qualifier_assert(p_tick, p_lead, true);
  for v_c in select c.id from public.research_candidates c where c.lead_id = p_lead and c.verified_at is not null and c.second_pass is distinct from 'refuted' loop
    v_n := v_n + public.copy_candidate_fields(v_c);
  end loop;
  with keys as (
    select f.field, f.key from public.lead_fields f
     where f.lead_id = p_lead and f.status <> 'refuted' and f.key is not null and f.field in ('name', 'website', 'phone')
  ), cand as (
    select c.* from public.research_candidates c
     where c.workspace_id = v_ws and c.lead_id is null and c.second_pass is distinct from 'refuted'
       and (exists (select 1 from keys k where k.field = 'name' and k.key = c.name_key)
         or exists (select 1 from keys k where k.field = 'website' and k.key = public.company_domain_key(c.website))
         or exists (select 1 from keys k where k.field = 'phone' and k.key = public.company_phone_key(c.phone)))
     order by c.created_at, c.id
     limit 20
  ), vals as (
    select c.id as cid, v.field, v.value, v.key
      from cand c
      cross join lateral (values
        ('name', c.name, c.name_key), ('website', c.website, null), ('phone', c.phone, null),
        ('email', c.public_email, null), ('city', c.city, null), ('state', c.state, null)) v (field, value, key)
     where v.value is not null and btrim(v.value) <> ''
  ), ins as (
    insert into public.lead_fields (workspace_id, lead_id, field, value, key, source, source_ref, status)
    select v_ws, p_lead, v.field, left(btrim(v.value), 1000), v.key, 'research', v.cid::text, 'unverified' from vals v
    on conflict do nothing
    returning 1
  )
  select count(*) into v_m from ins;
  return v_n + v_m;
end;
$$;

create or replace function public.qualifier_add_fields(p_tick uuid, p_lead uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  r jsonb;
  k text;
  v_n integer := 0;
  v_i integer;
  v_value text;
  v_seen timestamptz;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_ws := public.qualifier_assert(p_tick, p_lead, true);
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 50 then
    raise exception 'rows must be an array of at most 50' using errcode = '22023';
  end if;
  for r in select e from jsonb_array_elements(p_rows) e loop
    if jsonb_typeof(r) <> 'object' then
      raise exception 'row must be an object' using errcode = '22023';
    end if;
    for k in select jsonb_object_keys(r) loop
      if k <> all (array['field', 'value', 'key', 'source', 'source_ref', 'status', 'excerpt', 'seen_at']) then
        raise exception 'key not allowed in a field row: %', k using errcode = '22023';
      end if;
    end loop;
    if r->>'field' is null or r->>'field' <> all (array['name', 'phone', 'email', 'website', 'address', 'city', 'state', 'zip',
         'contact_name', 'contact_title', 'company_type', 'note', 'active_project', 'place_id']) then
      raise exception 'unknown field' using errcode = '22023';
    end if;
    if r->>'source' is null or r->>'source' <> all (array['site', 'places', 'ai']) then
      raise exception 'source must be site, places or ai' using errcode = '22023';
    end if;
    if coalesce(r->>'status', 'unverified') <> all (array['confirmed', 'unverified']) then
      raise exception 'status must be confirmed or unverified' using errcode = '22023';
    end if;
    v_value := btrim(r->>'value');
    if v_value is null or char_length(v_value) not between 1 and 1000
       or char_length(coalesce(r->>'excerpt', '')) > 300 or char_length(coalesce(r->>'source_ref', '')) > 2000 then
      raise exception 'value, excerpt or source_ref out of range' using errcode = '22023';
    end if;
    begin
      v_seen := least(coalesce((r->>'seen_at')::timestamptz, now()), now());
    exception when others then
      raise exception 'seen_at is not a timestamp' using errcode = '22023';
    end;
    insert into public.lead_fields (workspace_id, lead_id, field, value, key, source, source_ref, status, excerpt, seen_at)
    values (v_ws, p_lead, r->>'field', v_value, nullif(r->>'key', ''), r->>'source', nullif(r->>'source_ref', ''),
            coalesce(r->>'status', 'unverified'), nullif(r->>'excerpt', ''), v_seen)
    on conflict do nothing;
    get diagnostics v_i = row_count;
    v_n := v_n + v_i;
  end loop;
  return v_n;
end;
$$;

create or replace function public.qualifier_refute(p_tick uuid, p_lead uuid, p_field_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform public.qualifier_assert(p_tick, p_lead, true);
  if p_field_ids is null or coalesce(array_length(p_field_ids, 1), 0) > 200 then
    raise exception 'at most 200 ids' using errcode = '22023';
  end if;
  update public.lead_fields f set status = 'refuted' where f.lead_id = p_lead and f.id = any (p_field_ids) and f.status <> 'refuted';
end;
$$;

create or replace function public.qualifier_step_done(p_tick uuid, p_lead uuid, p_step text, p_outcome text, p_next text, p_done_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  v_err boolean := p_outcome = 'error';
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_ws := public.qualifier_assert(p_tick, p_lead, true);
  if p_step is null or p_step <> all (array['p1', 'p2', 'p3', 'p4', 'p5']) then
    raise exception 'invalid step' using errcode = '22023';
  end if;
  if p_outcome is null or char_length(p_outcome) not between 1 and 30 then
    raise exception 'invalid outcome' using errcode = '22023';
  end if;
  if p_next is null or p_next <> all (array['p1', 'p2', 'p3', 'p4', 'p5', 'done']) then
    raise exception 'invalid next step' using errcode = '22023';
  end if;
  if p_next = 'done' and (p_done_reason is null or p_done_reason <> all (array['complete', 'lead_cap', 'dead'])) then
    raise exception 'done needs a reason: complete, lead_cap or dead' using errcode = '22023';
  end if;
  insert into public.qualifier_step_log (workspace_id, lead_id, step, outcome) values (v_ws, p_lead, p_step, p_outcome);
  -- imported values that arrived while the lead was claimed (the re-queue trigger only sees finished leads): do not close
  -- Also a manual request that came in while it was claimed (request_qualification wrote manual_at after the claim): it
  -- keeps manual_at and deep_requested (strictly after the claim: a same-instant tie is not a second request, so it never
  -- causes a second paid pass). A dead lead stays dead.
  if p_next = 'done' and p_done_reason <> 'dead' and exists (
       select 1 from public.qualifier_queue z
        where z.lead_id = p_lead and z.claimed_at is not null
          and (z.manual_at > z.claimed_at
               or exists (select 1 from public.lead_fields f
                           where f.lead_id = p_lead and f.source in ('import', 'apify_maps', 'apollo') and f.created_at >= z.claimed_at))) then
    update public.qualifier_queue q
       set notes = q.notes || jsonb_build_object(p_step, p_outcome), last_step_at = now(), fail_streak = 0, fail_step = null,
           next_step = 'p1', done_reason = null, enqueued_at = now(), locked_by = null, locked_until = null, claimed_at = null
     where q.lead_id = p_lead;
    return;
  end if;
  update public.qualifier_queue q
     set notes = q.notes || jsonb_build_object(p_step, p_outcome),
         last_step_at = now(),
         fail_streak = case when v_err then (case when q.fail_step = p_step then q.fail_streak else 0 end) + 1 else 0 end,
         fail_step = case when v_err then p_step else null end,
         next_step = p_next,
         done_reason = case when p_next = 'done' then p_done_reason else null end,
         locked_by = case when p_next = 'done' then null else q.locked_by end,
         locked_until = case when p_next = 'done' then null else q.locked_until end,
         manual_at = case when p_next = 'done' then null else q.manual_at end,
         deep_requested = case when p_next = 'done' then false else q.deep_requested end
   where q.lead_id = p_lead;
end;
$$;

create or replace function public.qualifier_release(p_tick uuid, p_lead uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform public.qualifier_assert(p_tick, p_lead, true);
  update public.qualifier_queue q set locked_by = null, locked_until = null where q.lead_id = p_lead and q.locked_by = p_tick;
end;
$$;

-- Pause the workspace's Qualificador. The tick must hold a lead of that workspace (call it before releasing); the
-- pause frees this tick's locks there, so the leads go back to the queue unchanged. A user's own pause is not overwritten.
create or replace function public.qualifier_pause(p_tick uuid, p_ws uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from public.qualifier_ticks t where t.id = p_tick and t.finished_at is null and t.lease_until > now()) then
    raise exception 'tick is not open' using errcode = '55000';
  end if;
  if p_reason is null or p_reason <> all (array['daily_cap', 'workspace_cap', 'user_cap', 'global_cap', 'no_access']) then
    raise exception 'invalid pause reason' using errcode = '22023';
  end if;
  if not exists (select 1 from public.qualifier_queue q where q.workspace_id = p_ws and q.locked_by = p_tick and q.locked_until > now()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.qualifiers z
     set status = 'paused', paused_reason = p_reason,
         paused_until = case when p_reason = 'daily_cap'
                             then (date_trunc('day', now() at time zone 'America/New_York') + interval '1 day') at time zone 'America/New_York'
                        end
   where z.workspace_id = p_ws and z.status = 'on';
  update public.qualifier_queue q set locked_by = null, locked_until = null where q.workspace_id = p_ws and q.locked_by = p_tick;
end;
$$;

-- ---------------------------------------------------------------- AI on the Qualificador path
-- Charged to the workspace creator (qualifiers.charge_user_id). Order: the Qualificador's own day, the lead cap, then the
-- shared caps (workspace, user, global) in reserve_ai_call_core. The row carries lead_id.
create or replace function public.qualifier_reserve_ai_call(
  p_tick uuid,
  p_lead uuid,
  p_task text,
  p_model text,
  p_prompt_version text,
  p_reserve_usd numeric,
  p_user_cap_usd numeric,
  p_global_cap_usd numeric
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  q public.qualifiers;
  v_lead_spent numeric;
  v_id uuid;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_ws := public.qualifier_assert(p_tick, p_lead, true);
  if p_task is null or left(p_task, 8) <> 'qualify_' then
    raise exception 'not a qualifier task' using errcode = '22023';
  end if;
  select * into q from public.qualifiers z where z.workspace_id = v_ws;
  if not found or q.status <> 'on' then
    raise exception 'qualifier is not on' using errcode = '55000';
  end if;
  if p_reserve_usd is null or p_reserve_usd <= 0 then
    raise exception 'invalid reserve' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('public.reserve_ai_call'));
  if public.qualifier_spent_today(v_ws) + p_reserve_usd > q.daily_cap_usd then
    raise exception 'ai_cap:qualifier_daily' using errcode = 'P0001';
  end if;
  select qq.spent_usd + coalesce((select sum(greatest(c.reserve_usd - c.cost_usd, 0)) from public.ai_calls c
                                   where c.lead_id = p_lead and c.status = 'pending'), 0)
    into v_lead_spent from public.qualifier_queue qq where qq.lead_id = p_lead;
  if v_lead_spent + p_reserve_usd > q.lead_cap_usd then
    raise exception 'ai_cap:lead_cap' using errcode = 'P0001';
  end if;
  -- the creator must still be owner or sdr of the workspace; otherwise nothing is reserved
  if q.charge_user_id is null or not exists (
       select 1 from public.workspace_members m where m.workspace_id = v_ws and m.user_id = q.charge_user_id and m.role in ('owner', 'sdr')) then
    raise exception 'ai_cap:no_access' using errcode = '42501';
  end if;
  v_id := public.reserve_ai_call_core(q.charge_user_id, v_ws, null, p_task, p_model, p_prompt_version, p_reserve_usd, p_user_cap_usd, p_global_cap_usd);
  update public.ai_calls c set lead_id = p_lead where c.id = v_id;
  return v_id;
end;
$$;

-- Settling needs no live lock: a call in flight when the lock expired still records its cost. The row must be this
-- lead's pending Qualificador row.
create or replace function public.qualifier_settle_ai_call(
  p_tick uuid,
  p_lead uuid,
  p_id uuid,
  p_status text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_cache_read_tokens integer,
  p_cache_write_tokens integer,
  p_web_searches integer,
  p_web_fetches integer,
  p_cost_usd numeric,
  p_error text,
  p_duration_ms integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  v_uid uuid;
begin
  if not public.scheduler_authorized() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  v_ws := public.qualifier_assert(p_tick, p_lead, false);
  select c.user_id into v_uid
    from public.ai_calls c
   where c.id = p_id and c.lead_id = p_lead and c.workspace_id = v_ws and c.status = 'pending' and left(c.task, 8) = 'qualify_';
  if v_uid is null then
    raise exception 'ai call is not a pending call of this lead' using errcode = '42501';
  end if;
  perform public.settle_ai_call_core(v_uid, p_id, p_status, p_input_tokens, p_output_tokens, p_cache_read_tokens,
                                     p_cache_write_tokens, p_web_searches, p_web_fetches, p_cost_usd, p_error, p_duration_ms);
end;
$$;

-- ---------------------------------------------------------------- session: "qualificar agora"
create or replace function public.request_qualification(p_ws uuid, p_leads uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if auth.uid() is null or p_ws is null or not public.is_workspace_sender(p_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_leads is null or coalesce(array_length(p_leads, 1), 0) > 500 then
    raise exception 'at most 500 leads per request' using errcode = '22023';
  end if;
  update public.qualifier_queue q
     set manual_at = now(), deep_requested = true, next_step = 'p1', done_reason = null, fail_step = null, fail_streak = 0
   where q.workspace_id = p_ws and q.lead_id = any (p_leads)
     and not (q.next_step = 'done' and q.done_reason = 'dead');
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------- owner: take over the charge
-- The Qualificador's AI is charged to qualifiers.charge_user_id. When that account lost access (paused: no_access), the
-- owner makes it their own and the Qualificador resumes. Any other pause reason is left as it is.
create or replace function public.take_over_qualifier_charge(p_ws uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_ws is null or not public.is_workspace_owner(p_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.qualifiers z
     set charge_user_id = auth.uid(),
         status = case when z.paused_reason = 'no_access' then 'on' else z.status end,
         paused_reason = case when z.paused_reason = 'no_access' then null else z.paused_reason end,
         paused_until = case when z.paused_reason = 'no_access' then null else z.paused_until end
   where z.workspace_id = p_ws;
end;
$$;

-- ---------------------------------------------------------------- grants (part 2)
revoke all on function public.qualifier_assert(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.qualifier_begin_tick() from public, anon, authenticated;
revoke all on function public.qualifier_finish_tick(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.qualifier_claim_next(uuid) from public, anon, authenticated;
revoke all on function public.qualifier_merge(uuid, uuid) from public, anon, authenticated;
revoke all on function public.qualifier_add_fields(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.qualifier_refute(uuid, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.qualifier_step_done(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.qualifier_release(uuid, uuid) from public, anon, authenticated;
revoke all on function public.qualifier_pause(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.qualifier_reserve_ai_call(uuid, uuid, text, text, text, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function public.qualifier_settle_ai_call(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer, numeric, text, integer) from public, anon, authenticated;
revoke all on function public.request_qualification(uuid, uuid[]) from public, anon;
revoke all on function public.take_over_qualifier_charge(uuid) from public, anon;
grant execute on function public.qualifier_begin_tick() to anon;
grant execute on function public.qualifier_finish_tick(uuid, jsonb, text) to anon;
grant execute on function public.qualifier_claim_next(uuid) to anon;
grant execute on function public.qualifier_merge(uuid, uuid) to anon;
grant execute on function public.qualifier_add_fields(uuid, uuid, jsonb) to anon;
grant execute on function public.qualifier_refute(uuid, uuid, uuid[]) to anon;
grant execute on function public.qualifier_step_done(uuid, uuid, text, text, text, text) to anon;
grant execute on function public.qualifier_release(uuid, uuid) to anon;
grant execute on function public.qualifier_pause(uuid, uuid, text) to anon;
grant execute on function public.qualifier_reserve_ai_call(uuid, uuid, text, text, text, numeric, numeric, numeric) to anon;
grant execute on function public.qualifier_settle_ai_call(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer, numeric, text, integer) to anon;
grant execute on function public.request_qualification(uuid, uuid[]) to authenticated;
grant execute on function public.take_over_qualifier_charge(uuid) to authenticated;
