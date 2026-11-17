"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { workspaceNameSchema } from "@/lib/profile-schema";
import type { FormState } from "@/lib/form-state";
import { getT } from "@/lib/i18n/server";

export async function createWorkspace(_prev: FormState, formData: FormData): Promise<FormState> {
  const t = await getT();
  const parsed = workspaceNameSchema.safeParse(formData.get("name"));
  if (!parsed.success) return { status: "error", fieldErrors: { name: t.onboarding.errors.invalid } };

  const supabase = await createClient();
  if (!supabase) return { status: "error", message: t.notConfigured.title };

  // RPC runs with the user's session; the database makes the caller the owner. No service-role key involved.
  const { error } = await supabase.rpc("create_workspace", { p_name: parsed.data });
  if (error) return { status: "error", message: t.onboarding.errors.generic };
  redirect("/configuracoes/empresa");
}
