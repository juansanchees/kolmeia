import "server-only";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { isUnsubToken } from "./token";

/**
 * Public unsubscribe (logged out). Uses only the public anon key (env.NEXT_PUBLIC_SUPABASE_ANON_KEY) and the one
 * narrow SECURITY DEFINER function unsubscribe_by_token(); there is no admin key anywhere (R14). The function
 * returns only a boolean, so this path cannot read anything. Idempotent.
 */
export async function unsubscribeByToken(token: string): Promise<"ok" | "invalid" | "unavailable"> {
  if (!isUnsubToken(token)) return "invalid";
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return "unavailable";
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await db.rpc("unsubscribe_by_token", { p_token: token });
  if (error) return "unavailable";
  return data === true ? "ok" : "invalid";
}
