-- 0019 Qualificador re-queue without the clock (fix round 2026-11-15).
--   Bug 1: qualifier_step_done re-opened a claimed lead when an imported value had created_at >= claimed_at. Both are
--          now() of their own transactions, so a value inserted BEFORE the claim but with the same timestamp (coarse
--          clock) counted as new, and the lead was claimed again in the same tick. The reverse also held: a value whose
--          transaction began before the claim but committed after it had created_at < claimed_at and was never seen.
--   Bug 2: that re-open kept deep_requested and manual_at, so a manual deep request paid for qualify_deep again every
--          time an imported / Maps / Apollo / contact value landed during the claim.
--   Fix:   two marks on the queue row, ordered by its row lock instead of the clock. qualifier_claim_next clears them
--          (it holds the row lock; a concurrent writer waits or is skipped), the import trigger sets data_since_claim,
--          request_qualification sets request_since_claim. step_done re-opens on either; only a request keeps the deep step.
--   Bug 3: an apify_contact e-mail (the P2b contact scraper's answer, usually after the lead is done) re-queued at p1, so
--          P2 re-read the site and P4 paid the light AI again. A contact e-mail alone now resumes at p5 (no pages
--          needed; the deep step, when eligible, sees the new e-mail). Any other imported value still resumes at p1:
--          import_since_claim marks that kind during a claim.
--   Redefines (verbatim copies plus the marked changes): qualifier_claim_next (0014), request_qualification (0014),
--   requeue_lead_on_import (0016), qualifier_step_done (0016). Same signatures and grants; no new function.
-- Depends on 0001-0016. Re-runnable.

alter table public.qualifier_queue add column if not exists data_since_claim boolean not null default false;
alter table public.qualifier_queue add column if not exists request_since_claim boolean not null default false;
alter table public.qualifier_queue add column if not exists import_since_claim boolean not null default false;

-- ---------------------------------------------------------------- claim: clears both marks
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
  update public.qualifier_queue q set locked_by = p_tick, locked_until = (select t.lease_until from public.qualifier_ticks t where t.id = p_tick), claimed_at = now(),
         data_since_claim = false, request_since_claim = false, import_since_claim = false where q.lead_id = v_lead;

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

-- ---------------------------------------------------------------- import trigger: sets data_since_claim
create or replace function public.requeue_lead_on_import()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.qualifier_queue q
     set next_step = case when new.source = 'apify_contact' then 'p5' else 'p1' end, -- 0019: a contact e-mail skips P2-P4
         done_reason = null, fail_step = null, fail_streak = 0,
         enqueued_at = now(), locked_by = null, locked_until = null
   where q.lead_id = new.lead_id and q.next_step = 'done' and q.done_reason is distinct from 'dead';
  -- whatever the lead's state: a claim that is open now did not see this value (the claim resets the marks)
  update public.qualifier_queue q
     set data_since_claim = true, import_since_claim = q.import_since_claim or new.source <> 'apify_contact'
   where q.lead_id = new.lead_id;
  return null;
end;
$$;

-- ---------------------------------------------------------------- manual request: sets request_since_claim
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
     set manual_at = now(), deep_requested = true, next_step = 'p1', done_reason = null, fail_step = null, fail_streak = 0,
         request_since_claim = true
   where q.workspace_id = p_ws and q.lead_id = any (p_leads);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------- step done: re-open on the marks, deep only for a request
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
  if p_step is null or p_step <> all (array['p1', 'p2', 'p2b', 'p3', 'p4', 'p5']) then
    raise exception 'invalid step' using errcode = '22023';
  end if;
  if p_outcome is null or char_length(p_outcome) not between 1 and 30 then
    raise exception 'invalid outcome' using errcode = '22023';
  end if;
  if p_next is null or p_next <> all (array['p1', 'p2', 'p2b', 'p3', 'p4', 'p5', 'done']) then
    raise exception 'invalid next step' using errcode = '22023';
  end if;
  if p_next = 'done' and (p_done_reason is null or p_done_reason <> all (array['complete', 'lead_cap', 'dead'])) then
    raise exception 'done needs a reason: complete, lead_cap or dead' using errcode = '22023';
  end if;
  insert into public.qualifier_step_log (workspace_id, lead_id, step, outcome) values (v_ws, p_lead, p_step, p_outcome);
  -- 0019: imported values that arrived while the lead was claimed (the re-queue trigger only sees finished leads) re-open
  -- it for the free steps, and so does a manual request made while it was claimed. "While claimed" is the marks the
  -- claim cleared and the import trigger / request_qualification set afterwards, never a timestamp comparison. Only a
  -- request made during the claim keeps manual_at and deep_requested: data alone never pays for the deep step again
  -- (the profile's auto deep step still applies, as for a finished lead re-queued by an import). Only contact e-mails
  -- (apify_contact) during the claim resume at p5, so P4 is not paid again; anything else resumes at p1. A dead lead stays dead.
  if p_next = 'done' and p_done_reason <> 'dead' and exists (
       select 1 from public.qualifier_queue z
        where z.lead_id = p_lead and z.claimed_at is not null and (z.data_since_claim or z.request_since_claim)) then
    update public.qualifier_queue q
       set notes = q.notes || jsonb_build_object(p_step, p_outcome), last_step_at = now(), fail_streak = 0, fail_step = null,
           next_step = case when q.import_since_claim or q.request_since_claim then 'p1' else 'p5' end,
           done_reason = null, enqueued_at = now(), locked_by = null, locked_until = null, claimed_at = null,
           manual_at = case when q.request_since_claim then q.manual_at else null end,
           deep_requested = q.request_since_claim and q.deep_requested
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

-- ---------------------------------------------------------------- privileges (as in 0014 / 0016)
revoke all on function public.qualifier_claim_next(uuid) from public, authenticated;
revoke all on function public.requeue_lead_on_import() from public, anon, authenticated;
revoke all on function public.request_qualification(uuid, uuid[]) from public, anon;
revoke all on function public.qualifier_step_done(uuid, uuid, text, text, text, text) from public, authenticated;
grant execute on function public.qualifier_claim_next(uuid) to anon;
grant execute on function public.request_qualification(uuid, uuid[]) to authenticated;
grant execute on function public.qualifier_step_done(uuid, uuid, text, text, text, text) to anon;
