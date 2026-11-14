import "server-only";
import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace, getUser } from "@/lib/workspace";
import { SupabaseResearchStore } from "./supabase-store";

/** The research store bound to the logged-in user's session (RLS applies), or null when signed out. */
export async function researchSession() {
  const supabase = await createClient();
  const user = await getUser();
  const workspace = await getCurrentWorkspace();
  if (!supabase || !user || !workspace) return null;
  return { supabase, user, workspace, store: new SupabaseResearchStore(supabase) };
}
