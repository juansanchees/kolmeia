"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { FormState } from "@/lib/form-state";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { getT } from "@/lib/i18n/server";

/** "Nova lista": an empty named list. Owner/sdr only (RLS too). */
export async function createListAction(_prev: FormState, form: FormData): Promise<FormState> {
  const t = await getT();
  const workspace = await requireSender();
  const name = z.string().trim().min(1).max(120).safeParse(form.get("name"));
  if (!name.success) return { status: "error", message: t.lists.failed };
  const supabase = await createClient();
  if (!supabase) return { status: "error", message: t.lists.failed };
  const { error } = await supabase.from("lists").insert({ workspace_id: workspace.id, name: name.data });
  if (error) return { status: "error", message: error.code === "23505" ? t.lists.duplicate : t.lists.failed };
  revalidatePath("/leads/listas");
  revalidatePath("/inicio");
  return { status: "success", message: t.lists.created };
}
