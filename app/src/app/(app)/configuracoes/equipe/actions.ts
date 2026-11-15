"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { configuredPublicOrigin } from "@/lib/email/config";
import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace, getUser } from "@/lib/workspace";
import type { FormState } from "@/lib/form-state";
import { t } from "@/messages/pt";

const inviteSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(254),
});

/** Owner only; anyone else is sent to LEADS. The database enforces the same (42501). */
async function requireOwner() {
  const workspace = await getCurrentWorkspace();
  if (!workspace || workspace.role !== "owner") redirect("/leads");
  return workspace;
}

export async function createInviteAction(_prev: FormState, form: FormData): Promise<FormState & { link?: string }> {
  const workspace = await requireOwner();
  const parsed = inviteSchema.safeParse({ name: form.get("name"), email: form.get("email") });
  if (!parsed.success) return { status: "error", message: t.team.invalid };
  const supabase = await createClient();
  if (!supabase) return { status: "error", message: t.team.generic };

  const { data, error } = await supabase.rpc("create_workspace_invite", {
    p_ws: workspace.id,
    p_name: parsed.data.name,
    p_email: parsed.data.email,
  });
  if (error || typeof data !== "string") return { status: "error", message: t.team.generic };

  // The app sends no e-mail: the owner copies this link and sends it herself.
  let origin = configuredPublicOrigin()?.replace(/\/+$/, "");
  if (!origin) {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
    origin = `${h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")}://${host}`;
  }
  revalidatePath("/configuracoes/equipe");
  return { status: "success", link: `${origin}/convite/${data}` };
}

export async function revokeInviteAction(id: string): Promise<void> {
  await requireOwner();
  const supabase = await createClient();
  if (supabase && z.string().uuid().safeParse(id).success) await supabase.rpc("revoke_workspace_invite", { p_invite: id });
  revalidatePath("/configuracoes/equipe");
}

export async function removeMemberAction(userId: string): Promise<FormState> {
  const workspace = await requireOwner();
  const user = await getUser();
  if (!z.string().uuid().safeParse(userId).success) return { status: "error", message: t.team.generic };
  if (!user || user.id === userId) return { status: "error", message: t.team.removeSelf };
  const supabase = await createClient();
  if (!supabase) return { status: "error", message: t.team.generic };
  const { error } = await supabase.from("workspace_members").delete().eq("workspace_id", workspace.id).eq("user_id", userId);
  if (error) return { status: "error", message: error.code === "23514" ? t.team.lastOwner : t.team.generic };
  revalidatePath("/configuracoes/equipe");
  return { status: "success" };
}
