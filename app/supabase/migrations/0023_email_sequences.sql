-- 0023 Versioned e-mail sequences (F4 Tasks 4-5).
-- Part 1 (Task 4):
--   * email_campaigns.agent_id: the E-mail agent that owns the campaign (one campaign per agent). Not client-writable.
--   * email_sequences: every edit is a new version (draft); at most one approved version per campaign. Read by owner/sdr;
--     written only by the definer functions.
--   * ONE renderer (D2): render_email_template() fills {{first_name}}, {{company}}, {{city}} in one pass; any other
--     "{{" / "}}" is 22023. The TS renderTemplate (editor preview) is pinned to it by tests/fixtures/template-vectors.ts.
--   * save_sequence_draft(): owner/sdr save a new version (R4, R12, body <= 2000, known placeholders); the previous versions
--     are superseded and the campaign's unsent sequence messages are cancelled (R1: approvals dropped and logged).
--   * preview_sequence(): the same 3 real leads every time, their rendered steps and a sha256 digest of what was shown
--     (rendered examples, tone, delays) for J1.
--     A lead whose own values would add a link (or break R4/sizes) is skipped, never shown or queued.
-- Depends on 0001-0022. Re-runnable.

-- ---------------------------------------------------------------- campaign <- agent
alter table public.email_campaigns add column if not exists agent_id uuid;
alter table public.email_campaigns drop constraint if exists email_campaigns_agent_fkey;
alter table public.email_campaigns
  add constraint email_campaigns_agent_fkey foreign key (agent_id) references public.agents (id) on delete set null;
create unique index if not exists email_campaigns_agent_key on public.email_campaigns (agent_id) where agent_id is not null;

-- ---------------------------------------------------------------- sequences
create table if not exists public.email_sequences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  campaign_id uuid not null references public.email_campaigns (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete set null,
  version integer not null constraint email_sequences_version check (version >= 1),
  status text not null default 'draft' constraint email_sequences_status check (status in ('draft', 'approved', 'superseded')),
  tone text not null constraint email_sequences_tone check (tone in ('direct', 'friendly', 'consultive')),
  steps jsonb not null constraint email_sequences_steps check (
    jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 3
  ),
  step2_delay_days integer constraint email_sequences_step2 check (step2_delay_days between 1 and 30),
  step3_delay_days integer constraint email_sequences_step3 check (step3_delay_days between 2 and 60),
  ai_model text constraint email_sequences_ai_model_len check (char_length(ai_model) <= 60),
  prompt_version text constraint email_sequences_prompt_version_len check (char_length(prompt_version) <= 40),
  human_edited boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  -- J1 stamp. No FK on purpose: an audit value that must survive the user's deletion.
  approved_by uuid,
  approved_at timestamptz,
  approved_digest text,
  example_prospect_ids uuid[],
  constraint email_sequences_version_key unique (campaign_id, version),
  constraint email_sequences_approved_stamp check (status <> 'approved' or (approved_by is not null and approved_at is not null))
);
create unique index if not exists email_sequences_one_approved on public.email_sequences (campaign_id) where status = 'approved';
create index if not exists email_sequences_workspace_idx on public.email_sequences (workspace_id, created_at desc);

revoke all on table public.email_sequences from public, anon, authenticated;
grant select on table public.email_sequences to authenticated;
alter table public.email_sequences enable row level security;
alter table public.email_sequences force row level security;
-- owner/sdr read; nobody writes from a client (only save_sequence_draft and the part 2 functions)
drop policy if exists email_sequences_select on public.email_sequences;
create policy email_sequences_select on public.email_sequences
  for select to authenticated using (public.is_workspace_sender(workspace_id));

-- ---------------------------------------------------------------- the one renderer (D2)
-- JavaScript's trim(): every character of \s (Unicode spaces and line ends) at both ends. Pure; granted because the
-- client-callable renderer uses it.
create or replace function public.js_trim(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(p, '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$', '', 'g');
$$;

-- Whitespace exactly as JavaScript's trim() and \s see it, so SQL and the TS preview agree on the first word.
-- {{first_name}} = first word of contact_name, else "there" (also for a title, an initial or an e-mail: "." or "@");
-- {{company}} = company as given; {{city}} = trimmed city, else "your area". One pass: values are never expanded again.
create or replace function public.render_email_template(p_text text, p_vars jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  ws constant text := '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]';
  v_parts text[];
  v_names text[];
  v_name text;
  v_first text;
  v_city text;
  v_out text;
  i integer;
begin
  if p_text is null then
    return null;
  end if;
  v_parts := regexp_split_to_array(p_text, '\{\{[a-z_]+\}\}');
  v_names := array(select m[1] from regexp_matches(p_text, '\{\{([a-z_]+)\}\}', 'g') as m);
  if array_to_string(v_parts, '') ~ '\{\{|\}\}' or exists (
    select 1 from unnest(v_names) n where n not in ('first_name', 'company', 'city')
  ) then
    raise exception 'unknown placeholder in template' using errcode = '22023';
  end if;

  v_first := (regexp_split_to_array(
    public.js_trim(coalesce(p_vars ->> 'contact_name', '')), ws || '+'))[1];
  if coalesce(v_first, '') = '' or v_first ~ '[@.]' then
    v_first := 'there';
  end if;
  v_city := public.js_trim(coalesce(p_vars ->> 'city', ''));
  if v_city = '' then
    v_city := 'your area';
  end if;

  v_out := v_parts[1];
  for i in 1 .. coalesce(array_length(v_names, 1), 0) loop
    v_name := v_names[i];
    v_out := v_out || case v_name
                        when 'first_name' then v_first
                        when 'company' then coalesce(p_vars ->> 'company', '')
                        else v_city
                      end || v_parts[i + 1];
  end loop;
  return v_out;
end;
$$;

-- The raw values of one prospect: contact name and company from the prospect, city from its lead (non-refuted field).
-- Internal (plain, no grant): called from definer code.
create or replace function public.prospect_template_vars(p_prospect uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
           'contact_name', p.contact_name,
           'company', p.company_name,
           'city', case when p.lead_id is null then null else public.best_lead_field(p.lead_id, 'city') end)
    from public.email_prospects p
   where p.id = p_prospect;
$$;

-- A sequence step that may be saved, shown or queued (R4 subject, R12 no links, subject 1-150, body 1-2000 after a
-- JavaScript trim; same as stepProblems / SEQUENCE_BODY_MAX in template.ts). Internal (plain, no grant).
create or replace function public.email_step_ok(p_subject text, p_body text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_subject is not null and p_body is not null
     and char_length(public.js_trim(p_subject)) between 1 and 150
     and p_subject !~ '[\r\n]'
     and p_subject !~* '^\s*[\[(]?\s*(re|fw|fwd|aw|tr|sv|vs)\s*(\[\d+\])?\s*[:\])]'
     and p_subject !~* '(https?://|www\.)'
     and char_length(public.js_trim(p_body)) between 1 and 2000
     and p_body !~* '(https?://|www\.)';
$$;

-- The steps of a sequence rendered for one prospect, or null when a value of that prospect would break a rule (a value
-- that adds a link: the lead is skipped, never shown or queued). Internal (plain, no grant).
create or replace function public.render_sequence_for(p_steps jsonb, p_prospect uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_vars jsonb := public.prospect_template_vars(p_prospect);
  v_out jsonb := '[]'::jsonb;
  s jsonb;
  v_subject text;
  v_body text;
begin
  for s in select x from jsonb_array_elements(p_steps) x loop
    v_subject := public.render_email_template(s ->> 'subject', v_vars);
    v_body := public.render_email_template(s ->> 'body', v_vars);
    if not public.email_step_ok(v_subject, v_body) then
      return null;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('step', (s ->> 'step')::integer, 'subject', v_subject, 'body', v_body));
  end loop;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------- save a new version
create or replace function public.save_sequence_draft(p_campaign uuid, p_steps jsonb, p_tone text, p_step2 integer, p_step3 integer,
                                                      p_ai_model text, p_prompt_version text, p_human_edited boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record;
  s jsonb;
  i integer := 0;
  v_steps jsonb := '[]'::jsonb;
  v_version integer;
  v_id uuid;
begin
  select * into c from public.email_campaigns where id = p_campaign for update;
  if c.id is null or auth.uid() is null or not public.is_workspace_sender(c.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_tone is null or p_tone not in ('direct', 'friendly', 'consultive') then
    raise exception 'tone must be direct, friendly or consultive' using errcode = '22023';
  end if;
  if p_step2 not between 1 and 30 or p_step3 not between 2 and 60
     or coalesce(p_step3, c.step3_delay_days) <= coalesce(p_step2, c.step2_delay_days) then
    raise exception 'step 2 waits 1-30 days, step 3 waits 2-60 days and after step 2' using errcode = '22023';
  end if;
  if char_length(p_ai_model) > 60 or char_length(p_prompt_version) > 40 then
    raise exception 'ai_model up to 60 and prompt_version up to 40 characters' using errcode = '22023';
  end if;
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) not between 1 and 3 then
    raise exception 'a sequence has 1 to 3 steps' using errcode = '22023';
  end if;
  for s in select x from jsonb_array_elements(p_steps) x loop
    i := i + 1;
    if jsonb_typeof(s) <> 'object' or s -> 'step' is distinct from to_jsonb(i)
       or jsonb_typeof(s -> 'subject') is distinct from 'string' or jsonb_typeof(s -> 'body') is distinct from 'string' then
      raise exception 'step % must be {step: %, subject, body}', i, i using errcode = '22023';
    end if;
    if not public.email_step_ok(s ->> 'subject', s ->> 'body') then
      raise exception 'step %: subject 1-150 on one line without "Re:"/"Fwd:", body 1-2000, no links (R4, R12)', i using errcode = '22023';
    end if;
    -- only {{first_name}}, {{company}}, {{city}} (22023 from the renderer otherwise)
    perform public.render_email_template(s ->> 'subject', '{}'::jsonb), public.render_email_template(s ->> 'body', '{}'::jsonb);
    v_steps := v_steps || jsonb_build_array(jsonb_build_object('step', i, 'subject', s ->> 'subject', 'body', s ->> 'body'));
  end loop;

  select coalesce(max(q.version), 0) + 1 into v_version from public.email_sequences q where q.campaign_id = c.id;
  -- only the newest version can be approved: the approved one and any older draft are superseded
  update public.email_sequences q set status = 'superseded' where q.campaign_id = c.id and q.status <> 'superseded';
  insert into public.email_sequences (workspace_id, campaign_id, agent_id, version, status, tone, steps, step2_delay_days,
                                      step3_delay_days, ai_model, prompt_version, human_edited, created_by)
  values (c.workspace_id, c.id, c.agent_id, v_version, 'draft', p_tone, v_steps, p_step2, p_step3,
          p_ai_model, p_prompt_version, coalesce(p_human_edited, false), auth.uid())
  returning id into v_id;

  -- R1: unsent messages of older text are cancelled, so that text can never be approved again (the approval of the
  -- new version re-writes them from it); dropped approvals are logged
  with prev as (
    select m.id, m.status from public.email_messages m
     where m.campaign_id = c.id and m.kind = 'sequence' and m.status in ('draft', 'approved', 'rejected')
  ), upd as (
    update public.email_messages m
       set status = 'cancelled', cancel_reason = 'sequence_edited',
           approved_by = null, approved_at = null, approved_to = null, approved_digest = null
      from prev
     where m.id = prev.id
    returning m.id, m.workspace_id, prev.status as was
  )
  insert into public.email_approvals (workspace_id, message_id, user_id, action)
  select u.workspace_id, u.id, auth.uid(), 'unapprove' from upd u where u.was = 'approved';

  update public.email_campaigns
     set step2_delay_days = coalesce(p_step2, step2_delay_days), step3_delay_days = coalesce(p_step3, step3_delay_days)
   where id = c.id and (p_step2 is not null or p_step3 is not null);
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- the 3-example preview (J1)
create or replace function public.preview_sequence(p_sequence uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  q record;
  p record;
  v_steps jsonb;
  v_examples jsonb := '[]'::jsonb;
  v_ids uuid[] := '{}';
begin
  select * into q from public.email_sequences where id = p_sequence;
  if q.id is null or auth.uid() is null or not public.is_workspace_sender(q.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  for p in
    select x.id, x.company_name, x.email from public.email_prospects x
     where x.campaign_id = q.campaign_id and x.status = 'active' and x.email is not null
     order by x.created_at, x.id
  loop
    v_steps := public.render_sequence_for(q.steps, p.id);
    continue when v_steps is null;
    v_examples := v_examples || jsonb_build_array(jsonb_build_object(
      'prospect_id', p.id, 'company', p.company_name, 'to', p.email, 'steps', v_steps));
    v_ids := v_ids || p.id;
    exit when cardinality(v_ids) = 3;
  end loop;
  -- J1: the digest covers what the screen showed (rendered examples with their leads and addresses), the tone and delays
  return jsonb_build_object(
    'digest', encode(sha256(convert_to(jsonb_build_object('examples', v_examples, 'tone', q.tone, 'step2', q.step2_delay_days,
                                                          'step3', q.step3_delay_days)::text, 'UTF8')), 'hex'),
    'examples', v_examples);
end;
$$;

revoke all on function public.render_email_template(text, jsonb) from public, anon;
grant execute on function public.render_email_template(text, jsonb) to authenticated;
revoke all on function public.prospect_template_vars(uuid) from public, anon, authenticated;
revoke all on function public.js_trim(text) from public, anon;
grant execute on function public.js_trim(text) to authenticated;
revoke all on function public.email_step_ok(text, text) from public, anon, authenticated;
revoke all on function public.render_sequence_for(jsonb, uuid) from public, anon, authenticated;
revoke all on function public.save_sequence_draft(uuid, jsonb, text, integer, integer, text, text, boolean) from public, anon, authenticated;
grant execute on function public.save_sequence_draft(uuid, jsonb, text, integer, integer, text, text, boolean) to authenticated;
revoke all on function public.preview_sequence(uuid) from public, anon, authenticated;
grant execute on function public.preview_sequence(uuid) to authenticated;

-- part 2 (Task 5): approve_email_sequence, queue_approved_sequence, e-mail agent life cycle
-- Part 2 (Task 5):
--   * approve_email_sequence(): the OWNER (D3) approves the newest draft once (J1), against the digest the screen showed
--     (40001 when anything shown changed). The campaign row is locked FOR UPDATE first (save_sequence_draft takes the
--     same lock), so no edit lands between the recomputed digest and the stamp.
--   * queue_approved_sequence(): the approved text, rendered per active lead, becomes one 'approved' message per step
--     with the R1 stamp of the approver. It never sends: the claim (C12, E2, E4, C2 gates) is still the only way out.
--     Only unsent rows are (re)written: new, draft/rejected, approved with other text, or cancelled by an edit
--     ('sequence_edited'); never a row cancelled for a stop reason. Leads blocked by C2 or whose values would break a
--     rule (render_sequence_for null) are skipped.
--   * add_leads_to_campaign (0021 body): leads added after the approval are queued from the approved version (D6).
--   * guard_agent (0020 body): an e-mail agent leaves draft (-> paused) once a sequence exists; Ligar/Pausar only
--     through set_email_agent_running (approved version, a mailbox, a complete sender profile). Real mode stays
--     set_campaign_send_mode (owner + C12).
--   * ai_calls_task (0014 list) += 'email_sequence'.

-- ---------------------------------------------------------------- the queue (internal)
-- Called by the definer functions below only (plain, no grant). Returns how many messages were stamped.
create or replace function public.queue_approved_sequence(p_campaign uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  c record;
  q record;
  p record;
  m record;
  s jsonb;
  v_steps jsonb;
  v_step integer;
  v_subject text;
  v_body text;
  v_first timestamptz;
  v_id uuid;
  n integer := 0;
begin
  -- same lock order as save_sequence_draft and the claim (campaign, then messages): a concurrent edit either lands
  -- before (and this sees the new state) or waits
  select * into c from public.email_campaigns where id = p_campaign for share;
  select * into q from public.email_sequences where campaign_id = p_campaign and status = 'approved';
  if c.id is null or q.id is null or c.status = 'archived' then
    return 0;
  end if;
  for p in
    select x.id, x.workspace_id, x.email, x.lead_id, x.candidate_id
      from public.email_prospects x
     where x.campaign_id = c.id and x.status = 'active' and x.email is not null
     order by x.id
  loop
    continue when public.lead_blocks_message(public.prospect_lead(p.lead_id, p.candidate_id, p.workspace_id), 'sequence');
    v_steps := public.render_sequence_for(q.steps, p.id);
    continue when v_steps is null;
    -- the prospect's sequence rows in step order (the claim/finish order) before reading step 1, so a send finishing
    -- now cannot leave a follow-up without its due date. Residual: the 0022 stop trigger locks messages by id, then the
    -- prospect; a lead blocked during this very call can still meet this queue in a rare 40P01 (rolled back, nothing
    -- sent, retry the approval).
    perform 1 from public.email_messages x where x.prospect_id = p.id and x.kind = 'sequence' order by x.step for update;
    select f.sent_at into v_first from public.email_messages f
     where f.prospect_id = p.id and f.kind = 'sequence' and f.step = 1 and f.status in ('sent', 'dry_run');
    for s in select x from jsonb_array_elements(v_steps) x loop
      v_step := (s ->> 'step')::integer;
      v_subject := s ->> 'subject';
      v_body := s ->> 'body';
      select * into m from public.email_messages x
       where x.prospect_id = p.id and x.kind = 'sequence' and x.step = v_step
         for update;
      if m.id is null then
        insert into public.email_messages (workspace_id, campaign_id, prospect_id, kind, step, subject, body, ai_drafted,
                                           ai_model, prompt_version)
        values (p.workspace_id, c.id, p.id, 'sequence', v_step, v_subject, v_body, true, q.ai_model, q.prompt_version)
        returning id into v_id;
      elsif m.status = 'cancelled' and m.cancel_reason = 'sequence_edited' then
        v_id := m.id;
      else
        -- sent, sending, dry_run, failed, cancelled for a stop reason, already queued, or a row a person rejected or
        -- reset (an address edit): never re-stamped with the owner's approval here (the owner approves it one by one)
        continue;
      end if;
      update public.email_messages
         set subject = v_subject, body = v_body, ai_drafted = true, ai_model = q.ai_model, prompt_version = q.prompt_version,
             human_edited = q.human_edited, ai_facts = '[]'::jsonb, ai_no_fact = null, cancel_reason = null, error = null,
             status = 'approved', approved_by = q.approved_by, approved_at = now(), approved_to = p.email,
             approved_digest = public.message_digest(v_subject, v_body),
             due_at = case
                        when v_step = 1 then now()
                        when v_first is null then null
                        else public.add_business_days(v_first, case v_step when 2 then coalesce(q.step2_delay_days, c.step2_delay_days)
                                                                else coalesce(q.step3_delay_days, c.step3_delay_days) end)
                      end
       where id = v_id;
      insert into public.email_approvals (workspace_id, message_id, user_id, action, approved_to)
      values (p.workspace_id, v_id, q.approved_by, 'approve', p.email);
      n := n + 1;
    end loop;
  end loop;
  return n;
end;
$$;

-- ---------------------------------------------------------------- J1 approval (owner only, D3)
create or replace function public.approve_email_sequence(p_sequence uuid, p_digest text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  q record;
  c record;
  v_preview jsonb;
begin
  select * into q from public.email_sequences where id = p_sequence;
  if q.id is null or auth.uid() is null or not public.is_workspace_owner(q.workspace_id) then
    raise exception 'J1: only the owner approves' using errcode = '42501';
  end if;
  -- the save lock: no new version can land between the digest below and the stamp
  select * into c from public.email_campaigns where id = q.campaign_id for update;
  select * into q from public.email_sequences where id = p_sequence for update;
  if q.status <> 'draft'
     or q.version <> (select max(x.version) from public.email_sequences x where x.campaign_id = q.campaign_id) then
    raise exception 'only the newest draft can be approved; review again' using errcode = '55000';
  end if;
  if c.status = 'archived' then
    raise exception 'campaign archived' using errcode = '55000';
  end if;
  -- the example leads are held FOR SHARE (no contact/address edit until commit), then the digest is recomputed
  v_preview := public.preview_sequence(q.id);
  perform 1 from public.email_prospects x
   where x.id in (select (e ->> 'prospect_id')::uuid from jsonb_array_elements(v_preview -> 'examples') e)
   order by x.id
     for share;
  v_preview := public.preview_sequence(q.id);
  if p_digest is null or p_digest is distinct from v_preview ->> 'digest' then
    raise exception 'sequence changed; review again' using errcode = '40001';
  end if;
  if jsonb_array_length(v_preview -> 'examples') = 0 then
    raise exception 'J1: no lead to show as an example; add leads with an e-mail first' using errcode = '22023';
  end if;

  update public.email_sequences x set status = 'superseded'
   where x.campaign_id = q.campaign_id and x.id <> q.id and x.status <> 'superseded';
  update public.email_sequences
     set status = 'approved', approved_by = auth.uid(), approved_at = now(), approved_digest = p_digest,
         example_prospect_ids = array(select (e ->> 'prospect_id')::uuid from jsonb_array_elements(v_preview -> 'examples') e)
   where id = q.id;
  return public.queue_approved_sequence(q.campaign_id);
end;
$$;

-- ---------------------------------------------------------------- add_leads_to_campaign (0021 body + D6 queue)
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

  -- D6: a lead added after the approval goes out with the approved text (no new examples, no new approval).
  -- The result keeps 0021's keys.
  if v_added > 0 then
    perform public.queue_approved_sequence(c.id);
  end if;

  return jsonb_build_object('added', v_added, 'no_email', v_no_email, 'blocked', v_blocked,
                            'in_other_campaign', v_other, 'suppressed', v_suppressed, 'already', v_already);
end;
$$;

-- ---------------------------------------------------------------- agent life cycle
-- 0020's guard_agent with the e-mail agent rule added (nothing removed). Not security definer: is_client_role() reads
-- current_user. An e-mail agent goes draft -> paused by a client once its campaign has a sequence; running/paused only
-- through set_email_agent_running (definer).
create or replace function public.guard_agent()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_running integer;
begin
  if tg_op = 'INSERT' then
    new.status := 'draft';
    new.created_by := auth.uid();
    new.created_at := now();
    new.updated_at := now();
    new.archived_at := null;
    new.next_run_at := null;
    new.paused_reason := null;
    return new;
  end if;

  if old.archived_at is not null then
    raise exception 'A4: an archived agent cannot change' using errcode = '23514';
  end if;
  if new.archived_at is distinct from old.archived_at then
    if old.status = 'running' then
      raise exception 'A8: pause the agent before archiving it' using errcode = '23514';
    end if;
    new.archived_at := now();
  end if;

  if public.is_client_role() then
    if new.status is distinct from old.status then
      if not (
        (old.type <> 'call' and old.status = 'draft' and new.status = 'paused'
          and exists (
            select 1 from public.research_runs r
             where r.setup_agent_id = new.id and r.status = 'plan' and r.plan is not null
          ))
        or (old.type = 'call' and old.status = 'draft' and new.status = 'paused'
          and public.call_agent_config_ok(new.config, new.workspace_id))
        or (old.type = 'email' and old.status = 'draft' and new.status = 'paused'
          and exists (
            select 1 from public.email_sequences s
              join public.email_campaigns c on c.id = s.campaign_id
             where c.agent_id = new.id
          ))
        or (old.type = 'hunter' and old.status = 'paused' and new.status = 'running')
        or (old.type = 'call' and old.status = 'paused' and new.status = 'running'
          and public.call_agent_config_ok(new.config, new.workspace_id))
        or (old.type in ('hunter', 'call') and old.status = 'running' and new.status = 'paused')
      ) then
        raise exception 'A3: an agent leaves draft only when its setup research has a plan (a call agent: a valid config; an e-mail agent: a sequence); then only Ligar and Pausar' using errcode = '23514';
      end if;
    end if;
    if old.status <> 'draft' and (
      new.config is distinct from old.config or new.schedule is distinct from old.schedule
    ) then
      raise exception 'A6: config and schedule are frozen once the agent left draft' using errcode = '23514';
    end if;
  end if;

  if new.status = 'running' and old.status is distinct from 'running' then
    if new.type = 'hunter' then
      perform pg_advisory_xact_lock(hashtextextended('hunter:' || new.workspace_id::text, 0));
      select count(*) into v_running
        from public.agents a
       where a.workspace_id = new.workspace_id and a.type = 'hunter' and a.status = 'running'
         and a.archived_at is null and a.id <> new.id;
      if v_running >= 3 then
        raise exception 'A7: at most 3 hunters can be running in a workspace' using errcode = '23514';
      end if;
    end if;
    if old.status = 'paused' then
      new.next_run_at := coalesce(old.next_run_at, now());
      new.paused_reason := null;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

-- Ligar (p_on) / Pausar an e-mail agent: owner or sdr. Ligar needs the approved version, at least one mailbox and a
-- complete sender profile; it sets the agent running and its campaign active (the send mode is not touched: real
-- sending stays set_campaign_send_mode, owner + C12). Pausar sets both paused, so the clock stops picking the campaign.
create or replace function public.set_email_agent_running(p_agent uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  a record;
  c record;
begin
  select * into a from public.agents where id = p_agent;
  if a.id is null or auth.uid() is null or not public.is_workspace_sender(a.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if a.type <> 'email' or p_on is null then
    raise exception 'only an e-mail agent, on or off' using errcode = '22023';
  end if;
  if a.archived_at is not null then
    raise exception 'A4: an archived agent cannot change' using errcode = '55000';
  end if;
  -- campaign first (the save/approve lock order), then the agent
  select * into c from public.email_campaigns where agent_id = a.id for update;
  select * into a from public.agents where id = p_agent for update;
  if c.id is null or c.status = 'archived' then
    raise exception 'this agent has no open campaign' using errcode = '55000';
  end if;
  if p_on then
    if not exists (select 1 from public.email_sequences s where s.campaign_id = c.id and s.status = 'approved') then
      raise exception 'J1: the owner approves the sequence first' using errcode = '55000';
    end if;
    if not exists (select 1 from public.campaign_mailboxes cm where cm.campaign_id = c.id) then
      raise exception 'the campaign needs at least one mailbox' using errcode = '55000';
    end if;
    if not public.sender_profile_complete(a.workspace_id) then
      raise exception 'the sender profile (name, legal name, postal address) is incomplete' using errcode = '55000';
    end if;
    update public.agents set status = 'running' where id = a.id and status <> 'running';
    update public.email_campaigns set status = 'active' where id = c.id and status <> 'active';
  else
    update public.agents set status = 'paused' where id = a.id and status = 'running';
    update public.email_campaigns set status = 'paused' where id = c.id and status = 'active';
  end if;
end;
$$;

-- ---------------------------------------------------------------- AI task (0014 list + email_sequence)
alter table public.ai_calls drop constraint if exists ai_calls_task;
alter table public.ai_calls add constraint ai_calls_task check (
  task in ('research_questions', 'research_plan', 'research_discover', 'research_collect', 'research_verify',
           'research_second_pass', 'classify', 'email_draft', 'email_classify', 'email_reply_draft',
           'email_closer_brief', 'qualify_light', 'qualify_deep', 'qualify_places', 'profile_learn', 'email_sequence')
);

revoke all on function public.queue_approved_sequence(uuid) from public, anon, authenticated;
revoke all on function public.approve_email_sequence(uuid, text) from public, anon, authenticated;
grant execute on function public.approve_email_sequence(uuid, text) to authenticated;
revoke all on function public.add_leads_to_campaign(uuid, uuid[]) from public, anon;
grant execute on function public.add_leads_to_campaign(uuid, uuid[]) to authenticated;
revoke all on function public.guard_agent() from public, anon, authenticated;
revoke all on function public.set_email_agent_running(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_email_agent_running(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------- J1 for single messages (0003 body + owner check)
create or replace function public.set_email_approval(p_ids uuid[], p_versions timestamptz[], p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
  v_email text;
  v_to text;
  n integer := 0;
  v_changed integer := 0;
  v_skipped integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_action not in ('approve', 'reject', 'unapprove') then
    raise exception 'invalid action' using errcode = '22023';
  end if;
  if coalesce(array_length(p_ids, 1), 0) > 200 then
    raise exception 'too many messages at once' using errcode = '22023';
  end if;
  if coalesce(array_length(p_ids, 1), 0) <> coalesce(array_length(p_versions, 1), 0) then
    raise exception 'one version per message is required' using errcode = '22023';
  end if;
  for i in 1 .. coalesce(array_length(p_ids, 1), 0) loop
    select * into m from public.email_messages where id = p_ids[i] for update;
    if m.id is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    if not public.is_workspace_sender(m.workspace_id) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if p_versions[i] is null or m.updated_at is distinct from p_versions[i] then
      v_changed := v_changed + 1;
      continue;
    end if;
    -- J1 / D3: in a campaign written from a versioned sequence (an E-mail agent), sequence text goes out only with the
    -- owner's approval (an sdr's edit or an address change drops a row back to draft; only the owner approves it
    -- again). Campaigns without a sequence keep the 0003 rule (any sender approves each message).
    if p_action = 'approve' and m.kind = 'sequence' and not public.is_workspace_owner(m.workspace_id)
       and exists (select 1 from public.email_sequences x where x.campaign_id = m.campaign_id) then
      raise exception 'J1: only the owner approves sequence messages' using errcode = '42501';
    end if;
    v_to := null;
    if p_action = 'approve' and m.status in ('draft', 'rejected') then
      select p.email into v_email from public.email_prospects p where p.id = m.prospect_id;
      v_to := public.message_target(m.kind, m.reply_to_id, v_email);
      update public.email_messages
         set status = 'approved', approved_by = auth.uid(), approved_at = now(), approved_to = v_to,
             approved_digest = public.message_digest(m.subject, m.body)
       where id = m.id;
    elsif p_action = 'reject' and m.status in ('draft', 'approved') then
      update public.email_messages
         set status = 'rejected', approved_by = null, approved_at = null, approved_to = null, approved_digest = null
       where id = m.id;
    elsif p_action = 'unapprove' and m.status = 'approved' then
      update public.email_messages
         set status = 'draft', approved_by = null, approved_at = null, approved_to = null, approved_digest = null
       where id = m.id;
    else
      v_skipped := v_skipped + 1;
      continue;
    end if;
    insert into public.email_approvals (workspace_id, message_id, user_id, action, approved_to)
    values (m.workspace_id, m.id, auth.uid(), p_action, v_to);
    n := n + 1;
  end loop;
  return jsonb_build_object('done', n, 'changed', v_changed, 'skipped', v_skipped);
end;
$$;
revoke all on function public.set_email_approval(uuid[], timestamptz[], text) from public, anon;
grant execute on function public.set_email_approval(uuid[], timestamptz[], text) to authenticated;

-- ---------------------------------------------------------------- finish (0005 body; done after the last step)
create or replace function public.finish_email_send_core(p_message uuid, p_holder uuid, p_result text, p_error text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  m record;
  c record;
  q record;
begin
  select * into m from public.email_messages where id = p_message for update;
  if m.id is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if m.status <> 'sending' or m.claim_holder is distinct from p_holder then
    raise exception 'message is not claimed by this holder' using errcode = '55000';
  end if;
  if p_result not in ('sent', 'dry_run', 'failed')
     or (p_result = 'sent' and m.send_mode <> 'real')
     or (p_result = 'dry_run' and m.send_mode <> 'dry_run') then
    raise exception 'result does not match the send mode' using errcode = '22023';
  end if;
  update public.email_messages
     set status = p_result,
         sent_at = case when p_result = 'failed' then null else now() end,
         error = case when p_result = 'failed' then left(coalesce(p_error, 'failed'), 300) end,
         claim_expires_at = null
   where id = m.id;
  update public.email_send_log l
     set result = p_result,
         error = case when p_result = 'failed' then left(coalesce(p_error, 'failed'), 300) end,
         finished_at = now()
   where l.message_id = m.id and l.holder = p_holder and l.result = 'pending';
  if p_result = 'failed' or m.kind <> 'sequence' then
    return;
  end if;
  select * into c from public.email_campaigns where id = m.campaign_id;
  -- the approved version's delays (what the owner approved), else the campaign's
  select * into q from public.email_sequences where campaign_id = m.campaign_id and status = 'approved';
  if m.step = 1 then
    update public.email_messages
       set due_at = public.add_business_days(now(), case step when 2 then coalesce(q.step2_delay_days, c.step2_delay_days)
                                                               else coalesce(q.step3_delay_days, c.step3_delay_days) end)
     where prospect_id = m.prospect_id and kind = 'sequence' and step in (2, 3) and status in ('draft', 'approved', 'rejected');
  end if;
  -- step 3 ends the prospect (0005). In a campaign with an approved sequence, so does the last step it still has
  -- (1 or 2 steps). A row cancelled by an edit still counts as pending: the approval of the new version re-writes it.
  -- Campaigns without a sequence draft each step later, so only step 3 ends them there.
  if m.step = 3 or (q.id is not null and not exists (
       select 1 from public.email_messages n
        where n.prospect_id = m.prospect_id and n.kind = 'sequence' and n.step > m.step
          and (n.status in ('draft', 'approved', 'rejected', 'sending')
               or (n.status = 'cancelled' and n.cancel_reason = 'sequence_edited')))) then
    update public.email_prospects set status = 'done' where id = m.prospect_id and status = 'active';
  end if;
end;
$$;
revoke all on function public.finish_email_send_core(uuid, uuid, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- an agent's campaign runs only through Ligar
-- Pausar must not be undone by a direct update: a client cannot set an agent-owned campaign active. Not definer:
-- is_client_role() reads current_user.
create or replace function public.guard_email_agent_campaign()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_client_role() and new.agent_id is not null and new.status = 'active' and old.status is distinct from 'active' then
    raise exception 'Ligar: use set_email_agent_running' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_email_agent_campaign() from public, anon, authenticated;
drop trigger if exists guard_email_agent_campaign on public.email_campaigns;
create trigger guard_email_agent_campaign before update of status on public.email_campaigns
  for each row execute function public.guard_email_agent_campaign();

-- the delays the owner approved belong to the sequence: clients no longer change them on the campaign
-- (save_sequence_draft writes them)
revoke update (step2_delay_days, step3_delay_days) on table public.email_campaigns from authenticated;

-- ---------------------------------------------------------------- the E-mail agent's campaign
-- Owner/sdr create THE campaign of a draft-or-paused e-mail agent (one per agent; agent_id is not client-writable).
-- In rehearsal and draft (guard_email_campaign forces both). Mailboxes go in through campaign_mailboxes, the delays
-- through save_sequence_draft. p_list_id, when given, must be a research list of the same workspace.
create or replace function public.create_email_agent_campaign(p_agent uuid, p_name text, p_list_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  a record;
  v_id uuid;
begin
  select * into a from public.agents where id = p_agent for update;
  if a.id is null or auth.uid() is null or not public.is_workspace_sender(a.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if a.type <> 'email' then
    raise exception 'only an e-mail agent has a campaign' using errcode = '22023';
  end if;
  if a.archived_at is not null then
    raise exception 'A4: an archived agent cannot change' using errcode = '55000';
  end if;
  if exists (select 1 from public.email_campaigns c where c.agent_id = a.id) then
    raise exception 'this agent already has a campaign' using errcode = '55000';
  end if;
  if p_list_id is not null and not public.list_in_workspace(p_list_id, a.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 120 then
    raise exception 'campaign name 1-120 characters' using errcode = '22023';
  end if;
  insert into public.email_campaigns (workspace_id, list_id, name, agent_id)
  values (a.workspace_id, p_list_id, btrim(p_name), a.id)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.create_email_agent_campaign(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.create_email_agent_campaign(uuid, text, uuid) to authenticated;
