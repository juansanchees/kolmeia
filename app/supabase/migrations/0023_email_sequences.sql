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
