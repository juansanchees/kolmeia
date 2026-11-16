-- 0030 LEADS redesign: archive and manual segment.
--   * leads.archived_at: a lead leaves every tab and shows only under "Arquivados". Nothing else changes: status, level,
--     fields and list membership stay, so unarchiving puts it back exactly as it was.
--   * leads.segment: the sender's manual "Tipo" (residential | small | large). null = automatic (derived in the app).
--   * Writes only through set_leads_archived / set_leads_segment (sender-only, at most 5000 ids, only this workspace's
--     leads, only rows that actually change). Clients still have no UPDATE on leads.
-- Depends on 0001-0029. Re-runnable.

alter table public.leads
  add column if not exists archived_at timestamptz,
  add column if not exists segment text;

alter table public.leads drop constraint if exists leads_segment;
alter table public.leads
  add constraint leads_segment check (segment is null or segment in ('residential', 'small', 'large'));

create index if not exists leads_archived_idx on public.leads (workspace_id) where archived_at is not null;

create or replace function public.set_leads_archived(p_ws uuid, p_leads uuid[], p_archived boolean)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if auth.uid() is null or not public.is_workspace_sender(p_ws) then
    raise exception 'sender only' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_leads), 0) > 5000 then
    raise exception 'at most 5000 leads at a time' using errcode = '22023';
  end if;
  update public.leads l
     set archived_at = case when p_archived then now() else null end,
         updated_at = now()
   where l.workspace_id = p_ws
     and l.id = any(p_leads)
     and (l.archived_at is null) = coalesce(p_archived, false);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace function public.set_leads_segment(p_ws uuid, p_leads uuid[], p_segment text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if auth.uid() is null or not public.is_workspace_sender(p_ws) then
    raise exception 'sender only' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_leads), 0) > 5000 then
    raise exception 'at most 5000 leads at a time' using errcode = '22023';
  end if;
  if p_segment is not null and p_segment not in ('residential', 'small', 'large') then
    raise exception 'unknown segment' using errcode = '22023';
  end if;
  update public.leads l
     set segment = p_segment,
         updated_at = now()
   where l.workspace_id = p_ws
     and l.id = any(p_leads)
     and l.segment is distinct from p_segment;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.set_leads_archived(uuid, uuid[], boolean) from public, anon;
revoke all on function public.set_leads_segment(uuid, uuid[], text) from public, anon;
grant execute on function public.set_leads_archived(uuid, uuid[], boolean) to authenticated;
grant execute on function public.set_leads_segment(uuid, uuid[], text) to authenticated;
