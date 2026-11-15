-- 0017 closer scope (security fix round 2026-11-15).
--
-- Before: the e-mail SELECT policies (0003, 0007) used is_workspace_member, so a closer could read every prospect,
-- message, reply, approval and send-log row of her workspace, and the campaign plumbing (campaigns, mailboxes,
-- sender profiles, suppressions, campaign mailboxes) through PostgREST. She could also add suppressions.
--
-- After:
--   * owner/sdr (is_workspace_sender) read everything, as before.
--   * a closer reads an e-mail row only when its prospect belongs to a lead assigned to her. The one source of
--     truth for assignment is leads.owner_id; the link is email_prospects.candidate_id -> research_candidates.lead_id
--     (0009). A prospect without a candidate (typed by hand) has no lead and is never a closer's.
--   * campaigns, mailboxes, sender profiles, suppressions and campaign mailboxes: senders only. No closer screen
--     reads them (the closer page reads email_prospects only).
--   * suppressions: insert is senders only (delete stays owner-only, 0003).
--
-- Re-runnable: create or replace / drop policy if exists.

-- ---------------------------------------------------------------- helpers
-- True when prospect p_prospect is in workspace p_ws, belongs to a lead assigned to the caller, and the caller is
-- still a member of that workspace (a removed closer keeps owner_id on old leads but loses the e-mail rows).
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
      join public.research_candidates c on c.id = p.candidate_id and c.workspace_id = p.workspace_id
      join public.leads l on l.id = c.lead_id and l.workspace_id = p.workspace_id
     where p.id = p_prospect
       and p.workspace_id = p_ws
       and l.owner_id = auth.uid()
       and public.is_workspace_member(p_ws)
  );
$$;

-- Approvals carry only message_id (no foreign key): visible when that message's prospect is.
create or replace function public.message_visible_to_assignee(p_message uuid, p_ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.email_messages m
     where m.id = p_message
       and m.workspace_id = p_ws
       and public.prospect_visible_to_assignee(m.prospect_id, p_ws)
  );
$$;

revoke all on function public.prospect_visible_to_assignee(uuid, uuid) from public, anon;
revoke all on function public.message_visible_to_assignee(uuid, uuid) from public, anon;
grant execute on function public.prospect_visible_to_assignee(uuid, uuid) to authenticated;
grant execute on function public.message_visible_to_assignee(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- e-mail rows: sender, or the assigned closer
drop policy if exists email_prospects_select on public.email_prospects;
create policy email_prospects_select on public.email_prospects
  for select to authenticated
  using (public.is_workspace_sender(workspace_id) or public.prospect_visible_to_assignee(id, workspace_id));

drop policy if exists email_messages_select on public.email_messages;
create policy email_messages_select on public.email_messages
  for select to authenticated
  using (public.is_workspace_sender(workspace_id) or public.prospect_visible_to_assignee(prospect_id, workspace_id));

drop policy if exists email_replies_select on public.email_replies;
create policy email_replies_select on public.email_replies
  for select to authenticated
  using (public.is_workspace_sender(workspace_id) or public.prospect_visible_to_assignee(prospect_id, workspace_id));

drop policy if exists email_approvals_select on public.email_approvals;
create policy email_approvals_select on public.email_approvals
  for select to authenticated
  using (public.is_workspace_sender(workspace_id) or public.message_visible_to_assignee(message_id, workspace_id));

drop policy if exists email_send_log_select on public.email_send_log;
create policy email_send_log_select on public.email_send_log
  for select to authenticated
  using (public.is_workspace_sender(workspace_id) or public.prospect_visible_to_assignee(prospect_id, workspace_id));

-- ---------------------------------------------------------------- campaign plumbing: senders only
drop policy if exists email_campaigns_select on public.email_campaigns;
create policy email_campaigns_select on public.email_campaigns
  for select to authenticated using (public.is_workspace_sender(workspace_id));

drop policy if exists sender_profiles_select on public.sender_profiles;
create policy sender_profiles_select on public.sender_profiles
  for select to authenticated using (public.is_workspace_sender(workspace_id));

drop policy if exists mailboxes_select on public.mailboxes;
create policy mailboxes_select on public.mailboxes
  for select to authenticated using (public.is_workspace_sender(workspace_id));

drop policy if exists campaign_mailboxes_select on public.campaign_mailboxes;
create policy campaign_mailboxes_select on public.campaign_mailboxes
  for select to authenticated using (public.is_workspace_sender(workspace_id));

drop policy if exists suppressions_select on public.suppressions;
create policy suppressions_select on public.suppressions
  for select to authenticated using (public.is_workspace_sender(workspace_id));

drop policy if exists suppressions_insert on public.suppressions;
create policy suppressions_insert on public.suppressions
  for insert to authenticated with check (public.is_workspace_sender(workspace_id));

-- ---------------------------------------------------------------- removed members read nothing
-- leads.owner_id survives when a closer leaves the workspace. The assignee checks of 0009 (leads_select,
-- candidate/check visibility) and 0011 (lead_visible_to_assignee) now also require the caller to still be a member.
-- Bodies copied from 0009/0011 with only the membership check added.
drop policy if exists leads_select on public.leads;
create policy leads_select on public.leads
  for select to authenticated
  using (public.is_workspace_sender(workspace_id) or (owner_id = auth.uid() and public.is_workspace_member(workspace_id)));

create or replace function public.candidate_visible_to_assignee(p_candidate uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.research_candidates c
      join public.leads l on l.id = c.lead_id and l.workspace_id = c.workspace_id
     where c.id = p_candidate and l.owner_id = auth.uid()
       and public.is_workspace_member(c.workspace_id)
  );
$$;

create or replace function public.check_visible_to_assignee(p_check uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.research_checks k
      join public.research_candidates c on c.id = k.candidate_id
      join public.leads l on l.id = c.lead_id and l.workspace_id = c.workspace_id
     where k.id = p_check and l.owner_id = auth.uid()
       and public.is_workspace_member(c.workspace_id)
  );
$$;

create or replace function public.lead_visible_to_assignee(p_lead uuid, p_ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.leads l
     where l.id = p_lead and l.workspace_id = p_ws and l.owner_id = auth.uid()
       and public.is_workspace_member(p_ws)
  );
$$;
