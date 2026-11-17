-- 0037 Início: "Plano de hoje" (each user's own day plan) and the Agenda.
--   1 home_rules.plan: the user's day plan setup (block order, hidden blocks, how many per block, each block's
--       options). A small JSON object next to the "Ligar agora" rule (0035), validated by zod on read and write;
--       the rule column keeps working unchanged.
--   2 day_plan_marks: the items a user ticks "feito" by hand on the plan, per New York day. Own rows only.
--   3 tasks: kind 'meeting' (Reunião); members create tasks ("Marcar retorno ou reunião") on leads they can see:
--       owner/sdr on any lead of the workspace, assigned to any member (or nobody); the closer only on leads assigned
--       to her, and only for herself. A sender may give a task to a closer only on a lead assigned to that closer
--       (she would not see it otherwise). Created rows can set workspace_id, lead_id, kind, title, due_at,
--       assignee_id; done_at / created_from_call_id stay out of reach, updates keep the 0027 columns (done_at, due_at).
--   4 plan_call_stats(ws, since): one row per lead with calls: unanswered calls (no answer / voicemail), the newest
--       outcome, and whether the caller called it since `since` (the start of the New York day). Invoker: RLS on
--       call_logs decides (the closer gets her leads only). The plan reads this instead of every call row.
-- Depends on 0001-0036. Re-runnable. One transaction: all or nothing.

begin;

-- ---------------------------------------------------------------- 1 the plan
alter table public.home_rules add column if not exists plan jsonb not null default '{}'::jsonb;
alter table public.home_rules drop constraint if exists home_rules_plan;
alter table public.home_rules
  add constraint home_rules_plan check (jsonb_typeof(plan) = 'object' and pg_column_size(plan) <= 4000);
-- the app saves rule and plan together with an upsert (PostgREST also sets workspace_id on conflict, see 0036)
grant insert (workspace_id, rule, plan, updated_at) on table public.home_rules to authenticated;
grant update (workspace_id, rule, plan, updated_at) on table public.home_rules to authenticated;

-- ---------------------------------------------------------------- 2 manual ticks
create table if not exists public.day_plan_marks (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day date not null,
  item_key text not null
    constraint day_plan_marks_key check (char_length(item_key) between 1 and 120),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id, day, item_key)
);

revoke all on table public.day_plan_marks from public, anon, authenticated;
grant select, delete on table public.day_plan_marks to authenticated;
grant insert (workspace_id, day, item_key) on table public.day_plan_marks to authenticated;
alter table public.day_plan_marks enable row level security;
alter table public.day_plan_marks force row level security;
drop policy if exists day_plan_marks_own on public.day_plan_marks;
create policy day_plan_marks_own on public.day_plan_marks
  for all to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------- 3 meetings and new tasks
alter table public.tasks drop constraint if exists tasks_kind;
alter table public.tasks
  add constraint tasks_kind check (kind in ('call', 'email', 'follow_up', 'other', 'meeting'));

grant insert (workspace_id, lead_id, kind, title, due_at, assignee_id) on table public.tasks to authenticated;
drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks
  for insert to authenticated
  with check (
    (
      public.is_workspace_sender(workspace_id)
      -- the lead is this workspace's (read as the caller: RLS on leads applies)
      and exists (select 1 from public.leads l where l.id = tasks.lead_id and l.workspace_id = tasks.workspace_id)
      and (
        tasks.assignee_id is null
        or exists (
          select 1 from public.workspace_members m
           where m.workspace_id = tasks.workspace_id and m.user_id = tasks.assignee_id
             -- a closer only sees the leads assigned to her
             and (m.role <> 'closer'
                  or exists (select 1 from public.leads o where o.id = tasks.lead_id and o.owner_id = tasks.assignee_id))
        )
      )
    )
    or (public.lead_visible_to_assignee(lead_id, workspace_id) and tasks.assignee_id = auth.uid())
  );

-- ---------------------------------------------------------------- 4 call totals for the plan
create or replace function public.plan_call_stats(p_ws uuid, p_since timestamptz)
returns table (lead_id uuid, no_answer integer, last_outcome text, by_me_since boolean)
language sql
stable
security invoker
set search_path = ''
as $$
  select c.lead_id,
         (count(*) filter (where c.outcome in ('no_answer', 'voicemail')))::integer,
         (array_agg(c.outcome order by c.called_at desc, c.created_at desc, c.id desc))[1],
         coalesce(bool_or(c.called_by = auth.uid() and c.called_at >= p_since), false)
    from public.call_logs c
   where c.workspace_id = p_ws
   group by c.lead_id
   order by c.lead_id;
$$;
revoke all on function public.plan_call_stats(uuid, timestamptz) from public, anon;
grant execute on function public.plan_call_stats(uuid, timestamptz) to authenticated;

commit;
