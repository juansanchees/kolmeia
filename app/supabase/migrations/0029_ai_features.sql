-- 0029 Fase 3 "IA onde ajuda o SDR" (docs/apollo-plano.md items 9-13).
--   9  ai_questions + ai_answers: "Pergunta da IA para cada lead". Owner/sdr create a question (<= 300 characters, an
--      answer type, the sources the AI may read) and queue leads; the app answers them in the sender's session (caps
--      and ledger in reserve_ai_call). The database keeps the rule that matters: a finished answer other than
--      'unknown' always carries its evidence excerpt (the AI never guesses without proof). The closer reads only
--      the answers of leads assigned to her (lead_visible_to_assignee, the hand-off sets leads.owner_id); anon nothing.
--  10  email_messages.ai_signal: the work/permit signal the AI draft opened with ("Sinal usado"), written with the draft.
--  12  replace_ai_draft(): "Revisar com modelo forte" replaces a sequence draft's text with a new AI version (not a
--      human edit), only for a draft or rejected step the person saw at that version (updated_at), never an approved,
--      sent or cancelled one.
--      ai_calls_task += 'ai_answer' (item 9) and 'lead_explain' (item 13, "Por que este lead é quente?").
-- Depends on 0001-0028. Re-runnable.

-- ---------------------------------------------------------------- 9 ai_questions
create table if not exists public.ai_questions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  question text not null constraint ai_questions_question check (char_length(btrim(question)) between 3 and 300),
  answer_type text not null constraint ai_questions_answer_type check (answer_type in ('yes_no_unknown', 'short_text', 'score_1_5')),
  -- 'site' = the lead's own website (robots-aware read); 'data' = what the lead already holds (lead_fields, research)
  sources text[] not null constraint ai_questions_sources check (cardinality(sources) between 1 and 2 and sources <@ array['site', 'data']::text[]),
  created_by uuid,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists ai_questions_ws_idx on public.ai_questions (workspace_id, created_at desc);

create or replace function public.stamp_ai_question()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  else
    -- only archiving changes a question; its text, type and sources are what every stored answer answered
    new.question := old.question;
    new.answer_type := old.answer_type;
    new.sources := old.sources;
    new.workspace_id := old.workspace_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;
revoke all on function public.stamp_ai_question() from public, anon, authenticated;
drop trigger if exists stamp_ai_question on public.ai_questions;
create trigger stamp_ai_question before insert or update on public.ai_questions
  for each row execute function public.stamp_ai_question();

revoke all on table public.ai_questions from public, anon, authenticated;
grant select on table public.ai_questions to authenticated;
grant insert (workspace_id, question, answer_type, sources) on table public.ai_questions to authenticated;
grant update (archived_at) on table public.ai_questions to authenticated;
alter table public.ai_questions enable row level security;
alter table public.ai_questions force row level security;
drop policy if exists ai_questions_select on public.ai_questions;
create policy ai_questions_select on public.ai_questions
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists ai_questions_insert on public.ai_questions;
create policy ai_questions_insert on public.ai_questions
  for insert to authenticated with check (public.is_workspace_sender(workspace_id));
drop policy if exists ai_questions_update on public.ai_questions;
create policy ai_questions_update on public.ai_questions
  for update to authenticated using (public.is_workspace_sender(workspace_id)) with check (public.is_workspace_sender(workspace_id));

-- ---------------------------------------------------------------- 9 ai_answers
create table if not exists public.ai_answers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  question_id uuid not null references public.ai_questions (id) on delete cascade,
  -- plain FK on purpose (like tasks and call_logs): a composite one would block re-running 0011; RLS checks the workspace
  lead_id uuid not null references public.leads (id) on delete cascade,
  status text not null default 'queued' constraint ai_answers_status check (status in ('queued', 'done', 'failed', 'skipped')),
  -- 'yes' | 'no' | '1'..'5' | short text | 'unknown' ("Não sei")
  answer text constraint ai_answers_answer check (answer is null or char_length(answer) between 1 and 300),
  evidence_url text constraint ai_answers_evidence_url check (evidence_url is null or (char_length(evidence_url) <= 2000 and evidence_url ~* '^https?://')),
  evidence_excerpt text constraint ai_answers_evidence_excerpt check (evidence_excerpt is null or char_length(evidence_excerpt) between 1 and 300),
  evidence_label text constraint ai_answers_evidence_label check (evidence_label is null or char_length(evidence_label) <= 200),
  cost_usd numeric(12, 6) not null default 0 constraint ai_answers_cost check (cost_usd >= 0),
  error text constraint ai_answers_error check (error is null or char_length(error) <= 60),
  -- a step that took the row (two open tabs never pay twice); a claim older than 10 minutes is free again
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_answers_one unique (question_id, lead_id),
  constraint ai_answers_done check (status <> 'done' or answer is not null),
  -- never a guess: an answer other than "Não sei" keeps the excerpt that supports it
  constraint ai_answers_evidence check (status <> 'done' or answer = 'unknown' or evidence_excerpt is not null)
);
create index if not exists ai_answers_queue_idx on public.ai_answers (question_id, status, created_at);
create index if not exists ai_answers_lead_idx on public.ai_answers (lead_id);

create or replace function public.touch_ai_answer()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.workspace_id := old.workspace_id;
    new.question_id := old.question_id;
    new.lead_id := old.lead_id;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;
revoke all on function public.touch_ai_answer() from public, anon, authenticated;
drop trigger if exists touch_ai_answer on public.ai_answers;
create trigger touch_ai_answer before insert or update on public.ai_answers
  for each row execute function public.touch_ai_answer();

revoke all on table public.ai_answers from public, anon, authenticated;
grant select on table public.ai_answers to authenticated;
grant insert (workspace_id, question_id, lead_id, status) on table public.ai_answers to authenticated;
grant update (status, answer, evidence_url, evidence_excerpt, evidence_label, cost_usd, error, claimed_at) on table public.ai_answers to authenticated;
alter table public.ai_answers enable row level security;
alter table public.ai_answers force row level security;
drop policy if exists ai_answers_select on public.ai_answers;
create policy ai_answers_select on public.ai_answers
  for select to authenticated
  using (public.is_workspace_sender(workspace_id) or public.lead_visible_to_assignee(lead_id, workspace_id));
-- Senders queue leads of their own workspace for questions of the same workspace (the subqueries run under their RLS).
drop policy if exists ai_answers_insert on public.ai_answers;
create policy ai_answers_insert on public.ai_answers
  for insert to authenticated
  with check (
    public.is_workspace_sender(workspace_id)
    and status = 'queued'
    and exists (select 1 from public.leads l where l.id = lead_id and l.workspace_id = ai_answers.workspace_id)
    and exists (select 1 from public.ai_questions q where q.id = question_id and q.workspace_id = ai_answers.workspace_id and q.archived_at is null)
  );
drop policy if exists ai_answers_update on public.ai_answers;
create policy ai_answers_update on public.ai_answers
  for update to authenticated
  using (public.is_workspace_sender(workspace_id))
  with check (public.is_workspace_sender(workspace_id));

-- ---------------------------------------------------------------- 10 the signal a draft opened with
alter table public.email_messages
  add column if not exists ai_signal text;
alter table public.email_messages drop constraint if exists email_messages_ai_signal;
alter table public.email_messages
  add constraint email_messages_ai_signal check (ai_signal is null or char_length(ai_signal) between 1 and 300);
grant insert (workspace_id, campaign_id, prospect_id, kind, step, reply_to_id, subject, body, ai_drafted, ai_model, prompt_version,
              ai_facts, ai_no_fact, ai_signal)
  on table public.email_messages to authenticated;

-- ---------------------------------------------------------------- 12 strong-model redraft of one sequence step
-- Definer: the client may only update subject/body (0003), which marks the text human_edited; a new AI version is not
-- a human edit and carries its own model, prompt version, facts and signal. Same R4/R12 constraints apply (table checks).
create or replace function public.replace_ai_draft(
  p_message uuid,
  p_version timestamptz,
  p_subject text,
  p_body text,
  p_model text,
  p_prompt_version text,
  p_facts jsonb,
  p_no_fact boolean,
  p_signal text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
begin
  select id, workspace_id, kind, status, updated_at into m from public.email_messages where id = p_message for update;
  if m.id is null or auth.uid() is null or not public.is_workspace_sender(m.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- only a sequence step that is still a draft (or was rejected) and that the person saw at this version
  if m.kind <> 'sequence' or m.status not in ('draft', 'rejected') or m.updated_at is distinct from p_version then
    return false;
  end if;
  update public.email_messages
     set subject = btrim(p_subject),
         body = btrim(p_body),
         ai_drafted = true,
         ai_model = left(p_model, 60),
         prompt_version = left(p_prompt_version, 40),
         ai_facts = coalesce(p_facts, '[]'::jsonb),
         ai_no_fact = p_no_fact,
         ai_signal = nullif(left(btrim(coalesce(p_signal, '')), 300), ''),
         human_edited = false,
         status = 'draft'
   where id = p_message;
  return true;
end;
$$;
revoke all on function public.replace_ai_draft(uuid, timestamptz, text, text, text, text, jsonb, boolean, text) from public, anon;
grant execute on function public.replace_ai_draft(uuid, timestamptz, text, text, text, text, jsonb, boolean, text) to authenticated;

-- ---------------------------------------------------------------- AI tasks
alter table public.ai_calls drop constraint if exists ai_calls_task;
alter table public.ai_calls add constraint ai_calls_task check (
  task in ('research_questions', 'research_plan', 'research_discover', 'research_collect', 'research_verify',
           'research_second_pass', 'classify', 'email_draft', 'email_classify', 'email_reply_draft',
           'email_closer_brief', 'qualify_light', 'qualify_deep', 'qualify_places', 'profile_learn', 'email_sequence',
           'lead_search', 'ai_answer', 'lead_explain')
);
