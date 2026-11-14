import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSender, type Role } from "@/lib/roles";

export type CurrentWorkspace = { id: string; name: string; role: Role };

/** Signed-in user (verified by the Auth server), or null. */
export const getUser = cache(async () => {
  const supabase = await createClient();
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
});

/**
 * F0: a user's active workspace is their oldest membership (ties broken by workspace_id, so it is deterministic).
 * RLS limits the rows to workspaces they belong to; clients cannot insert or re-date member rows.
 * An explicit "active workspace" setting arrives together with invites.
 */
export const getCurrentWorkspace = cache(async (): Promise<CurrentWorkspace | null> => {
  const supabase = await createClient();
  const user = await getUser();
  if (!supabase || !user) return null;
  const { data } = await supabase
    .from("workspace_members")
    .select("role, created_at, workspaces(id, name)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .order("workspace_id", { ascending: true })
    .limit(1)
    .maybeSingle();
  const ws = data?.workspaces as { id: string; name: string } | { id: string; name: string }[] | null | undefined;
  const w = Array.isArray(ws) ? ws[0] : ws;
  if (!data || !w) return null;
  return { id: w.id, name: w.name, role: data.role as Role };
});

/** For sender-only screens and actions (agents, campaigns): no workspace or a closer is sent to LEADS. */
export async function requireSender(): Promise<CurrentWorkspace> {
  const workspace = await getCurrentWorkspace();
  if (!workspace || !isSender(workspace.role)) redirect("/leads");
  return workspace;
}
