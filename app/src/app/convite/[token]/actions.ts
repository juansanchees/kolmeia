"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { FormState } from "@/lib/form-state";
import { t } from "@/messages/pt";

const TOKEN = /^[0-9a-f]{64}$/;
const known: Record<string, string> = {
  wrong_email: t.team.wrongEmail,
  has_workspace: t.team.hasWorkspace,
  expired: t.team.expired,
};

export async function acceptInviteAction(token: string): Promise<FormState> {
  if (!TOKEN.test(token)) return { status: "error", message: t.team.expired };
  const supabase = await createClient();
  if (!supabase) return { status: "error", message: t.team.generic };
  const { error } = await supabase.rpc("accept_workspace_invite", { p_token: token });
  if (error) return { status: "error", message: known[error.message] ?? t.team.generic };
  redirect("/leads");
}
