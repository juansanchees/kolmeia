"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { MA_TOWNS } from "@/lib/coverage/ma-towns";
import { townOf } from "@/lib/coverage/region";
import { isMarkDate } from "@/lib/coverage/view";
import type { FormState } from "@/lib/form-state";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { t } from "@/messages/pt";

const E = t.coverage.errors;
const uuid = z.string().uuid();

/** A manual mark: a town already searched outside the app. Town from the fixed list, date not in the future, note <= 200. */
export async function addMarkAction(form: FormData): Promise<FormState> {
  const workspace = await requireSender();
  const fieldErrors: Record<string, string> = {};
  const name = townOf(String(form.get("town") ?? ""));
  const town = name ? MA_TOWNS.find((x) => x.name === name) : undefined;
  if (!town) fieldErrors.town = E.town;
  const date = String(form.get("date") ?? "").trim();
  const today = new Date().toISOString().slice(0, 10);
  if (!isMarkDate(date, today)) fieldErrors.date = E.date;
  const note = String(form.get("note") ?? "").trim();
  if (note.length > 200) fieldErrors.note = E.note;
  if (!town || Object.keys(fieldErrors).length > 0) return { status: "error", fieldErrors };

  const db = await createClient();
  if (!db) return { status: "error", message: E.failed };
  const { error } = await db.from("coverage_marks").insert({ workspace_id: workspace.id, town: town.name, county: town.county, note, searched_at: date });
  if (error) return { status: "error", message: E.failed };
  revalidatePath("/leads/cobertura");
  return { status: "success", message: t.coverage.saved };
}

export async function deleteMarkAction(id: string): Promise<void> {
  const workspace = await requireSender();
  if (!uuid.safeParse(id).success) return;
  const db = await createClient();
  if (!db) return;
  await db.from("coverage_marks").delete().eq("id", id).eq("workspace_id", workspace.id);
  revalidatePath("/leads/cobertura");
}
