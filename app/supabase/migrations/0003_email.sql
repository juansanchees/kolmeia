-- F4-F5 e-mail ("E-mail"): sender profile, mailboxes, suppressions, campaigns, prospects, messages, approvals,
-- replies. Same standard as 0001/0002: RLS enabled and forced, policies only for `authenticated`, column-level
-- grants, SECURITY DEFINER functions with an empty search_path, no service-role key anywhere (rule R14).
--
-- Rules enforced HERE (the app enforces them first, in code; the database is the last line):
--   R1  nothing leaves without a human approval: a message can only be claimed for sending when it is 'approved'
--       with approved_by/approved_at/approved_to stamped by set_email_approval() (definer; the stamp columns are
--       not client-writable). The approval is tied to what the person saw (the row's updated_at) and to the
--       recipient address; editing subject/body, or changing the prospect's address, drops it back to 'draft'.
--   R2  claim_next_email() locks the sending address, counts the last 24 h of claims from that address (per mode,
--       across workspaces) in the append-only email_send_log and refuses over min(daily_limit, 50) or inside the
--       random 60-180 s gap left by the previous claim. Retries and deletions never give a slot back.
--   R3  the same claim refuses (and cancels) messages whose recipient address or domain is in suppressions;
--       a reply from a prospect stops its remaining sequence steps (record_email_reply).
--   R4  real and rehearsal sending need a complete sender profile (legal name, postal address, sender name);
--       real sending needs a verified mailbox and an explicit owner switch; subjects cannot fake "Re:/Fwd:".
--       Switching a campaign to real resets its rehearsal trail: a follow-up only goes out for real after the
--       previous step really went out.
--   R9  one row per (prospect, step); a claimed message is never claimed again (status machine); a claim whose
--       result is unknown needs a person's explicit confirmation before it can be retried.
--   R12 sequence bodies cannot contain links (the unsubscribe link is added by the footer at send time).
--   R18 a prospect address is either found by the research with a source URL whose excerpt contains it, or typed
--       or confirmed by a user ('manual').
--
-- What survives deletions (audit, R2, unsubscribe): email_send_log (append-only, no foreign keys),
-- email_unsub_tokens and email_approvals are never cascade-deleted with a campaign; a campaign that has claimed
-- anything cannot be deleted at all (archive it instead).
--
-- Inherent limits without a service key (documented in docs/mvp/fase-4-email.md): the server acts as the
-- logged-in owner/SDR, so a member who calls the RPCs directly can report a mailbox as verified
-- (set_mailbox_verified) or report a claimed message as sent/failed (finish_email_send) without the SMTP step
-- really happening. They cannot skip approval, limits, suppression or the sender profile.
--
-- Who writes what: the logged-in user's session (RLS) for content (subjects, bodies, names); SECURITY DEFINER
-- functions for every state change that must not be forged (approval, claim, send result, replies, suppression by
-- token, hand-off). Triggers tell the two apart by current_user: 'authenticated'/'anon' = a client statement;
-- anything else = a definer function owned by the migration role.

-- ---------------------------------------------------------------- AI tasks of this area (ledger constraint)
alter table public.ai_calls drop constraint if exists ai_calls_task;
alter table public.ai_calls add constraint ai_calls_task check (
  task in ('research_questions', 'research_plan', 'research_discover', 'research_collect', 'research_verify',
           'research_second_pass', 'classify', 'email_draft', 'email_classify', 'email_reply_draft',
           'email_closer_brief')
);

-- ---------------------------------------------------------------- helpers
-- Owners and SDRs prepare and send e-mail; closers only read and receive hand-offs.
create or replace function public.is_workspace_sender(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = auth.uid() and m.role in ('owner', 'sdr')
  );
$$;

create or replace function public.is_client_role()
returns boolean
language sql
stable
set search_path = ''
as $$
  select current_user in ('authenticated', 'anon');
$$;

create or replace function public.is_email_address(v text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select v is not null
     and char_length(v) between 6 and 254
     and v = lower(v)
     and v ~ '^[a-z0-9._%+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$';
$$;

-- Adds n business days (Mon-Fri, UTC calendar, no holidays). Mirrors src/lib/email/schedule.ts.
create or replace function public.add_business_days(p_from timestamptz, p_days integer)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
declare
  d timestamp := p_from at time zone 'UTC';
  n integer := 0;
begin
  while n < greatest(coalesce(p_days, 0), 0) loop
    d := d + interval '1 day';
    if extract(isodow from d) < 6 then
      n := n + 1;
    end if;
  end loop;
  return d at time zone 'UTC';
end;
$$;

-- What an approval is tied to: the exact subject and body the person saw.
create or replace function public.message_digest(p_subject text, p_body text)
returns text
language sql
immutable
set search_path = ''
as $$
  select md5(coalesce(p_subject, '') || chr(10) || coalesce(p_body, ''));
$$;

-- Shape of the closer brief (written only through save_closer_brief()): exactly these keys, bounded strings,
-- at most 4 safe evidence URLs. Null means "no brief yet".
create or replace function public.is_closer_brief(b jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select b is null or (
    jsonb_typeof(b) = 'object'
    and b ?& array['who', 'what_they_said', 'next_step', 'evidence_urls', 'model']
    and (select count(*) from jsonb_object_keys(b)) = 5
    and jsonb_typeof(b -> 'who') = 'string' and char_length(b ->> 'who') <= 600
    and jsonb_typeof(b -> 'what_they_said') = 'string' and char_length(b ->> 'what_they_said') <= 800
    and jsonb_typeof(b -> 'next_step') = 'string' and char_length(b ->> 'next_step') <= 400
    and jsonb_typeof(b -> 'model') = 'string' and char_length(b ->> 'model') <= 60
    and jsonb_typeof(b -> 'evidence_urls') = 'array' and jsonb_array_length(b -> 'evidence_urls') <= 4
    and not exists (
      select 1 from jsonb_array_elements(b -> 'evidence_urls') u
       where jsonb_typeof(u) <> 'string' or char_length(u #>> '{}') > 2000 or not public.is_safe_url(u #>> '{}')
    )
  );
$$;

-- ---------------------------------------------------------------- tables
create table if not exists public.sender_profiles (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  legal_name text not null default ''
    constraint sender_profiles_legal_name check (char_length(legal_name) <= 120 and legal_name !~ '[\r\n]'),
  postal_address text not null default ''
    constraint sender_profiles_postal_address check (char_length(postal_address) <= 300),
  -- goes into the From header: no line breaks, no quotes or angle brackets (header injection)
  sender_name text not null default ''
    constraint sender_profiles_sender_name check (char_length(sender_name) <= 80 and sender_name !~ '[\r\n<>"\\]'),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.mailboxes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text not null constraint mailboxes_email check (public.is_email_address(email)),
  provider text not null default 'gmail' constraint mailboxes_provider check (provider = 'gmail'),
  status text not null default 'unverified' constraint mailboxes_status check (status in ('unverified', 'ok', 'error')),
  last_error text constraint mailboxes_last_error_len check (char_length(last_error) <= 300),
  verified_at timestamptz,
  -- R2: default 30 per day, hard ceiling 50 (also re-applied inside the claim)
  daily_limit integer not null default 30 constraint mailboxes_daily_limit check (daily_limit between 1 and 50),
  -- AES-256-GCM ciphertext of the app password. Never granted to clients; read only through mailbox_secret().
  secret_ciphertext text not null constraint mailboxes_secret_len check (char_length(secret_ciphertext) between 20 and 1000),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint mailboxes_unique_email unique (workspace_id, email)
);

create table if not exists public.suppressions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null constraint suppressions_kind check (kind in ('address', 'domain')),
  value text not null,
  reason text not null constraint suppressions_reason check (reason in ('unsubscribed', 'bounced', 'manual', 'asked_to_stop')),
  note text not null default '' constraint suppressions_note_len check (char_length(note) <= 300),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint suppressions_value check (
    (kind = 'address' and public.is_email_address(value))
    or (kind = 'domain' and char_length(value) <= 253 and value ~ '^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$')
  ),
  constraint suppressions_unique unique (workspace_id, kind, value)
);

create table if not exists public.email_campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  list_id uuid references public.research_lists (id) on delete set null,
  name text not null constraint email_campaigns_name_len check (char_length(btrim(name)) between 1 and 120),
  status text not null default 'draft'
    constraint email_campaigns_status check (status in ('draft', 'active', 'paused', 'done', 'archived')),
  send_mode text not null default 'dry_run' constraint email_campaigns_send_mode check (send_mode in ('dry_run', 'real')),
  mailbox_id uuid references public.mailboxes (id) on delete set null,
  step2_delay_days integer not null default 3 constraint email_campaigns_step2 check (step2_delay_days between 1 and 30),
  step3_delay_days integer not null default 7 constraint email_campaigns_step3 check (step3_delay_days between 2 and 60),
  real_enabled_by uuid references auth.users (id) on delete set null,
  real_enabled_at timestamptz,
  draft_locked_until timestamptz,
  draft_locked_by uuid,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_campaigns_step_order check (step3_delay_days > step2_delay_days)
);

create index if not exists email_campaigns_workspace_idx on public.email_campaigns (workspace_id, created_at desc);

create table if not exists public.email_prospects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  campaign_id uuid not null references public.email_campaigns (id) on delete cascade,
  candidate_id uuid references public.research_candidates (id) on delete set null,
  company_name text not null constraint email_prospects_company_len check (char_length(btrim(company_name)) between 1 and 200),
  contact_name text constraint email_prospects_contact_name check (char_length(contact_name) <= 120 and contact_name !~ '[\r\n]'),
  contact_title text constraint email_prospects_contact_title check (char_length(contact_title) <= 120 and contact_title !~ '[\r\n]'),
  email text constraint email_prospects_email check (email is null or public.is_email_address(email)),
  email_source text constraint email_prospects_email_source check (email_source in ('research', 'manual')),
  email_source_url text constraint email_prospects_email_source_url check (public.is_safe_url(email_source_url)),
  -- who typed or confirmed a 'manual' address (stamped by the trigger from the session)
  email_confirmed_by uuid,
  -- R18: an address the research saw without an evidence excerpt that contains it. Never sendable as is: a
  -- person confirms it (it then becomes the 'manual' email above) or types another one.
  suggested_email text constraint email_prospects_suggested_email check (suggested_email is null or public.is_email_address(suggested_email)),
  suggested_email_url text constraint email_prospects_suggested_email_url check (public.is_safe_url(suggested_email_url)),
  website text constraint email_prospects_website check (public.is_safe_url(website)),
  hook text constraint email_prospects_hook_len check (char_length(hook) <= 400),
  evidence jsonb not null default '[]'::jsonb
    constraint email_prospects_evidence check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) <= 12),
  status text not null default 'active'
    constraint email_prospects_status check (status in ('active', 'skipped', 'replied', 'stopped', 'done', 'handed_off')),
  stop_reason text constraint email_prospects_stop_reason check (
    stop_reason in ('unsubscribed', 'bounced', 'suppressed', 'asked_to_stop', 'replied')
  ),
  -- one per prospect, 2 x gen_random_uuid() = 244 random bits, 64 hex characters
  unsub_token text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
    constraint email_prospects_unsub_token check (unsub_token ~ '^[0-9a-f]{64}$'),
  replied_at timestamptz,
  handed_off_at timestamptz,
  handed_off_by uuid references auth.users (id) on delete set null,
  closer_brief jsonb constraint email_prospects_closer_brief check (public.is_closer_brief(closer_brief)),
  closer_brief_at timestamptz,
  created_at timestamptz not null default now(),
  -- R18: no invented addresses. A research address carries its source URL; anything typed is 'manual'.
  constraint email_prospects_r18 check (
    (email is null and email_source is null and email_source_url is null)
    or (email is not null and email_source = 'manual')
    or (email is not null and email_source = 'research' and email_source_url is not null)
  ),
  constraint email_prospects_unique_candidate unique (campaign_id, candidate_id),
  constraint email_prospects_unique_token unique (unsub_token)
);

create index if not exists email_prospects_campaign_idx on public.email_prospects (campaign_id, created_at);
create index if not exists email_prospects_email_idx on public.email_prospects (workspace_id, email);

create table if not exists public.email_replies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  mailbox_id uuid references public.mailboxes (id) on delete set null,
  campaign_id uuid references public.email_campaigns (id) on delete set null,
  prospect_id uuid references public.email_prospects (id) on delete cascade,
  message_id uuid,
  from_address text not null constraint email_replies_from_len check (char_length(from_address) <= 254),
  subject text not null default '' constraint email_replies_subject_len check (char_length(subject) <= 300),
  body_text text not null default '' constraint email_replies_body_len check (char_length(body_text) <= 20000),
  received_at timestamptz not null,
  rfc_message_id text not null constraint email_replies_rfc_len check (char_length(rfc_message_id) between 1 and 500),
  is_bounce boolean not null default false,
  -- a delivery report that names an address we mailed but not our Message-ID: a person confirms it or not
  possible_bounce boolean not null default false,
  bounced_address text constraint email_replies_bounced_len check (char_length(bounced_address) <= 254),
  bounce_confirmed_by uuid,
  classification text constraint email_replies_class check (
    classification in ('interested', 'not_now', 'not_interested', 'unsubscribe', 'out_of_office', 'wrong_person', 'other')
  ),
  class_source text constraint email_replies_class_source check (class_source in ('ai', 'human')),
  class_reason text constraint email_replies_class_reason_len check (char_length(class_reason) <= 300),
  class_model text constraint email_replies_class_model_len check (char_length(class_model) <= 60),
  created_at timestamptz not null default now(),
  constraint email_replies_unique unique (workspace_id, rfc_message_id),
  constraint email_replies_bounce_kind check (not (is_bounce and possible_bounce))
);

create index if not exists email_replies_workspace_idx on public.email_replies (workspace_id, received_at desc);

create table if not exists public.email_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  campaign_id uuid not null references public.email_campaigns (id) on delete cascade,
  prospect_id uuid not null references public.email_prospects (id) on delete cascade,
  kind text not null constraint email_messages_kind check (kind in ('sequence', 'reply')),
  step smallint,
  reply_to_id uuid references public.email_replies (id) on delete cascade,
  subject text not null constraint email_messages_subject check (char_length(btrim(subject)) between 1 and 150 and subject !~ '[\r\n]'),
  body text not null constraint email_messages_body_len check (char_length(btrim(body)) between 1 and 5000),
  ai_drafted boolean not null default false,
  ai_model text constraint email_messages_ai_model_len check (char_length(ai_model) <= 60),
  prompt_version text constraint email_messages_prompt_version_len check (char_length(prompt_version) <= 40),
  -- what the AI said it used (shown to the reviewer; never sent): short fact strings, or "no specific fact"
  ai_facts jsonb not null default '[]'::jsonb
    constraint email_messages_ai_facts check (jsonb_typeof(ai_facts) = 'array' and jsonb_array_length(ai_facts) <= 8),
  ai_no_fact boolean,
  human_edited boolean not null default false,
  status text not null default 'draft' constraint email_messages_status check (
    status in ('draft', 'approved', 'rejected', 'sending', 'sent', 'dry_run', 'failed', 'cancelled')
  ),
  -- approval stamp (R1). No FK on purpose: an audit value that must survive the user's deletion.
  approved_by uuid,
  approved_at timestamptz,
  -- the recipient address the person approved, and the digest of the subject/body they saw (R1)
  approved_to text,
  approved_digest text,
  due_at timestamptz,
  cancel_reason text constraint email_messages_cancel_reason_len check (char_length(cancel_reason) <= 40),
  mailbox_id uuid references public.mailboxes (id) on delete set null,
  from_address text,
  to_address text,
  send_mode text constraint email_messages_send_mode check (send_mode in ('dry_run', 'real')),
  claimed_at timestamptz,
  claimed_by uuid,
  claim_holder uuid,
  claim_expires_at timestamptz,
  next_gap_seconds integer constraint email_messages_gap check (next_gap_seconds between 60 and 180),
  rfc_message_id text constraint email_messages_rfc_unique unique,
  in_reply_to text constraint email_messages_in_reply_to_len check (char_length(in_reply_to) <= 500),
  sent_at timestamptz,
  error text constraint email_messages_error_len check (char_length(error) <= 300),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_messages_step check (
    (kind = 'sequence' and step between 1 and 3) or (kind = 'reply' and step is null and reply_to_id is not null)
  ),
  -- R1: anything that left (or is leaving) carries an approval stamp
  constraint email_messages_r1 check (
    status not in ('approved', 'sending', 'sent', 'dry_run') or (approved_by is not null and approved_at is not null)
  ),
  -- R1: what leaves goes to the address that was approved, never another one
  constraint email_messages_r1_address check (
    status not in ('sending', 'sent', 'dry_run') or (approved_to is not null and to_address = approved_to)
  ),
  -- R4: no fake "Re:" / "Fwd:" on cold e-mail (a real reply may say "Re:")
  constraint email_messages_r4_subject check (
    kind = 'reply' or subject !~* '^\s*[\[(]?\s*(re|fw|fwd|aw|tr|sv|vs)\s*(\[\d+\])?\s*[:\])]'
  ),
  -- R12: no links in a sequence body; the footer adds the unsubscribe link at send time
  constraint email_messages_r12_links check (kind = 'reply' or body !~* '(https?://|www\.)')
);

-- R9: the same sequence step exists once per prospect
create unique index if not exists email_messages_one_step on public.email_messages (prospect_id, step) where kind = 'sequence';
create index if not exists email_messages_campaign_idx on public.email_messages (campaign_id, status, due_at);
create index if not exists email_messages_from_idx on public.email_messages (workspace_id, from_address, send_mode, claimed_at);

-- Approval audit. No foreign key to the message on purpose: it must outlive the message (never cascade-deleted).
create table if not exists public.email_approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  message_id uuid not null,
  user_id uuid,
  action text not null constraint email_approvals_action check (action in ('approve', 'reject', 'unapprove')),
  approved_to text constraint email_approvals_to_len check (char_length(approved_to) <= 254),
  created_at timestamptz not null default now()
);

create index if not exists email_approvals_message_idx on public.email_approvals (message_id);

-- Every claim ever made (one row per attempt), append-only: rows are inserted by the definer functions, their
-- result is written once, nothing is ever deleted. No foreign keys on purpose: deleting a mailbox, campaign or
-- even the workspace never resets the R2 counters (counted by sending address, across workspaces) and never
-- breaks the unsubscribe links already mailed. Clients may read their workspace's rows; they write nothing.
create table if not exists public.email_send_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  campaign_id uuid,
  prospect_id uuid,
  message_id uuid,
  mailbox_address text not null constraint email_send_log_from check (public.is_email_address(mailbox_address)),
  mode text not null constraint email_send_log_mode check (mode in ('dry_run', 'real', 'test')),
  to_address text not null constraint email_send_log_to check (public.is_email_address(to_address)),
  unsub_token text constraint email_send_log_token check (unsub_token ~ '^[0-9a-f]{64}$'),
  claimed_by uuid,
  holder uuid,
  claimed_at timestamptz not null default now(),
  gap_seconds integer constraint email_send_log_gap check (gap_seconds between 60 and 180),
  result text not null default 'pending'
    constraint email_send_log_result check (result in ('pending', 'sent', 'dry_run', 'failed', 'unknown')),
  smtp_message_id text constraint email_send_log_smtp_id_len check (char_length(smtp_message_id) <= 500),
  error text constraint email_send_log_error_len check (char_length(error) <= 300),
  finished_at timestamptz
);

create index if not exists email_send_log_address_idx on public.email_send_log (mailbox_address, mode, claimed_at desc);
create index if not exists email_send_log_token_idx on public.email_send_log (unsub_token) where unsub_token is not null;
create index if not exists email_send_log_workspace_idx on public.email_send_log (workspace_id, claimed_at desc);
create index if not exists email_send_log_campaign_idx on public.email_send_log (campaign_id);
create index if not exists email_send_log_message_idx on public.email_send_log (message_id);

-- Unsubscribe tokens that were mailed. Survives the campaign and the prospect (prospect_id becomes null), so a
-- link already in someone's inbox always works. No client grants at all: only unsubscribe_by_token() reads it.
create table if not exists public.email_unsub_tokens (
  token text primary key constraint email_unsub_tokens_token check (token ~ '^[0-9a-f]{64}$'),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  prospect_id uuid references public.email_prospects (id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- more helpers (need the tables)
create or replace function public.mailbox_in_workspace(p_mailbox uuid, p_ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_mailbox is null or exists (select 1 from public.mailboxes b where b.id = p_mailbox and b.workspace_id = p_ws);
$$;

create or replace function public.list_in_workspace(p_list uuid, p_ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_list is null or exists (select 1 from public.research_lists l where l.id = p_list and l.workspace_id = p_ws);
$$;

-- Address or its domain (or a parent domain) is suppressed in this workspace. Internal: called by definer code.
create or replace function public.is_suppressed(p_ws uuid, p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.suppressions s
    where s.workspace_id = p_ws
      and (
        (s.kind = 'address' and s.value = lower(p_email))
        or (s.kind = 'domain' and (
              split_part(lower(p_email), '@', 2) = s.value
              or split_part(lower(p_email), '@', 2) like '%.' || s.value))
      )
  );
$$;

create or replace function public.sender_profile_complete(p_ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.sender_profiles s
    where s.workspace_id = p_ws
      and char_length(btrim(s.legal_name)) >= 2
      and char_length(btrim(s.postal_address)) >= 10
      and char_length(btrim(s.sender_name)) >= 2
  );
$$;

-- Stops what is still waiting for a prospect (used on reply, unsubscribe, bounce, hand-off).
create or replace function public.cancel_pending_steps(p_prospect uuid, p_reason text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.email_messages m
     set status = 'cancelled', cancel_reason = p_reason, updated_at = now()
   where m.prospect_id = p_prospect and m.kind = 'sequence' and m.status in ('draft', 'approved', 'rejected');
$$;

-- Where our answer to a reply goes: the reply's sender when it is the prospect's own address or an address of the
-- prospect's domain; otherwise the prospect's address. Internal (definer callers only; mirrored in replies.ts).
create or replace function public.reply_target_address(p_reply uuid, p_prospect_email text)
returns text
language sql
stable
set search_path = ''
as $$
  -- On a shared free-mail domain only the prospect's own address counts (a stranger on gmail.com is not them).
  select case
           when r.from_address is not null and public.is_email_address(r.from_address) and p_prospect_email is not null
                and (r.from_address = p_prospect_email
                     or (split_part(r.from_address, '@', 2) = split_part(p_prospect_email, '@', 2)
                         and split_part(p_prospect_email, '@', 2) not in (
                           'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
                           'aol.com', 'icloud.com', 'me.com', 'comcast.net', 'verizon.net', 'proton.me', 'protonmail.com')))
             then r.from_address
           else p_prospect_email
         end
    from (select (select x.from_address from public.email_replies x where x.id = p_reply) as from_address) r;
$$;

-- The address each message of a prospect is meant for (sequence: the prospect's address; reply: see above).
create or replace function public.message_target(p_kind text, p_reply uuid, p_prospect_email text)
returns text
language sql
stable
set search_path = ''
as $$
  select case when p_kind = 'sequence' then p_prospect_email else public.reply_target_address(p_reply, p_prospect_email) end;
$$;

-- Claims from one sending address in a window, per mode, across every workspace (R2). Internal: only definer
-- functions call it; clients see the resulting numbers through mailbox_usage().
create or replace function public.address_claims_since(p_address text, p_mode text, p_since timestamptz)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer from public.email_send_log l
   where l.mailbox_address = lower(p_address) and l.mode = p_mode and l.claimed_at > p_since;
$$;

-- R1/R18: the approvals of a prospect's messages stop counting when its address changes (called by the prospect
-- trigger, as the person who changed it). Only the safe direction: approved -> draft, logged as 'unapprove'.
create or replace function public.reset_prospect_approvals(p_prospect uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  n integer;
begin
  select p.workspace_id into v_ws from public.email_prospects p where p.id = p_prospect;
  if v_ws is null or not public.is_workspace_sender(v_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  with r as (
    update public.email_messages m
       set status = 'draft', approved_by = null, approved_at = null, approved_to = null, approved_digest = null
     where m.prospect_id = p_prospect and m.status = 'approved'
    returning m.id, m.workspace_id
  )
  insert into public.email_approvals (workspace_id, message_id, user_id, action)
  select r.workspace_id, r.id, auth.uid(), 'unapprove' from r;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------- triggers
create or replace function public.touch_sender_profile()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;

create or replace function public.stamp_suppression()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.value := lower(btrim(new.value));
  new.created_at := now();
  if public.is_client_role() then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

create or replace function public.guard_email_campaign()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  ok boolean;
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    new.updated_at := now();
    new.status := 'draft';
    new.send_mode := 'dry_run';
    new.real_enabled_by := null;
    new.real_enabled_at := null;
    new.draft_locked_until := null;
    new.draft_locked_by := null;
    return new;
  end if;
  new.updated_at := now();
  if new.status is distinct from old.status then
    -- 'archived' replaces deletion once anything was claimed; it is final (answers to replies still go out).
    ok := case old.status
      when 'draft' then new.status in ('active', 'done', 'archived')
      when 'active' then new.status in ('paused', 'done', 'archived')
      when 'paused' then new.status in ('active', 'done', 'archived')
      when 'done' then new.status in ('active', 'archived')
      else false
    end;
    if not ok then
      raise exception 'invalid campaign status change: % -> %', old.status, new.status using errcode = '23514';
    end if;
  end if;
  -- a different mailbox has not been checked for real sending: back to rehearsal
  if new.mailbox_id is distinct from old.mailbox_id and old.send_mode = 'real' then
    new.send_mode := 'dry_run';
    new.real_enabled_by := null;
    new.real_enabled_at := null;
  end if;
  return new;
end;
$$;

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

-- A campaign that has claimed anything (rehearsal included) keeps its history: archive it, never delete it.
create or replace function public.guard_email_campaign_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.email_send_log l where l.campaign_id = old.id)
     or exists (
       select 1 from public.email_messages m
        where m.campaign_id = old.id and (m.claimed_at is not null or m.status in ('sending', 'sent', 'dry_run', 'failed'))
     )
  then
    raise exception 'this campaign already has sends: archive it instead of deleting it' using errcode = '55000';
  end if;
  return old;
end;
$$;

-- email_send_log is append-only: a row's result is written once (pending -> final); nothing else changes and
-- nothing is ever deleted.
create or replace function public.guard_email_send_log()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'the send log is append-only' using errcode = '42501';
  end if;
  if old.result <> 'pending'
     or (new.id, new.workspace_id, new.campaign_id, new.prospect_id, new.message_id, new.mailbox_address, new.mode,
         new.to_address, new.unsub_token, new.claimed_by, new.holder, new.claimed_at, new.gap_seconds, new.smtp_message_id)
        is distinct from
        (old.id, old.workspace_id, old.campaign_id, old.prospect_id, old.message_id, old.mailbox_address, old.mode,
         old.to_address, old.unsub_token, old.claimed_by, old.holder, old.claimed_at, old.gap_seconds, old.smtp_message_id)
  then
    raise exception 'the send log is append-only' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Not SECURITY DEFINER on purpose: it must see the caller's role (is_client_role) to tell a person's edit apart
-- from a state change made by the definer functions.
create or replace function public.guard_email_message()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_ws uuid;
  v_campaign uuid;
  v_reply record;
begin
  if tg_op = 'INSERT' then
    select p.workspace_id, p.campaign_id into v_ws, v_campaign from public.email_prospects p where p.id = new.prospect_id;
    if v_ws is null or v_ws <> new.workspace_id or v_campaign <> new.campaign_id then
      raise exception 'prospect not in this campaign' using errcode = '42501';
    end if;
    new.created_at := now();
    -- millisecond precision: the screen sends this value back with an approval (R1), and browsers keep ms only
    new.updated_at := date_trunc('milliseconds', clock_timestamp());
    new.created_by := auth.uid();
    new.status := 'draft';
    new.approved_by := null;
    new.approved_at := null;
    new.approved_to := null;
    new.approved_digest := null;
    new.cancel_reason := null;
    new.mailbox_id := null;
    new.from_address := null;
    new.to_address := null;
    new.send_mode := null;
    new.claimed_at := null;
    new.claimed_by := null;
    new.claim_holder := null;
    new.claim_expires_at := null;
    new.next_gap_seconds := null;
    new.rfc_message_id := null;
    new.sent_at := null;
    new.error := null;
    new.human_edited := not new.ai_drafted;
    if new.kind = 'reply' then
      select r.workspace_id, r.prospect_id, r.rfc_message_id into v_reply from public.email_replies r where r.id = new.reply_to_id;
      if v_reply.workspace_id is null or v_reply.workspace_id <> new.workspace_id or v_reply.prospect_id <> new.prospect_id then
        raise exception 'reply not in this workspace' using errcode = '42501';
      end if;
      new.in_reply_to := v_reply.rfc_message_id;
      new.due_at := now();
    else
      new.in_reply_to := null;
      new.due_at := case when new.step = 1 then now() else null end;
    end if;
    return new;
  end if;

  -- UPDATE. clock_timestamp(): two changes inside one transaction still get different versions.
  new.updated_at := greatest(date_trunc('milliseconds', clock_timestamp()), old.updated_at + interval '1 millisecond');
  if public.is_client_role() and (new.subject is distinct from old.subject or new.body is distinct from old.body) then
    if old.status in ('sending', 'sent', 'dry_run', 'failed', 'cancelled') then
      raise exception 'a message that was sent or cancelled cannot be edited' using errcode = '42501';
    end if;
    new.human_edited := true;
    if old.status = 'approved' then
      -- R1: editing clears the approval; it must be approved again
      new.status := 'draft';
      new.approved_by := null;
      new.approved_at := null;
      new.approved_to := null;
      new.approved_digest := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists touch_sender_profile on public.sender_profiles;
create trigger touch_sender_profile before insert or update on public.sender_profiles
  for each row execute function public.touch_sender_profile();

drop trigger if exists stamp_suppression on public.suppressions;
create trigger stamp_suppression before insert on public.suppressions
  for each row execute function public.stamp_suppression();

drop trigger if exists guard_email_campaign on public.email_campaigns;
create trigger guard_email_campaign before insert or update on public.email_campaigns
  for each row execute function public.guard_email_campaign();

drop trigger if exists guard_email_prospect on public.email_prospects;
create trigger guard_email_prospect before insert or update on public.email_prospects
  for each row execute function public.guard_email_prospect();

drop trigger if exists guard_email_message on public.email_messages;
create trigger guard_email_message before insert or update on public.email_messages
  for each row execute function public.guard_email_message();

drop trigger if exists guard_email_campaign_delete on public.email_campaigns;
create trigger guard_email_campaign_delete before delete on public.email_campaigns
  for each row execute function public.guard_email_campaign_delete();

drop trigger if exists guard_email_send_log on public.email_send_log;
create trigger guard_email_send_log before update or delete on public.email_send_log
  for each row execute function public.guard_email_send_log();

-- ---------------------------------------------------------------- RPCs: mailboxes
-- Creates or replaces a mailbox's app password (ciphertext made by the server). Back to 'unverified'.
create or replace function public.save_mailbox(p_workspace uuid, p_email text, p_ciphertext text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null or not public.is_workspace_sender(p_workspace) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into public.mailboxes (workspace_id, email, secret_ciphertext, created_by)
  values (p_workspace, lower(btrim(p_email)), p_ciphertext, auth.uid())
  on conflict (workspace_id, email) do update
    set secret_ciphertext = excluded.secret_ciphertext, status = 'unverified', last_error = null, verified_at = null
  returning id into v_id;
  return v_id;
end;
$$;

-- The ciphertext, for the server to decrypt in memory (owners and SDRs of that workspace only). Note: an owner or
-- SDR can therefore obtain the CIPHERTEXT by calling this RPC directly; it stays useless without the server-only
-- key (MAILBOX_ENC_KEY), and the AES-GCM additional data binds it to this workspace and address.
create or replace function public.mailbox_secret(p_mailbox uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  v_ct text;
begin
  select b.workspace_id, b.secret_ciphertext into v_ws, v_ct from public.mailboxes b where b.id = p_mailbox;
  if v_ws is null or not public.is_workspace_sender(v_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return v_ct;
end;
$$;

create or replace function public.set_mailbox_verified(p_mailbox uuid, p_ok boolean, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  select b.workspace_id into v_ws from public.mailboxes b where b.id = p_mailbox;
  if v_ws is null or not public.is_workspace_sender(v_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.mailboxes b
     set status = case when p_ok then 'ok' else 'error' end,
         verified_at = case when p_ok then now() else null end,
         last_error = case when p_ok then null else left(coalesce(p_error, 'error'), 300) end
   where b.id = p_mailbox;
end;
$$;

-- Today's use of a mailbox's address (rolling 24 h, per mode, across workspaces: numbers only) and when the next
-- send is allowed. Counted from the append-only send log, so retries and deletions never lower it (R2).
create or replace function public.mailbox_usage(p_mailbox uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b record;
  v_since timestamptz := now() - interval '24 hours';
  v_next timestamptz;
begin
  select * into b from public.mailboxes where id = p_mailbox;
  if b.id is null or not public.is_workspace_member(b.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select max(l.claimed_at + make_interval(secs => l.gap_seconds)) into v_next
    from public.email_send_log l
   where l.mailbox_address = b.email and l.mode in ('real', 'dry_run') and l.claimed_at > now() - interval '1 hour';
  return jsonb_build_object(
    'real', public.address_claims_since(b.email, 'real', v_since),
    'dry_run', public.address_claims_since(b.email, 'dry_run', v_since),
    'test', public.address_claims_since(b.email, 'test', v_since),
    'limit', least(b.daily_limit, 50),
    'test_limit', 5,
    'next_at', case when v_next > now() then v_next end);
end;
$$;

-- "Enviar teste para mim": at most 5 per sending address per rolling 24 h, logged under its own mode ('test',
-- not counted in the prospect limit). Returns {outcome: claimed | test_limit, log_id?, wait_until?}.
create or replace function public.claim_test_email(p_mailbox uuid, p_to text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b record;
  v_oldest timestamptz;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select * into b from public.mailboxes where id = p_mailbox;
  if b.id is null or not public.is_workspace_sender(b.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not public.is_email_address(lower(btrim(coalesce(p_to, '')))) then
    raise exception 'invalid address' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('email-address:' || b.email, 0));
  if public.address_claims_since(b.email, 'test', now() - interval '24 hours') >= 5 then
    select min(l.claimed_at) into v_oldest from public.email_send_log l
     where l.mailbox_address = b.email and l.mode = 'test' and l.claimed_at > now() - interval '24 hours';
    return jsonb_build_object('outcome', 'test_limit', 'wait_until', v_oldest + interval '24 hours');
  end if;
  insert into public.email_send_log (workspace_id, mailbox_address, mode, to_address, claimed_by, holder)
  values (b.workspace_id, b.email, 'test', lower(btrim(p_to)), auth.uid(), gen_random_uuid())
  returning id into v_id;
  return jsonb_build_object('outcome', 'claimed', 'log_id', v_id);
end;
$$;

create or replace function public.finish_test_email(p_log uuid, p_ok boolean, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.email_send_log l
     set result = case when p_ok then 'sent' else 'failed' end,
         error = case when p_ok then null else left(coalesce(p_error, 'failed'), 300) end,
         finished_at = now()
   where l.id = p_log and l.mode = 'test' and l.result = 'pending' and l.claimed_by = auth.uid();
  if not found then
    raise exception 'not allowed' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------- RPCs: campaigns and prospects
-- Copies the kept companies of the campaign's list into prospects (P3: lists only hold kept candidates).
-- R18: the research address becomes the prospect's address only when an evidence excerpt of that company literally
-- contains it (source = that evidence URL). Any other published address is only a SUGGESTION: the prospect stays
-- "sem e-mail" until a person confirms it (it then becomes 'manual', stamped with who confirmed it).
create or replace function public.import_list_into_campaign(p_campaign uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record;
  n integer;
begin
  select * into c from public.email_campaigns where id = p_campaign;
  if c.id is null or not public.is_workspace_sender(c.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if c.list_id is null or not public.list_in_workspace(c.list_id, c.workspace_id) then
    raise exception 'list not found' using errcode = '42501';
  end if;
  insert into public.email_prospects (workspace_id, campaign_id, candidate_id, company_name, contact_name, contact_title,
                                      email, email_source, email_source_url, suggested_email, suggested_email_url,
                                      website, hook, evidence)
  select c.workspace_id, c.id, k.id, k.name,
         case when k.ask_for_name is not null and k.ask_for_name !~ '[\r\n]' then left(k.ask_for_name, 120) end,
         case when k.ask_for_title is not null and k.ask_for_title !~ '[\r\n]' then left(k.ask_for_title, 120) end,
         case when src.url is not null then src.email end,
         case when src.url is not null then 'research' end,
         src.url,
         case when src.url is null then src.email end,
         case when src.url is null and src.email is not null then coalesce(k.website, k.name_source_url) end,
         k.website,
         k.hook,
         ev.items
    from public.research_list_items li
    join public.research_candidates k on k.id = li.candidate_id and k.workspace_id = c.workspace_id
    cross join lateral (
      select a.email,
             case when a.email is null then null else (
               select e.url
                 from public.research_evidence e
                 join public.research_checks ch on ch.id = e.check_id
                where ch.candidate_id = k.id
                  and position(a.email in lower(e.excerpt)) > 0
                order by ch.pass, ch.created_at
                limit 1)
             end as url
        from (select case when public.is_email_address(lower(btrim(coalesce(k.public_email, ''))))
                          then lower(btrim(k.public_email)) end as email) a
    ) src
    cross join lateral (
      select coalesce(jsonb_agg(x.item), '[]'::jsonb) as items
        from (
          select jsonb_build_object('kind', ch.kind, 'url', e.url, 'title', e.title, 'excerpt', e.excerpt,
                                    'seen_at', e.seen_at) as item
            from public.research_checks ch
            join public.research_evidence e on e.check_id = ch.id
           where ch.candidate_id = k.id and ch.result = 'ok'
           order by ch.pass, ch.created_at
           limit 8
        ) x
    ) ev
   where li.list_id = c.list_id and li.workspace_id = c.workspace_id
  on conflict (campaign_id, candidate_id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- R4: switching to real sending is an explicit owner action, only with a verified mailbox and a full sender
-- profile. Going back to rehearsal is always allowed for owners and SDRs (the safe direction).
-- Rehearsal -> real resets the rehearsal trail of the campaign, so nothing goes out for real on the strength of a
-- rehearsal: 'dry_run' messages go back to 'approved' (only if their text and address are still exactly what was
-- approved; otherwise 'draft'), claim fields are cleared, due dates are recomputed from now (step 1 now, steps 2
-- and 3 only once step 1 really went out), and prospects that only rehearsal finished become active again.
create or replace function public.set_campaign_send_mode(p_campaign uuid, p_mode text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record;
begin
  select * into c from public.email_campaigns where id = p_campaign for update;
  if c.id is null or not public.is_workspace_sender(c.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_mode = 'dry_run' then
    update public.email_campaigns set send_mode = 'dry_run', real_enabled_by = null, real_enabled_at = null where id = c.id;
    return;
  end if;
  if p_mode <> 'real' then
    raise exception 'invalid mode' using errcode = '22023';
  end if;
  if c.send_mode = 'real' then
    return;
  end if;
  if c.status = 'archived' then
    raise exception 'an archived campaign does not send' using errcode = '55000';
  end if;
  if not public.is_workspace_owner(c.workspace_id) then
    raise exception 'R4: only an owner can turn on real sending' using errcode = '42501';
  end if;
  if not public.sender_profile_complete(c.workspace_id) then
    raise exception 'R4: legal name, postal address and sender name are required' using errcode = '23514';
  end if;
  if c.mailbox_id is null or not exists (
    select 1 from public.mailboxes b where b.id = c.mailbox_id and b.workspace_id = c.workspace_id and b.status = 'ok'
  ) then
    raise exception 'R4: a verified mailbox is required' using errcode = '23514';
  end if;
  if exists (select 1 from public.email_messages m where m.campaign_id = c.id and m.status = 'sending') then
    raise exception 'a send is in progress; try again in a minute' using errcode = '55000';
  end if;
  update public.email_campaigns
     set send_mode = 'real', real_enabled_by = auth.uid(), real_enabled_at = now()
   where id = c.id;

  -- the rehearsal trail: back to the queue (approval kept only if nothing changed since it was given)
  with t as (
    select x.id,
           (x.approved_by is not null and x.approved_at is not null and x.approved_to is not null
            and x.approved_digest = public.message_digest(x.subject, x.body)
            and x.approved_to = public.message_target(x.kind, x.reply_to_id, p.email)) as keep
      from public.email_messages x
      join public.email_prospects p on p.id = x.prospect_id
     where x.campaign_id = c.id and x.status = 'dry_run'
  ), upd as (
    update public.email_messages x
       set status = case when t.keep then 'approved' else 'draft' end,
           approved_by = case when t.keep then x.approved_by end,
           approved_at = case when t.keep then x.approved_at end,
           approved_to = case when t.keep then x.approved_to end,
           approved_digest = case when t.keep then x.approved_digest end,
           mailbox_id = null, from_address = null, to_address = null, send_mode = null, claimed_at = null,
           claimed_by = null, claim_holder = null, claim_expires_at = null, next_gap_seconds = null,
           rfc_message_id = null, sent_at = null, error = null
      from t
     where x.id = t.id
    returning x.id, x.workspace_id, t.keep
  )
  insert into public.email_approvals (workspace_id, message_id, user_id, action)
  select upd.workspace_id, upd.id, auth.uid(), 'unapprove' from upd where not upd.keep;

  update public.email_prospects p
     set status = 'active'
   where p.campaign_id = c.id and p.status = 'done'
     and not exists (
       select 1 from public.email_messages s
        where s.prospect_id = p.id and s.kind = 'sequence' and s.step = 3 and s.status = 'sent'
     );

  update public.email_messages x
     set due_at = case
           when x.kind = 'reply' or x.step = 1 then now()
           else (select greatest(now(), public.add_business_days(s1.sent_at, case x.step when 2 then c.step2_delay_days else c.step3_delay_days end))
                   from public.email_messages s1
                  where s1.prospect_id = x.prospect_id and s1.kind = 'sequence' and s1.step = 1 and s1.status = 'sent')
         end
   where x.campaign_id = c.id and x.status in ('draft', 'approved', 'rejected');
end;
$$;

-- Draft lease: one request at a time drafts a campaign (two open tabs never draft the same prospect twice).
create or replace function public.claim_campaign_draft(p_campaign uuid, p_holder uuid, p_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  update public.email_campaigns c
     set draft_locked_until = now() + make_interval(secs => least(greatest(coalesce(p_seconds, 60), 10), 900)),
         draft_locked_by = p_holder
   where c.id = p_campaign
     and public.is_workspace_sender(c.workspace_id)
     and (c.draft_locked_until is null or c.draft_locked_until < now() or c.draft_locked_by = p_holder);
  return found;
end;
$$;

create or replace function public.release_campaign_draft(p_campaign uuid, p_holder uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.email_campaigns c
     set draft_locked_until = null, draft_locked_by = null
   where c.id = p_campaign and c.draft_locked_by = p_holder and public.is_workspace_sender(c.workspace_id);
end;
$$;

-- ---------------------------------------------------------------- RPCs: approval (R1)
-- approve: draft/rejected -> approved, stamped with the caller, the clock, the recipient address and the digest of
-- the text, and logged. reject: draft/approved -> rejected. unapprove: approved -> draft. Owners and SDRs only.
-- Each id comes with the updated_at the person's screen showed (p_versions[i]); a row changed since is skipped,
-- so an approval always refers to the exact text that was on the screen.
-- Returns {done, changed, skipped}: done = changed state; changed = edited since it was shown; skipped = not in
-- a state this action applies to (or not found).
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

-- ---------------------------------------------------------------- RPCs: sending (R1, R2, R3, R4, R9)
-- Claims at most ONE due, approved message of a campaign for sending, atomically. Returns
-- {outcome, message_id?, wait_until?}. outcome: claimed | not_active | no_mailbox | mailbox_not_verified |
-- no_sender_profile | daily_limit | gap | nothing_due.
-- p_message (optional) claims that one approved answer to a reply ("Enviar resposta"), whatever the campaign
-- state (paused, done or archived), still under R1, R2, R3, R4 and the campaign's send mode.
create or replace function public.claim_next_email(p_campaign uuid, p_holder uuid, p_message uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record;
  b record;
  m record;
  v_limit integer;
  v_oldest timestamptz;
  v_last record;
  v_token text;
  v_rfc text;
  v_gap integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select * into c from public.email_campaigns where id = p_campaign;
  if c.id is null or not public.is_workspace_sender(c.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  -- A claim that never reported back (tab closed mid-send): its result is unknown. Never resent automatically
  -- (R9); a person checks the Gmail "Sent" folder and decides (retry_failed_email with confirmation).
  with stale as (
    update public.email_messages
       set status = 'failed', error = 'interrupted', claim_expires_at = null
     where workspace_id = c.workspace_id and status = 'sending' and claim_expires_at < now()
    returning id, claim_holder
  )
  update public.email_send_log l
     set result = 'unknown', error = 'interrupted', finished_at = now()
    from stale s
   where l.message_id = s.id and l.holder = s.claim_holder and l.result = 'pending';

  if p_message is null and c.status <> 'active' then
    return jsonb_build_object('outcome', 'not_active');
  end if;
  if c.mailbox_id is null then
    return jsonb_build_object('outcome', 'no_mailbox');
  end if;
  -- the row lock serializes every claim on this mailbox (two tabs, two campaigns); the advisory lock does the
  -- same for the same address connected in another workspace
  select * into b from public.mailboxes where id = c.mailbox_id and workspace_id = c.workspace_id for update;
  if b.id is null then
    return jsonb_build_object('outcome', 'no_mailbox');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('email-address:' || b.email, 0));
  if c.send_mode = 'real' and b.status <> 'ok' then
    return jsonb_build_object('outcome', 'mailbox_not_verified');
  end if;
  if not public.sender_profile_complete(c.workspace_id) then
    return jsonb_build_object('outcome', 'no_sender_profile');
  end if;

  -- R2: daily limit, rolling 24 h, counted from the append-only log by sending address, across workspaces
  -- (removing and re-adding a mailbox, retrying a failure or deleting a campaign never gives a slot back)
  v_limit := least(b.daily_limit, 50);
  if public.address_claims_since(b.email, c.send_mode, now() - interval '24 hours') >= v_limit then
    select min(l.claimed_at) into v_oldest from public.email_send_log l
     where l.mailbox_address = b.email and l.mode = c.send_mode and l.claimed_at > now() - interval '24 hours';
    return jsonb_build_object('outcome', 'daily_limit', 'wait_until', v_oldest + interval '24 hours');
  end if;
  -- R2: random 60-180 s gap after the previous claim from this address
  select l.claimed_at, l.gap_seconds into v_last
    from public.email_send_log l
   where l.mailbox_address = b.email and l.mode = c.send_mode
   order by l.claimed_at desc
   limit 1;
  if v_last.claimed_at is not null and v_last.claimed_at + make_interval(secs => v_last.gap_seconds) > now() then
    return jsonb_build_object('outcome', 'gap', 'wait_until', v_last.claimed_at + make_interval(secs => v_last.gap_seconds));
  end if;

  -- R3: waiting messages to suppressed addresses/domains are cancelled and their prospects stopped
  with hit as (
    select x.id, x.prospect_id
      from public.email_messages x
      join public.email_prospects p on p.id = x.prospect_id
     where x.campaign_id = c.id and x.status in ('draft', 'approved', 'rejected')
       and ((p.email is not null and public.is_suppressed(c.workspace_id, p.email))
            or (x.approved_to is not null and public.is_suppressed(c.workspace_id, x.approved_to)))
  ), stop_p as (
    update public.email_prospects p
       set status = 'stopped', stop_reason = coalesce(p.stop_reason, 'suppressed')
     where p.id in (select prospect_id from hit) and p.status in ('active', 'skipped', 'done')
  )
  update public.email_messages x
     set status = 'cancelled', cancel_reason = 'suppressed'
   where x.id in (select id from hit);

  select x.* into m
    from public.email_messages x
    join public.email_prospects p on p.id = x.prospect_id
   where x.campaign_id = c.id
     and (p_message is null or x.id = p_message)
     and x.status = 'approved' and x.approved_by is not null and x.approved_at is not null   -- R1
     and x.approved_to is not null
     and x.approved_to = public.message_target(x.kind, x.reply_to_id, p.email)               -- R1: approved address
     and x.due_at is not null and x.due_at <= now()
     and p.email is not null                                                                 -- R18
     and not public.is_suppressed(c.workspace_id, p.email)                                   -- R3
     and not public.is_suppressed(c.workspace_id, x.approved_to)
     and (
       (p_message is null and c.status = 'active' and x.kind = 'sequence' and p.status = 'active' and (
          x.step = 1 or exists (
            -- a follow-up needs the previous step really sent; a rehearsed step only counts in rehearsal
            select 1 from public.email_messages prev
             where prev.prospect_id = x.prospect_id and prev.kind = 'sequence' and prev.step = x.step - 1
               and (prev.status = 'sent' or (c.send_mode = 'dry_run' and prev.status = 'dry_run')))))
       or (x.kind = 'reply' and p.status in ('replied', 'handed_off'))
     )
   order by (x.kind = 'reply') desc, x.due_at, x.step
   limit 1
   for update of x skip locked;
  if m.id is null then
    return jsonb_build_object('outcome', 'nothing_due');
  end if;

  select p.unsub_token into v_token from public.email_prospects p where p.id = m.prospect_id;
  v_rfc := '<' || replace(gen_random_uuid()::text, '-', '') || '@' || split_part(b.email, '@', 2) || '>';
  v_gap := 60 + floor(random() * 121)::integer;
  update public.email_messages x
     set status = 'sending',
         mailbox_id = b.id,
         from_address = b.email,
         to_address = m.approved_to,
         send_mode = c.send_mode,
         claimed_at = now(),
         claimed_by = auth.uid(),
         claim_holder = p_holder,
         claim_expires_at = now() + interval '120 seconds',
         next_gap_seconds = v_gap,
         rfc_message_id = v_rfc
   where x.id = m.id;
  insert into public.email_send_log (workspace_id, campaign_id, prospect_id, message_id, mailbox_address, mode, to_address,
                                     unsub_token, claimed_by, holder, gap_seconds, smtp_message_id)
  values (c.workspace_id, c.id, m.prospect_id, m.id, b.email, c.send_mode, m.approved_to,
          v_token, auth.uid(), p_holder, v_gap, v_rfc);
  insert into public.email_unsub_tokens (token, workspace_id, prospect_id)
  values (v_token, c.workspace_id, m.prospect_id)
  on conflict (token) do nothing;
  return jsonb_build_object('outcome', 'claimed', 'message_id', m.id);
end;
$$;

-- Reports the result of a claimed message. A rehearsal claim can only end as 'dry_run' (never as 'sent'), a real
-- one only as 'sent'. Success of step 1 schedules steps 2 and 3 in business days.
create or replace function public.finish_email_send(p_message uuid, p_holder uuid, p_result text, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
  c record;
begin
  select * into m from public.email_messages where id = p_message for update;
  if m.id is null or not public.is_workspace_sender(m.workspace_id) then
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
  if m.step = 1 then
    update public.email_messages
       set due_at = public.add_business_days(now(), case step when 2 then c.step2_delay_days else c.step3_delay_days end)
     where prospect_id = m.prospect_id and kind = 'sequence' and step in (2, 3) and status in ('draft', 'approved', 'rejected');
  elsif m.step = 3 then
    update public.email_prospects set status = 'done' where id = m.prospect_id and status = 'active';
  end if;
end;
$$;

-- A failed message goes back to the queue only if it still carries its approval (a person presses "tentar de novo").
-- The attempt stays in email_send_log, so it still counts in the daily limit and the gap (R2). A REAL claim whose
-- result is unknown ('interrupted': the tab closed mid-send) may already be in the recipient's inbox: it is retried
-- only with p_confirmed_not_sent = true, after the person checked the Gmail "Sent" folder (R9). If the address
-- changed since the approval, the message goes back to 'draft' instead.
create or replace function public.retry_failed_email(p_message uuid, p_confirmed_not_sent boolean default false)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
  v_email text;
  v_keep boolean;
begin
  select * into m from public.email_messages where id = p_message for update;
  if m.id is null or not public.is_workspace_sender(m.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if m.status <> 'failed' or m.approved_by is null then
    raise exception 'only a failed, approved message can be retried' using errcode = '55000';
  end if;
  if m.error = 'interrupted' and m.send_mode = 'real' and not coalesce(p_confirmed_not_sent, false) then
    raise exception 'R9: confirm in the Sent folder that this message did not go out' using errcode = '55000';
  end if;
  select p.email into v_email from public.email_prospects p where p.id = m.prospect_id;
  v_keep := m.approved_to is not null
            and m.approved_to = public.message_target(m.kind, m.reply_to_id, v_email)
            and m.approved_digest = public.message_digest(m.subject, m.body);
  update public.email_messages
     set status = case when v_keep then 'approved' else 'draft' end,
         approved_by = case when v_keep then approved_by end,
         approved_at = case when v_keep then approved_at end,
         approved_to = case when v_keep then approved_to end,
         approved_digest = case when v_keep then approved_digest end,
         error = null, mailbox_id = null, from_address = null, to_address = null, send_mode = null,
         claimed_at = null, claimed_by = null, claim_holder = null, claim_expires_at = null, next_gap_seconds = null,
         rfc_message_id = null
   where id = m.id;
  if not v_keep then
    insert into public.email_approvals (workspace_id, message_id, user_id, action)
    values (m.workspace_id, m.id, auth.uid(), 'unapprove');
  end if;
  return case when v_keep then 'approved' else 'draft' end;
end;
$$;

-- ---------------------------------------------------------------- RPCs: replies, suppression, hand-off
-- The address that bounced, if it is one we really mailed for this prospect (send log); else the prospect's.
create or replace function public.bounced_address_for(p_prospect uuid, p_bounced text, p_fallback text)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select l.to_address from public.email_send_log l
      where l.prospect_id = p_prospect and l.mode <> 'test' and l.to_address = lower(btrim(coalesce(p_bounced, '')))
      limit 1),
    p_fallback);
$$;

-- A confirmed bounce: suppress the address, stop the prospect, cancel what is waiting (R3). Internal: called only
-- by the definer functions below (no grant to clients).
create or replace function public.apply_bounce(p_ws uuid, p_prospect uuid, p_address text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_address is not null and public.is_email_address(p_address) then
    insert into public.suppressions (workspace_id, kind, value, reason, note)
    values (p_ws, 'address', p_address, 'bounced', 'devolvido pelo servidor de e-mail')
    on conflict (workspace_id, kind, value) do nothing;
  end if;
  update public.email_prospects set status = 'stopped', stop_reason = 'bounced'
   where id = p_prospect and status in ('active', 'skipped', 'done');
  perform public.cancel_pending_steps(p_prospect, 'bounced');
end;
$$;

-- Stores one incoming message already matched to a prospect by the server (replies.ts). p_kind:
--   'reply'           a person answered: the prospect's remaining steps stop (R3, R5);
--   'bounce'          a delivery failure report that quotes OUR Message-ID and says failed / 5.x.x: suppress (R3);
--   'possible_bounce' a report that only names an address we mailed: stored for a person to confirm, no effect.
-- Returns the new reply id, or null when it was already stored.
create or replace function public.record_email_reply(
  p_prospect uuid,
  p_mailbox uuid,
  p_message uuid,
  p_from text,
  p_subject text,
  p_body text,
  p_rfc_id text,
  p_received_at timestamptz,
  p_kind text,
  p_bounced text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  p record;
  v_id uuid;
  v_bounced text;
begin
  select * into p from public.email_prospects where id = p_prospect;
  if p.id is null or not public.is_workspace_sender(p.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not public.mailbox_in_workspace(p_mailbox, p.workspace_id) then
    raise exception 'mailbox not in workspace' using errcode = '42501';
  end if;
  if p_kind not in ('reply', 'bounce', 'possible_bounce') then
    raise exception 'invalid kind' using errcode = '22023';
  end if;
  v_bounced := case when p_kind = 'reply' then null else public.bounced_address_for(p.id, p_bounced, p.email) end;
  insert into public.email_replies (workspace_id, mailbox_id, campaign_id, prospect_id, message_id, from_address, subject,
                                    body_text, received_at, rfc_message_id, is_bounce, possible_bounce, bounced_address)
  values (p.workspace_id, p_mailbox, p.campaign_id, p.id,
          (select x.id from public.email_messages x where x.id = p_message and x.prospect_id = p.id),
          left(lower(coalesce(p_from, '')), 254), left(coalesce(p_subject, ''), 300), left(coalesce(p_body, ''), 20000),
          coalesce(p_received_at, now()), left(p_rfc_id, 500), p_kind = 'bounce', p_kind = 'possible_bounce', v_bounced)
  on conflict (workspace_id, rfc_message_id) do nothing
  returning id into v_id;
  if v_id is null then
    return null;
  end if;
  if p_kind = 'bounce' then
    perform public.apply_bounce(p.workspace_id, p.id, v_bounced);
  elsif p_kind = 'reply' then
    update public.email_prospects set status = 'replied', stop_reason = 'replied', replied_at = coalesce(replied_at, now())
     where id = p.id and status in ('active', 'skipped', 'done');
    perform public.cancel_pending_steps(p.id, 'replied');
  end if;
  return v_id;
end;
$$;

-- "Possível devolução": a person confirms it (then it acts as a bounce) or dismisses it.
create or replace function public.confirm_possible_bounce(p_reply uuid, p_is_bounce boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_email text;
begin
  select * into r from public.email_replies where id = p_reply for update;
  if r.id is null or not public.is_workspace_sender(r.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not r.possible_bounce then
    return;
  end if;
  if p_is_bounce then
    update public.email_replies set possible_bounce = false, is_bounce = true, bounce_confirmed_by = auth.uid() where id = r.id;
    if r.prospect_id is not null then
      select p.email into v_email from public.email_prospects p where p.id = r.prospect_id;
      perform public.apply_bounce(r.workspace_id, r.prospect_id, coalesce(r.bounced_address, v_email));
    end if;
  else
    update public.email_replies
       set possible_bounce = false, classification = 'other', class_source = 'human',
           class_reason = 'não era devolução', bounce_confirmed_by = auth.uid()
     where id = r.id;
  end if;
end;
$$;

-- Label of a reply (AI suggestion or a person). 'unsubscribe' adds the address to suppressions (the safe
-- direction). Nothing here sends, approves or removes anything (R13).
create or replace function public.set_reply_class(p_reply uuid, p_class text, p_source text, p_reason text, p_model text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_email text;
begin
  select * into r from public.email_replies where id = p_reply;
  if r.id is null or not public.is_workspace_sender(r.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_source not in ('ai', 'human') then
    raise exception 'invalid source' using errcode = '22023';
  end if;
  update public.email_replies
     set classification = p_class, class_source = p_source, class_reason = left(p_reason, 300), class_model = left(p_model, 60)
   where id = r.id;
  if p_class = 'unsubscribe' and r.prospect_id is not null then
    -- the prospect's address and the address that asked (when it is a real address of theirs)
    select p.email into v_email from public.email_prospects p where p.id = r.prospect_id;
    insert into public.suppressions (workspace_id, kind, value, reason, note)
    select r.workspace_id, 'address', a.v, 'asked_to_stop', 'pediu para parar na resposta'
      from (select distinct v from unnest(array[v_email, case when not r.is_bounce and not r.possible_bounce then r.from_address end]) as v) a
     where a.v is not null and public.is_email_address(a.v)
    on conflict (workspace_id, kind, value) do nothing;
    update public.email_prospects set status = 'stopped', stop_reason = 'asked_to_stop'
     where id = r.prospect_id and status in ('active', 'skipped', 'replied', 'done');
    perform public.cancel_pending_steps(r.prospect_id, 'asked_to_stop');
    update public.email_messages set status = 'cancelled', cancel_reason = 'asked_to_stop'
     where prospect_id = r.prospect_id and kind = 'reply' and status in ('draft', 'approved', 'rejected');
  end if;
end;
$$;

-- "Passar pra closer": who and when come from the session and the clock.
create or replace function public.hand_off_prospect(p_prospect uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p record;
begin
  select * into p from public.email_prospects where id = p_prospect;
  if p.id is null or not public.is_workspace_sender(p.workspace_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p.status = 'handed_off' then
    return;
  end if;
  if p.status not in ('active', 'replied', 'done', 'skipped') then
    raise exception 'this prospect cannot be handed off' using errcode = '55000';
  end if;
  update public.email_prospects
     set status = 'handed_off', handed_off_at = now(), handed_off_by = auth.uid()
   where id = p.id;
  perform public.cancel_pending_steps(p.id, 'handed_off');
end;
$$;

-- Public unsubscribe (logged out, role anon). Keyed by the unguessable per-prospect token; returns only a boolean;
-- idempotent. Works after the campaign or the prospect was deleted or archived (email_unsub_tokens + send log).
-- Suppresses, in that workspace, EVERY address actually mailed with this token plus the prospect's current
-- address, and stops everything still waiting for the prospect.
create or replace function public.unsubscribe_by_token(p_token text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  v_prospect uuid;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  select t.workspace_id, t.prospect_id into v_ws, v_prospect from public.email_unsub_tokens t where t.token = p_token;
  if v_ws is null then
    -- a token that was never mailed (nobody outside the workspace has seen it): still honoured
    select p.workspace_id, p.id into v_ws, v_prospect from public.email_prospects p where p.unsub_token = p_token;
  end if;
  if v_ws is null then
    return false;
  end if;
  insert into public.suppressions (workspace_id, kind, value, reason, note)
  select v_ws, 'address', a.v, 'unsubscribed', 'link de descadastro'
    from (
      select l.to_address as v from public.email_send_log l where l.unsub_token = p_token and l.mode <> 'test'
      union
      select p.email from public.email_prospects p where p.id = v_prospect and p.email is not null
    ) a
   where public.is_email_address(a.v)
  on conflict (workspace_id, kind, value) do nothing;
  if v_prospect is not null then
    update public.email_prospects
       set status = case when status = 'handed_off' then status else 'stopped' end,
           stop_reason = 'unsubscribed'
     where id = v_prospect;
    perform public.cancel_pending_steps(v_prospect, 'unsubscribed');
    update public.email_messages set status = 'cancelled', cancel_reason = 'unsubscribed'
     where prospect_id = v_prospect and kind = 'reply' and status in ('draft', 'approved', 'rejected');
  end if;
  return true;
end;
$$;

-- The closer brief (AI suggestion) is written only here: shape checked (is_closer_brief), owners/SDRs only.
create or replace function public.save_closer_brief(p_prospect uuid, p_brief jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
begin
  select p.workspace_id into v_ws from public.email_prospects p where p.id = p_prospect;
  if v_ws is null or not public.is_workspace_sender(v_ws) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_brief is null or not public.is_closer_brief(p_brief) then
    raise exception 'invalid closer brief' using errcode = '22023';
  end if;
  update public.email_prospects set closer_brief = p_brief, closer_brief_at = now() where id = p_prospect;
end;
$$;

-- ---------------------------------------------------------------- privileges
revoke all on function public.is_workspace_sender(uuid) from public, anon;
revoke all on function public.is_client_role() from public, anon;
revoke all on function public.is_email_address(text) from public, anon;
revoke all on function public.add_business_days(timestamptz, integer) from public, anon;
revoke all on function public.message_digest(text, text) from public, anon;
revoke all on function public.is_closer_brief(jsonb) from public, anon;
revoke all on function public.mailbox_in_workspace(uuid, uuid) from public, anon;
revoke all on function public.list_in_workspace(uuid, uuid) from public, anon;
revoke all on function public.is_suppressed(uuid, text) from public, anon, authenticated;
revoke all on function public.sender_profile_complete(uuid) from public, anon;
revoke all on function public.cancel_pending_steps(uuid, text) from public, anon, authenticated;
revoke all on function public.reply_target_address(uuid, text) from public, anon, authenticated;
revoke all on function public.message_target(text, uuid, text) from public, anon, authenticated;
revoke all on function public.address_claims_since(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.reset_prospect_approvals(uuid) from public, anon;
revoke all on function public.bounced_address_for(uuid, text, text) from public, anon, authenticated;
revoke all on function public.apply_bounce(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.touch_sender_profile() from public, anon, authenticated;
revoke all on function public.stamp_suppression() from public, anon, authenticated;
revoke all on function public.guard_email_campaign() from public, anon, authenticated;
revoke all on function public.guard_email_campaign_delete() from public, anon, authenticated;
revoke all on function public.guard_email_prospect() from public, anon, authenticated;
revoke all on function public.guard_email_message() from public, anon, authenticated;
revoke all on function public.guard_email_send_log() from public, anon, authenticated;
revoke all on function public.save_mailbox(uuid, text, text) from public, anon;
revoke all on function public.mailbox_secret(uuid) from public, anon;
revoke all on function public.set_mailbox_verified(uuid, boolean, text) from public, anon;
revoke all on function public.mailbox_usage(uuid) from public, anon;
revoke all on function public.claim_test_email(uuid, text) from public, anon;
revoke all on function public.finish_test_email(uuid, boolean, text) from public, anon;
revoke all on function public.import_list_into_campaign(uuid) from public, anon;
revoke all on function public.set_campaign_send_mode(uuid, text) from public, anon;
revoke all on function public.claim_campaign_draft(uuid, uuid, integer) from public, anon;
revoke all on function public.release_campaign_draft(uuid, uuid) from public, anon;
revoke all on function public.set_email_approval(uuid[], timestamptz[], text) from public, anon;
revoke all on function public.claim_next_email(uuid, uuid, uuid) from public, anon;
revoke all on function public.finish_email_send(uuid, uuid, text, text) from public, anon;
revoke all on function public.retry_failed_email(uuid, boolean) from public, anon;
revoke all on function public.record_email_reply(uuid, uuid, uuid, text, text, text, text, timestamptz, text, text) from public, anon;
revoke all on function public.confirm_possible_bounce(uuid, boolean) from public, anon;
revoke all on function public.set_reply_class(uuid, text, text, text, text) from public, anon;
revoke all on function public.hand_off_prospect(uuid) from public, anon;
revoke all on function public.save_closer_brief(uuid, jsonb) from public, anon;
revoke all on function public.unsubscribe_by_token(text) from public;

grant execute on function public.is_workspace_sender(uuid) to authenticated;
grant execute on function public.is_client_role() to authenticated;
grant execute on function public.is_email_address(text) to authenticated;
grant execute on function public.add_business_days(timestamptz, integer) to authenticated;
grant execute on function public.message_digest(text, text) to authenticated;
grant execute on function public.is_closer_brief(jsonb) to authenticated;
grant execute on function public.mailbox_in_workspace(uuid, uuid) to authenticated;
grant execute on function public.list_in_workspace(uuid, uuid) to authenticated;
grant execute on function public.sender_profile_complete(uuid) to authenticated;
-- called by the prospect trigger as the person who changed the address (only ever drops approvals)
grant execute on function public.reset_prospect_approvals(uuid) to authenticated;
grant execute on function public.save_mailbox(uuid, text, text) to authenticated;
grant execute on function public.mailbox_secret(uuid) to authenticated;
grant execute on function public.set_mailbox_verified(uuid, boolean, text) to authenticated;
grant execute on function public.mailbox_usage(uuid) to authenticated;
grant execute on function public.claim_test_email(uuid, text) to authenticated;
grant execute on function public.finish_test_email(uuid, boolean, text) to authenticated;
grant execute on function public.import_list_into_campaign(uuid) to authenticated;
grant execute on function public.set_campaign_send_mode(uuid, text) to authenticated;
grant execute on function public.claim_campaign_draft(uuid, uuid, integer) to authenticated;
grant execute on function public.release_campaign_draft(uuid, uuid) to authenticated;
grant execute on function public.set_email_approval(uuid[], timestamptz[], text) to authenticated;
grant execute on function public.claim_next_email(uuid, uuid, uuid) to authenticated;
grant execute on function public.finish_email_send(uuid, uuid, text, text) to authenticated;
grant execute on function public.retry_failed_email(uuid, boolean) to authenticated;
grant execute on function public.record_email_reply(uuid, uuid, uuid, text, text, text, text, timestamptz, text, text) to authenticated;
grant execute on function public.confirm_possible_bounce(uuid, boolean) to authenticated;
grant execute on function public.set_reply_class(uuid, text, text, text, text) to authenticated;
grant execute on function public.hand_off_prospect(uuid) to authenticated;
grant execute on function public.save_closer_brief(uuid, jsonb) to authenticated;
grant execute on function public.unsubscribe_by_token(text) to anon, authenticated;

revoke all on table public.sender_profiles from public, anon, authenticated;
revoke all on table public.mailboxes from public, anon, authenticated;
revoke all on table public.suppressions from public, anon, authenticated;
revoke all on table public.email_campaigns from public, anon, authenticated;
revoke all on table public.email_prospects from public, anon, authenticated;
revoke all on table public.email_replies from public, anon, authenticated;
revoke all on table public.email_messages from public, anon, authenticated;
revoke all on table public.email_approvals from public, anon, authenticated;
revoke all on table public.email_send_log from public, anon, authenticated;
revoke all on table public.email_unsub_tokens from public, anon, authenticated;

grant select on table public.sender_profiles to authenticated;
grant insert (workspace_id, legal_name, postal_address, sender_name) on table public.sender_profiles to authenticated;
grant update (legal_name, postal_address, sender_name) on table public.sender_profiles to authenticated;

-- mailboxes: never the ciphertext; rows are created through save_mailbox(); status through set_mailbox_verified()
grant select (id, workspace_id, email, provider, status, last_error, verified_at, daily_limit, created_by, created_at)
  on table public.mailboxes to authenticated;
grant update (daily_limit) on table public.mailboxes to authenticated;
grant delete on table public.mailboxes to authenticated;

grant select, delete on table public.suppressions to authenticated;
grant insert (workspace_id, kind, value, reason, note) on table public.suppressions to authenticated;

-- campaigns: delete only while nothing was ever claimed (trigger); otherwise status 'archived'
grant select, delete on table public.email_campaigns to authenticated;
grant insert (workspace_id, list_id, name, mailbox_id, step2_delay_days, step3_delay_days) on table public.email_campaigns to authenticated;
grant update (name, status, mailbox_id, step2_delay_days, step3_delay_days) on table public.email_campaigns to authenticated;

-- prospects: created by import_list_into_campaign(); a person can fix contact fields, type or confirm an address
-- (becomes 'manual'), and skip/unskip. The closer brief is written only through save_closer_brief().
grant select on table public.email_prospects to authenticated;
grant update (contact_name, contact_title, email, status) on table public.email_prospects to authenticated;

grant select on table public.email_replies to authenticated;

-- messages: content only. Status, approval stamps, claim/lease and send fields belong to the definer functions.
grant select on table public.email_messages to authenticated;
grant insert (workspace_id, campaign_id, prospect_id, kind, step, reply_to_id, subject, body, ai_drafted, ai_model, prompt_version,
              ai_facts, ai_no_fact)
  on table public.email_messages to authenticated;
grant update (subject, body) on table public.email_messages to authenticated;

grant select on table public.email_approvals to authenticated;

-- the send log: read-only for members; written only by the definer functions; append-only (trigger)
grant select on table public.email_send_log to authenticated;

-- ---------------------------------------------------------------- row level security
alter table public.sender_profiles enable row level security;
alter table public.sender_profiles force row level security;
alter table public.mailboxes enable row level security;
alter table public.mailboxes force row level security;
alter table public.suppressions enable row level security;
alter table public.suppressions force row level security;
alter table public.email_campaigns enable row level security;
alter table public.email_campaigns force row level security;
alter table public.email_prospects enable row level security;
alter table public.email_prospects force row level security;
alter table public.email_replies enable row level security;
alter table public.email_replies force row level security;
alter table public.email_messages enable row level security;
alter table public.email_messages force row level security;
alter table public.email_approvals enable row level security;
alter table public.email_approvals force row level security;
alter table public.email_send_log enable row level security;
alter table public.email_send_log force row level security;
alter table public.email_unsub_tokens enable row level security;
alter table public.email_unsub_tokens force row level security;

drop policy if exists sender_profiles_select on public.sender_profiles;
create policy sender_profiles_select on public.sender_profiles
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists sender_profiles_insert on public.sender_profiles;
create policy sender_profiles_insert on public.sender_profiles
  for insert to authenticated with check (public.is_workspace_sender(workspace_id));
drop policy if exists sender_profiles_update on public.sender_profiles;
create policy sender_profiles_update on public.sender_profiles
  for update to authenticated
  using (public.is_workspace_sender(workspace_id))
  with check (public.is_workspace_sender(workspace_id));

drop policy if exists mailboxes_select on public.mailboxes;
create policy mailboxes_select on public.mailboxes
  for select to authenticated using (public.is_workspace_member(workspace_id));
-- changing the limit is an owner decision (R2)
drop policy if exists mailboxes_update on public.mailboxes;
create policy mailboxes_update on public.mailboxes
  for update to authenticated
  using (public.is_workspace_owner(workspace_id))
  with check (public.is_workspace_owner(workspace_id));
drop policy if exists mailboxes_delete on public.mailboxes;
create policy mailboxes_delete on public.mailboxes
  for delete to authenticated using (public.is_workspace_sender(workspace_id));

drop policy if exists suppressions_select on public.suppressions;
create policy suppressions_select on public.suppressions
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists suppressions_insert on public.suppressions;
create policy suppressions_insert on public.suppressions
  for insert to authenticated with check (public.is_workspace_member(workspace_id));
-- removing a suppression is owner-only
drop policy if exists suppressions_delete on public.suppressions;
create policy suppressions_delete on public.suppressions
  for delete to authenticated using (public.is_workspace_owner(workspace_id));

drop policy if exists email_campaigns_select on public.email_campaigns;
create policy email_campaigns_select on public.email_campaigns
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists email_campaigns_insert on public.email_campaigns;
create policy email_campaigns_insert on public.email_campaigns
  for insert to authenticated
  with check (
    public.is_workspace_sender(workspace_id)
    and public.mailbox_in_workspace(mailbox_id, workspace_id)
    and public.list_in_workspace(list_id, workspace_id)
  );
drop policy if exists email_campaigns_update on public.email_campaigns;
create policy email_campaigns_update on public.email_campaigns
  for update to authenticated
  using (public.is_workspace_sender(workspace_id))
  with check (public.is_workspace_sender(workspace_id) and public.mailbox_in_workspace(mailbox_id, workspace_id));
drop policy if exists email_campaigns_delete on public.email_campaigns;
create policy email_campaigns_delete on public.email_campaigns
  for delete to authenticated using (public.is_workspace_owner(workspace_id));

drop policy if exists email_prospects_select on public.email_prospects;
create policy email_prospects_select on public.email_prospects
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists email_prospects_update on public.email_prospects;
create policy email_prospects_update on public.email_prospects
  for update to authenticated
  using (public.is_workspace_sender(workspace_id))
  with check (public.is_workspace_sender(workspace_id));

drop policy if exists email_replies_select on public.email_replies;
create policy email_replies_select on public.email_replies
  for select to authenticated using (public.is_workspace_member(workspace_id));

drop policy if exists email_messages_select on public.email_messages;
create policy email_messages_select on public.email_messages
  for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists email_messages_insert on public.email_messages;
create policy email_messages_insert on public.email_messages
  for insert to authenticated with check (public.is_workspace_sender(workspace_id));
drop policy if exists email_messages_update on public.email_messages;
create policy email_messages_update on public.email_messages
  for update to authenticated
  using (public.is_workspace_sender(workspace_id))
  with check (public.is_workspace_sender(workspace_id));

drop policy if exists email_approvals_select on public.email_approvals;
create policy email_approvals_select on public.email_approvals
  for select to authenticated using (public.is_workspace_member(workspace_id));

drop policy if exists email_send_log_select on public.email_send_log;
create policy email_send_log_select on public.email_send_log
  for select to authenticated using (public.is_workspace_member(workspace_id));
-- email_unsub_tokens: no policy and no grant (only unsubscribe_by_token() reads it)
