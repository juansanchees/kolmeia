import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { realClockEnabled } from "@/lib/email/config";
import { DEFAULT_HOME_RULE, parseHomeRule, type HomeRule } from "./rule";

/** The user's own rule (RLS: own row only). A missing row, a read error or a broken rule all give the default: the Home never crashes on it. */
export async function loadHomeRule(db: SupabaseClient, workspaceId: string, userId: string): Promise<HomeRule> {
  const { data, error } = await db.from("home_rules").select("rule").eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
  return error || !data ? DEFAULT_HOME_RULE : parseHomeRule(data.rule);
}

export type HomeEmail = { sent: number; replies: number; sendingOn: boolean };

/** E-mail card: real sends, replies that are people (not bounces), and whether real sending is on (read only: the same two switches the campaign page shows). */
export async function homeEmail(db: SupabaseClient, workspaceId: string): Promise<HomeEmail> {
  const [sent, replies, settings] = await Promise.all([
    db.from("email_messages").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("status", "sent"),
    db.from("email_replies").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("is_bounce", false).eq("possible_bounce", false),
    db.from("workspace_settings").select("clock_real_enabled").eq("workspace_id", workspaceId).maybeSingle(),
  ]);
  return { sent: sent.count ?? 0, replies: replies.count ?? 0, sendingOn: settings.data?.clock_real_enabled === true && realClockEnabled() };
}
