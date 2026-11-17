"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "./next";
import { credentialsSchema } from "@/lib/profile-schema";
import type { FormState } from "@/lib/form-state";
import { getT } from "@/lib/i18n/server";

export async function authenticate(_prev: FormState, formData: FormData): Promise<FormState> {
  const t = await getT();
  const mode = formData.get("mode") === "signup" ? "signup" : "signin";
  const next = safeNext(formData.get("next"));
  const parsed = credentialsSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { status: "error", message: t.login.errors.invalid };

  const supabase = await createClient();
  if (!supabase) return { status: "error", message: t.notConfigured.title };

  if (mode === "signin") {
    const { error } = await supabase.auth.signInWithPassword(parsed.data);
    if (error) return { status: "error", message: t.login.errors.credentials };
    redirect(next);
  }

  const { data, error } = await supabase.auth.signUp(parsed.data);
  if (error) return { status: "error", message: t.login.errors.generic };
  if (data.session) redirect(next);
  return { status: "success", message: t.login.checkEmail };
}

export async function signOut() {
  const supabase = await createClient();
  await supabase?.auth.signOut();
  redirect("/login");
}
