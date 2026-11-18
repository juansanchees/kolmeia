-- 0038 Public waitlist (landing page): one table, one write-only RPC.
--   1 waitlist: email (unique, case-insensitive), locale, created_at. RLS on, NO policies: no client can read or
--       write it directly. The team reads it in the SQL editor as postgres.
--   2 join_waitlist(p_email, p_locale): SECURITY DEFINER, callable by anon and authenticated. Trims and
--       lower-cases, validates the e-mail shape and length (max 254), forces locale to 'pt' or 'en', inserts with
--       ON CONFLICT DO NOTHING and returns nothing, so the caller cannot tell a new e-mail from a known one.
-- Depends on nothing else. Re-runnable. One transaction: all or nothing. NOT APPLIED to any database yet.

begin;

create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null
    constraint waitlist_email_len check (char_length(email) between 3 and 254),
  locale text not null default 'pt'
    constraint waitlist_locale check (locale in ('pt', 'en')),
  created_at timestamptz not null default now()
);

create unique index if not exists waitlist_email_lower_key on public.waitlist (lower(email));

alter table public.waitlist enable row level security;
revoke all on table public.waitlist from public, anon, authenticated;

create or replace function public.join_waitlist(p_email text, p_locale text default 'pt')
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if char_length(v_email) not between 3 and 254
     or v_email !~ '^[a-z0-9._%+-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then
    raise exception 'invalid email' using errcode = '22023';
  end if;
  insert into public.waitlist (email, locale)
  values (v_email, case when p_locale = 'en' then 'en' else 'pt' end)
  on conflict (lower(email)) do nothing;
end;
$$;

revoke all on function public.join_waitlist(text, text) from public;
grant execute on function public.join_waitlist(text, text) to anon, authenticated;

commit;
