import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaskRow } from "./view";

/** Open tasks the user can see (RLS: senders all, the closer those of her leads), soonest first. */
export async function openTasks(db: SupabaseClient, workspaceId: string): Promise<TaskRow[]> {
  const { data, error } = await db
    .from("tasks")
    .select("id, lead_id, kind, title, due_at, done_at, assignee_id")
    .eq("workspace_id", workspaceId)
    .is("done_at", null)
    .order("due_at")
    .order("id")
    .limit(1000);
  if (error) throw new Error(`openTasks: ${error.message}`);
  return (data ?? []) as TaskRow[];
}

/** Every task (open or done) due in [from, to), for the Agenda; RLS decides what the user sees. */
export async function tasksBetween(db: SupabaseClient, workspaceId: string, from: string, to: string): Promise<TaskRow[]> {
  const { data, error } = await db
    .from("tasks")
    .select("id, lead_id, kind, title, due_at, done_at, assignee_id")
    .eq("workspace_id", workspaceId)
    .gte("due_at", from)
    .lt("due_at", to)
    .order("due_at")
    .order("id")
    .limit(2000);
  if (error) throw new Error(`tasksBetween: ${error.message}`);
  return (data ?? []) as TaskRow[];
}
