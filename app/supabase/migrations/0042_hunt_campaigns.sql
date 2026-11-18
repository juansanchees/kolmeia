-- 0042 Campaigns of the Caçador: a saved conversation, rounds with a stop reason and a summary, instructions that re-score
-- the campaign's stored opportunities, and lasting preferences per (workspace, offer) that apply only after approval.
--   hunt_campaigns / hunt_rounds / hunt_messages / offer_preferences   members read (closer too); writes only through the
--                                                                       functions below, owner/sdr after a membership check
--   lead_opportunities + campaign_id, facts, round_seen, previous_priority
--   kb_upsert_opportunities                 copied from 0041 with `campaign_id` and `facts` accepted and stored, nothing else
--                                           (kb_deliver passes each opportunity object through unchanged, so it needs no change)
--   hunt_campaign_create / hunt_message_add / hunt_campaign_apply / hunt_round_finish
--   offer_preference_propose / offer_preference_decide
-- Scoring is TypeScript (src/lib/hunt): SQL stores what it gets. Depends on 0001, 0003, 0008, 0041. Re-runnable.
begin;

-- ---------------------------------------------------------------- helpers (NOT definer)
-- CampaignParams (src/lib/offers/types.ts): known keys only, right types, the five building kinds, no kind both preferred
-- and deprioritized (mergeParams in src/lib/hunt/rescore.ts resolves that before anything is stored).
create or replace function public.hunt_params_ok(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text;
begin
  if p is null or jsonb_typeof(p) <> 'object' or octet_length(p::text) > 2000 then
    return false;
  end if;
  for k in select jsonb_object_keys(p) loop
    if k in ('preferKinds', 'deprioritizeKinds') then
      if jsonb_typeof(p -> k) <> 'array' or jsonb_array_length(p -> k) > 5
         or exists (select 1 from jsonb_array_elements(p -> k) e
                     where jsonb_typeof(e) <> 'string' or (e #>> '{}') <> all (array['single_family', 'adu', 'multifamily', 'commercial', 'other'])) then
        return false;
      end if;
    elsif k = 'minValueUsd' then
      if jsonb_typeof(p -> k) <> 'number' or (p ->> k)::numeric < 0 or (p ->> k)::numeric > 1e10 then
        return false;
      end if;
    elsif k = 'maxAgeDays' then
      if jsonb_typeof(p -> k) <> 'number' or (p ->> k)::numeric < 1 or (p ->> k)::numeric > 3650 then
        return false;
      end if;
    elsif k = 'wantBidPath' then
      if jsonb_typeof(p -> k) <> 'boolean' then
        return false;
      end if;
    else
      return false;
    end if;
  end loop;
  if p ? 'preferKinds' and p ? 'deprioritizeKinds'
     and exists (select 1 from jsonb_array_elements_text(p -> 'preferKinds') a join jsonb_array_elements_text(p -> 'deprioritizeKinds') b on a = b) then
    return false;
  end if;
  return true;
end;
$$;

-- Owner or SDR of the workspace (is_workspace_sender, 0003); a closer or a stranger gets 42501.
create or replace function public.hunt_assert_writer(p_ws uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if auth.uid() is null or p_ws is null or not public.is_workspace_sender(p_ws) then
    raise exception 'owner or sdr of the workspace only' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------- tables
create table if not exists public.hunt_campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete set null,
  offer text not null check (char_length(offer) between 1 and 60),
  region text check (char_length(region) <= 200),
  request text check (char_length(request) <= 1000),
  params jsonb not null default '{}'::jsonb check (public.hunt_params_ok(params)),
  status text not null default 'active' check (status in ('active', 'paused', 'done')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists hunt_campaigns_ws_idx on public.hunt_campaigns (workspace_id, updated_at desc);

create table if not exists public.hunt_rounds (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.hunt_campaigns (id) on delete cascade,
  n int not null check (n >= 1),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  stop_reason text check (stop_reason in ('fulfilled', 'limit', 'exhausted', 'waiting')),
  request_snapshot text check (char_length(request_snapshot) <= 1000),
  params_snapshot jsonb not null default '{}'::jsonb,
  -- {new, updated, demoted, sources:[{source,town,outcome,reason}], blockers:[code], asks:[code]} (src/lib/hunt/rounds.ts)
  summary jsonb,
  unique (campaign_id, n)
);

create table if not exists public.hunt_messages (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.hunt_campaigns (id) on delete cascade,
  round_id uuid references public.hunt_rounds (id) on delete set null,
  role text not null check (role in ('user', 'agent')),
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index if not exists hunt_messages_campaign_idx on public.hunt_messages (campaign_id, created_at);

create table if not exists public.offer_preferences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  offer text not null check (char_length(offer) between 1 and 60),
  rule jsonb not null check (public.hunt_params_ok(rule) and rule <> '{}'::jsonb),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'undone')),
  example_lead_ids uuid[] not null default '{}' check (cardinality(example_lead_ids) <= 20),
  expected_effect jsonb not null default '{"up": 0, "down": 0}'::jsonb,
  proposed_at timestamptz not null default now(),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz
);
create index if not exists offer_preferences_scope_idx on public.offer_preferences (workspace_id, offer, status);

alter table public.lead_opportunities add column if not exists campaign_id uuid references public.hunt_campaigns (id) on delete set null;
alter table public.lead_opportunities add column if not exists facts jsonb;
alter table public.lead_opportunities add column if not exists round_seen int;
alter table public.lead_opportunities add column if not exists previous_priority int check (previous_priority between 0 and 100);
create index if not exists lead_opportunities_campaign_idx on public.lead_opportunities (campaign_id);

-- ---------------------------------------------------------------- RLS: members read, nobody writes directly
alter table public.hunt_campaigns enable row level security;
alter table public.hunt_rounds enable row level security;
alter table public.hunt_messages enable row level security;
alter table public.offer_preferences enable row level security;
revoke all on public.hunt_campaigns, public.hunt_rounds, public.hunt_messages, public.offer_preferences from public, anon, authenticated;
grant select on public.hunt_campaigns, public.hunt_rounds, public.hunt_messages, public.offer_preferences to authenticated;

drop policy if exists hunt_campaigns_select on public.hunt_campaigns;
create policy hunt_campaigns_select on public.hunt_campaigns
  for select to authenticated using (public.is_workspace_member(workspace_id));
-- rounds and messages: the subquery runs under hunt_campaigns_select
drop policy if exists hunt_rounds_select on public.hunt_rounds;
create policy hunt_rounds_select on public.hunt_rounds
  for select to authenticated using (exists (select 1 from public.hunt_campaigns c where c.id = campaign_id));
drop policy if exists hunt_messages_select on public.hunt_messages;
create policy hunt_messages_select on public.hunt_messages
  for select to authenticated using (exists (select 1 from public.hunt_campaigns c where c.id = campaign_id));
drop policy if exists offer_preferences_select on public.offer_preferences;
create policy offer_preferences_select on public.offer_preferences
  for select to authenticated using (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------- kb_upsert_opportunities (0041 + campaign_id, facts)
create or replace function public.kb_upsert_opportunities(p_ws uuid, p_lead uuid, p_opps jsonb, p_import uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  o jsonb;
  v_keys text[];
  v_campaign uuid;
  v_facts jsonb;
begin
  if p_opps is null or jsonb_typeof(p_opps) = 'null' then
    return;
  end if;
  if jsonb_typeof(p_opps) <> 'array' or jsonb_array_length(p_opps) > 20 then
    raise exception 'invalid opportunities' using errcode = '22023';
  end if;
  for o in select e.value from jsonb_array_elements(p_opps) e loop
    select array_agg(k) into v_keys from jsonb_object_keys(o) k
     where k <> all (array['kb_signal_id', 'offer', 'title', 'signal_date', 'source', 'source_url', 'priority', 'priority_codes',
                           'hook_en', 'checks', 'open_questions', 'contact_path', 'contact_value', 'campaign_id', 'facts']);
    if jsonb_typeof(o) <> 'object' or v_keys is not null or nullif(o ->> 'offer', '') is null then
      raise exception 'invalid opportunity' using errcode = '22023';
    end if;
    v_campaign := (o ->> 'campaign_id')::uuid;
    if v_campaign is not null and not exists (select 1 from public.hunt_campaigns c where c.id = v_campaign and c.workspace_id = p_ws) then
      raise exception 'campaign does not belong to this workspace' using errcode = '22023';
    end if;
    v_facts := nullif(o -> 'facts', 'null'::jsonb);
    if v_facts is not null and (jsonb_typeof(v_facts) <> 'object' or octet_length(v_facts::text) > 16000) then
      raise exception 'invalid opportunity' using errcode = '22023';
    end if;
    insert into public.lead_opportunities (workspace_id, lead_id, import_id, kb_signal_id, offer, title, signal_date, source, source_url, priority,
                                           priority_codes, hook_en, checks, open_questions, contact_path, contact_value, campaign_id, facts)
    values (p_ws, p_lead, p_import, (o ->> 'kb_signal_id')::uuid, o ->> 'offer', o ->> 'title', (o ->> 'signal_date')::date, o ->> 'source',
            o ->> 'source_url', coalesce((o ->> 'priority')::int, 0),
            coalesce(array(select jsonb_array_elements_text(o -> 'priority_codes')), '{}'),
            o ->> 'hook_en', coalesce(o -> 'checks', '{}'::jsonb),
            coalesce(array(select jsonb_array_elements_text(o -> 'open_questions')), '{}'),
            coalesce(o ->> 'contact_path', 'none'), o ->> 'contact_value', v_campaign, v_facts)
    on conflict (workspace_id, lead_id, offer, kb_signal_id) do update
      set title = excluded.title, signal_date = excluded.signal_date, source = excluded.source, source_url = excluded.source_url,
          priority = excluded.priority, priority_codes = excluded.priority_codes, hook_en = excluded.hook_en, checks = excluded.checks,
          open_questions = excluded.open_questions, contact_path = excluded.contact_path, contact_value = excluded.contact_value,
          campaign_id = coalesce(excluded.campaign_id, public.lead_opportunities.campaign_id),
          facts = coalesce(excluded.facts, public.lead_opportunities.facts),
          updated_at = now()
      -- a row owned by a campaign is re-scored only by that campaign: another campaign of the same offer leaves it alone
      where public.lead_opportunities.campaign_id is null or public.lead_opportunities.campaign_id = excluded.campaign_id;
  end loop;
end;
$$;

-- ---------------------------------------------------------------- campaigns, messages, rounds
create or replace function public.hunt_campaign_create(p_ws uuid, p_offer text, p_region text, p_request text, p_params jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_round uuid;
  v_request text := nullif(btrim(p_request), '');
  v_params jsonb := coalesce(p_params, '{}'::jsonb);
begin
  perform public.hunt_assert_writer(p_ws);
  if p_offer is null or p_offer !~ '^[a-z][a-z0-9_]{0,59}$' or char_length(v_request) > 1000 or char_length(btrim(p_region)) > 200 then
    raise exception 'invalid campaign' using errcode = '22023';
  end if;
  if not public.hunt_params_ok(v_params) then
    raise exception 'invalid params' using errcode = '22023';
  end if;
  insert into public.hunt_campaigns (workspace_id, offer, region, request, params, created_by)
  values (p_ws, p_offer, nullif(btrim(p_region), ''), v_request, v_params, auth.uid())
  returning id into v_id;
  insert into public.hunt_rounds (campaign_id, n, request_snapshot, params_snapshot)
  values (v_id, 1, v_request, v_params)
  returning id into v_round;
  if v_request is not null then
    insert into public.hunt_messages (campaign_id, round_id, role, body) values (v_id, v_round, 'user', v_request);
  end if;
  return v_id;
end;
$$;

create or replace function public.hunt_message_add(p_campaign uuid, p_role text, p_body text, p_round uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform public.hunt_assert_writer((select c.workspace_id from public.hunt_campaigns c where c.id = p_campaign));
  if p_role is null or p_role not in ('user', 'agent') or char_length(btrim(p_body)) not between 1 and 4000
     or (p_round is not null and not exists (select 1 from public.hunt_rounds r where r.id = p_round and r.campaign_id = p_campaign)) then
    raise exception 'invalid message' using errcode = '22023';
  end if;
  insert into public.hunt_messages (campaign_id, round_id, role, body) values (p_campaign, p_round, p_role, btrim(p_body)) returning id into v_id;
  update public.hunt_campaigns set updated_at = now() where id = p_campaign;
  return v_id;
end;
$$;

-- An instruction: store the campaign's full params as sent (the app merges with mergeParams first; a JSON null drops a
-- key; p_params null keeps the current ones), close the open round, start round n+1, save the message.
-- The app then re-scores this campaign's opportunities from `facts` and writes them back with hunt_round_finish.
create or replace function public.hunt_campaign_apply(p_campaign uuid, p_params jsonb, p_message text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c public.hunt_campaigns;
  v_params jsonb;
  v_n int;
  v_round uuid;
  v_msg text := nullif(btrim(p_message), '');
begin
  select * into v_c from public.hunt_campaigns c where c.id = p_campaign for update;
  perform public.hunt_assert_writer(v_c.workspace_id);
  if p_params is not null and jsonb_typeof(p_params) <> 'object' then
    raise exception 'invalid params' using errcode = '22023';
  end if;
  v_params := jsonb_strip_nulls(coalesce(p_params, v_c.params));
  if not public.hunt_params_ok(v_params) or char_length(v_msg) > 4000 then
    raise exception 'invalid params' using errcode = '22023';
  end if;
  update public.hunt_rounds set ended_at = now() where campaign_id = p_campaign and ended_at is null;
  select coalesce(max(r.n), 0) + 1 into v_n from public.hunt_rounds r where r.campaign_id = p_campaign;
  insert into public.hunt_rounds (campaign_id, n, request_snapshot, params_snapshot)
  values (p_campaign, v_n, v_c.request, v_params)
  returning id into v_round;
  if v_msg is not null then
    insert into public.hunt_messages (campaign_id, round_id, role, body) values (p_campaign, v_round, 'user', v_msg);
  end if;
  update public.hunt_campaigns set params = v_params, status = 'active', updated_at = now() where id = p_campaign;
  return jsonb_build_object('round_id', v_round, 'n', v_n);
end;
$$;

-- p_scores = [{opportunity_id, priority, priority_codes, open_questions}] computed in TS. Only this campaign's opportunities
-- change (previous_priority = the old priority, round_seen = n); anything else in p_scores is ignored. Returns rows updated.
create or replace function public.hunt_round_finish(p_round uuid, p_scores jsonb, p_summary jsonb, p_stop_reason text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_r public.hunt_rounds;
  v_ws uuid;
  v_n int;
begin
  select * into v_r from public.hunt_rounds r where r.id = p_round for update;
  select c.workspace_id into v_ws from public.hunt_campaigns c where c.id = v_r.campaign_id;
  perform public.hunt_assert_writer(v_ws);
  if v_r.ended_at is not null then
    raise exception 'round already finished' using errcode = '22023';
  end if;
  if p_stop_reason is null or p_stop_reason not in ('fulfilled', 'limit', 'exhausted', 'waiting')
     or p_summary is null or jsonb_typeof(p_summary) <> 'object' or octet_length(p_summary::text) > 16000
     or (p_scores is not null and (jsonb_typeof(p_scores) <> 'array' or jsonb_array_length(p_scores) > 2000)) then
    raise exception 'invalid round result' using errcode = '22023';
  end if;
  update public.lead_opportunities o
     set previous_priority = o.priority,
         priority = s.priority,
         priority_codes = coalesce(s.priority_codes, '{}'),
         open_questions = coalesce(s.open_questions, '{}'),
         round_seen = v_r.n,
         updated_at = now()
    from jsonb_to_recordset(coalesce(p_scores, '[]'::jsonb)) as s(opportunity_id uuid, priority int, priority_codes text[], open_questions text[])
   where o.id = s.opportunity_id and o.campaign_id = v_r.campaign_id and o.workspace_id = v_ws;
  get diagnostics v_n = row_count;
  update public.hunt_rounds set ended_at = now(), stop_reason = p_stop_reason, summary = p_summary where id = p_round;
  update public.hunt_campaigns set updated_at = now() where id = v_r.campaign_id;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------- lasting preferences (never applied before approval)
-- The same rule already proposed, approved or declined/undone for (workspace, offer) returns that row (a declined rule is not proposed again) instead of a duplicate.
create or replace function public.offer_preference_propose(p_ws uuid, p_offer text, p_rule jsonb, p_example_lead_ids uuid[], p_expected_effect jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_ids uuid[] := array(select distinct x from unnest(coalesce(p_example_lead_ids, '{}')) x where x is not null);
  v_eff jsonb := coalesce(p_expected_effect, '{"up": 0, "down": 0}'::jsonb);
begin
  perform public.hunt_assert_writer(p_ws);
  if p_offer is null or p_offer !~ '^[a-z][a-z0-9_]{0,59}$' or not public.hunt_params_ok(p_rule) or p_rule = '{}'::jsonb
     or cardinality(v_ids) > 20
     or (select count(*) from public.leads l where l.id = any (v_ids) and l.workspace_id = p_ws) <> cardinality(v_ids)
     or jsonb_typeof(v_eff) <> 'object' or exists (select 1 from jsonb_object_keys(v_eff) k where k not in ('up', 'down'))
     or jsonb_typeof(v_eff -> 'up') is distinct from 'number' or jsonb_typeof(v_eff -> 'down') is distinct from 'number' then
    raise exception 'invalid preference' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('offer_pref:' || p_ws::text || ':' || p_offer));
  select p.id into v_id from public.offer_preferences p
   where p.workspace_id = p_ws and p.offer = p_offer and p.rule = p_rule and p.status in ('proposed', 'approved', 'undone')
   order by p.proposed_at limit 1;
  if v_id is null then
    insert into public.offer_preferences (workspace_id, offer, rule, example_lead_ids, expected_effect)
    values (p_ws, p_offer, p_rule, v_ids, v_eff)
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

-- proposed -> approved; proposed or approved -> undone (the row stays as history).
create or replace function public.offer_preference_decide(p_pref uuid, p_decision text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_p public.offer_preferences;
begin
  select * into v_p from public.offer_preferences p where p.id = p_pref for update;
  perform public.hunt_assert_writer(v_p.workspace_id);
  if not ((p_decision = 'approved' and v_p.status = 'proposed') or (p_decision = 'undone' and v_p.status in ('proposed', 'approved'))) then
    raise exception 'invalid decision' using errcode = '22023';
  end if;
  update public.offer_preferences set status = p_decision, decided_by = auth.uid(), decided_at = now() where id = p_pref;
end;
$$;

revoke all on function public.hunt_params_ok(jsonb) from public, anon;
revoke all on function public.hunt_assert_writer(uuid) from public, anon, authenticated;
revoke all on function public.hunt_campaign_create(uuid, text, text, text, jsonb), public.hunt_message_add(uuid, text, text, uuid),
  public.hunt_campaign_apply(uuid, jsonb, text), public.hunt_round_finish(uuid, jsonb, jsonb, text),
  public.offer_preference_propose(uuid, text, jsonb, uuid[], jsonb), public.offer_preference_decide(uuid, text) from public, anon;
grant execute on function public.hunt_campaign_create(uuid, text, text, text, jsonb), public.hunt_message_add(uuid, text, text, uuid),
  public.hunt_campaign_apply(uuid, jsonb, text), public.hunt_round_finish(uuid, jsonb, jsonb, text),
  public.offer_preference_propose(uuid, text, jsonb, uuid[], jsonb), public.offer_preference_decide(uuid, text) to authenticated;

-- ---------------------------------------------------------------- coverage by town and source (read-only, for the members)
-- Operator rows (kb_jobs with no workspace) plus this workspace's own; only rows that recorded an outcome. kb_jobs stays closed.
-- Only the latest run per (town, source): a re-run replaces the last result instead of adding to it.
create or replace function public.kb_coverage(p_ws uuid)
returns table (town text, source text, ran_at timestamptz, outcome text, queried int, rows_in int, reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_workspace_member(p_ws) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  return query
    select l.city, l.source, l.ran_at, l.outcome, l.queried, l.rows_in, l.reason
      from (select distinct on (lower(j.city), j.source)
                   j.city, j.source, coalesce(j.finished_at, j.created_at) as ran_at, j.outcome, coalesce(j.queried, 0) as queried,
                   coalesce(j.rows_in, 0) as rows_in, j.reason
              from public.kb_jobs j
             where j.outcome is not null and j.city is not null and j.source is not null
               and (j.workspace_id is null or j.workspace_id = p_ws)
             order by lower(j.city), j.source, coalesce(j.finished_at, j.created_at) desc, j.created_at desc, j.id) l
     order by l.ran_at desc
     limit 2000;
end;
$$;
revoke all on function public.kb_coverage(uuid) from public, anon;
grant execute on function public.kb_coverage(uuid) to authenticated;

commit;
