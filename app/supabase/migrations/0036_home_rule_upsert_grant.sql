-- 0036: the app saves the rule with an upsert, so PostgREST's ON CONFLICT DO UPDATE also sets workspace_id, which needs its own update grant (0035 granted only rule, updated_at).
grant update (workspace_id, rule, updated_at) on table public.home_rules to authenticated;
