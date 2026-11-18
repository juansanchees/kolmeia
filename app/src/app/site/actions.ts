"use server";

import type { FormState } from "@/lib/form-state";
import { getLocale, getT } from "@/lib/i18n/server";
import { createClient } from "@/lib/supabase/server";
import { parseWaitlist } from "@/lib/waitlist";

/** Waitlist form. New and already-known e-mails get the same success message (the RPC returns nothing either way). */
export async function joinWaitlist(_prev: FormState, formData: FormData): Promise<FormState> {
  const t = (await getT()).landing.waitlist;
  const input = parseWaitlist(formData);
  if (!input.ok) {
    // A bot sees a normal success and nothing is stored.
    return input.reason === "honeypot" ? { status: "success", message: t.success } : { status: "error", message: t.invalid };
  }
  const supabase = await createClient();
  if (!supabase) return { status: "error", message: t.unavailable };
  const { error } = await supabase.rpc("join_waitlist", { p_email: input.email, p_locale: await getLocale() });
  if (error) return { status: "error", message: error.code === "22023" ? t.invalid : t.unavailable };
  return { status: "success", message: t.success };
}
