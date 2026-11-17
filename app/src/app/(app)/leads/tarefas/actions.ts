"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { postponed } from "@/lib/tasks/view";
import { getCurrentWorkspace } from "@/lib/workspace";
import { getT } from "@/lib/i18n/server";

type Result = { ok: boolean; message?: string };
const uuid = z.string().uuid();

/** "Feito" and "Adiar". Any member: RLS lets senders and the lead's closer update done_at / due_at only. */
export async function taskAction(id: string, what: "done" | "postpone"): Promise<Result> {
  const t = await getT();
  const p = z.object({ id: uuid, what: z.enum(["done", "postpone"]) }).safeParse({ id, what });
  const supabase = await createClient();
  if (!p.success || !supabase || !(await getCurrentWorkspace())) return { ok: false, message: t.tasks.failed };
  let patch: { done_at: string } | { due_at: string };
  if (p.data.what === "done") patch = { done_at: new Date().toISOString() };
  else {
    const { data } = await supabase.from("tasks").select("due_at").eq("id", p.data.id).maybeSingle();
    if (!data) return { ok: false, message: t.tasks.failed };
    patch = { due_at: postponed(data.due_at as string, new Date()) };
  }
  const { data, error } = await supabase.from("tasks").update(patch).eq("id", p.data.id).select("id");
  if (error || !data?.length) return { ok: false, message: t.tasks.failed };
  revalidatePath("/leads/tarefas");
  revalidatePath("/inicio");
  return { ok: true };
}
