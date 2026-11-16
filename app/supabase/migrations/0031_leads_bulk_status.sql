-- 0031 LEADS: no archive (16/11 night). A finished lead is marked lost ("Perdido") or discarded ("Descartado") and
--   lands in the "Fechado" stage. set_leads_status does it for many leads at once from the selection bar.
--   * Sender-only (owner/sdr), at most 5000 ids, only this workspace's leads, only rows that actually change.
--   * Only open leads change (new, call_list, in_campaign, replied): never won, with_closer, meeting, lost or discarded.
--   * E-mail: nothing new here. The 0022 trigger stop_email_on_lead_block already fires on every status change and
--     lead_blocks_email (0021) already covers won, lost and discarded, so each changed lead's prospects are stopped and
--     their waiting sequence steps cancelled (discarded also cancels waiting answers).
--   * leads.archived_at and set_leads_archived (0030) stay in place, unused by the app.
-- Depends on 0001-0030. Re-runnable.

create or replace function public.set_leads_status(p_ws uuid, p_leads uuid[], p_status text)
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
  if p_status is null or p_status not in ('lost', 'discarded') then
    raise exception 'only lost or discarded' using errcode = '22023';
  end if;
  -- lock the leads in id order first, so two bulk changes never deadlock
  perform 1 from public.leads l
    where l.workspace_id = p_ws and l.id = any(p_leads)
    order by l.id
      for update;
  update public.leads l
     set status = p_status,
         updated_at = now()
   where l.workspace_id = p_ws
     and l.id = any(p_leads)
     and l.status in ('new', 'call_list', 'in_campaign', 'replied');
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.set_leads_status(uuid, uuid[], text) from public, anon;
grant execute on function public.set_leads_status(uuid, uuid[], text) to authenticated;
