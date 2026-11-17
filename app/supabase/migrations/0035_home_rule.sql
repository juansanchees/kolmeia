-- 0035 Home ("Início"): the "Ligar primeiro" rule, one per user and workspace (the SDR and the owner each keep their own).
-- The rule is a small JSON object (who enters + the order); the app validates it with zod on read and on write.
-- A user reads and writes only their own row, and only in a workspace they belong to.
create table if not exists public.home_rules (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  rule jsonb not null
    constraint home_rules_rule check (jsonb_typeof(rule) = 'object' and pg_column_size(rule) <= 2000),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

revoke all on table public.home_rules from public, anon, authenticated;
grant select on table public.home_rules to authenticated;
grant insert (workspace_id, rule, updated_at) on table public.home_rules to authenticated;
grant update (rule, updated_at) on table public.home_rules to authenticated;
alter table public.home_rules enable row level security;
alter table public.home_rules force row level security;
drop policy if exists home_rules_own on public.home_rules;
create policy home_rules_own on public.home_rules
  for all to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));
