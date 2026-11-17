"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { nyLocalToIso } from "@/lib/calls/call-input";
import { NEW_TASK_KINDS } from "@/lib/agenda/view";
import { isSender } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { getCurrentWorkspace, getUser } from "@/lib/workspace";
import { getT } from "@/lib/i18n/server";

type Result = { ok: boolean; message?: string };

const DAY = 86_400_000;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const newSchema = z.object({
  leadId: z.uuid(),
  kind: z.enum(NEW_TASK_KINDS),
  date,
  time,
  note: z.string().trim().max(200),
  assignee: z.uuid().nullable(),
});

const refresh = () => {
  revalidatePath("/inicio");
  revalidatePath("/inicio/agenda");
  revalidatePath("/leads/tarefas");
};

/**
 * New York wall time -> instant, only from yesterday to two years ahead (a typo like 2062 never lands). "gap" = a
 * clock time that does not exist that day (the spring DST jump) or no real date.
 */
function dueOf(d: string, tm: string): { iso: string } | { err: "gap" | "range" } {
  const iso = nyLocalToIso(`${d}T${tm}`);
  if (!iso) return { err: "gap" };
  const ms = Date.parse(iso);
  return ms >= Date.now() - DAY && ms <= Date.now() + 730 * DAY ? { iso } : { err: "range" };
}

/**
 * A new return / meeting / e-mail task on a lead the user can see. Senders pick any member (or keep it themselves);
 * the closer's is always her own. The database checks the same (0037 tasks_insert) and that the lead is visible.
 */
export async function createTaskAction(input: unknown): Promise<Result> {
  const t = await getT();
  const T = t.tasks.form;
  const p = newSchema.safeParse(input);
  if (!p.success) return { ok: false, message: T.invalid };
  const due = dueOf(p.data.date, p.data.time);
  if ("err" in due) return { ok: false, message: due.err === "gap" ? T.badTime : T.badDate };
  const [workspace, supabase, user] = [await getCurrentWorkspace(), await createClient(), await getUser()];
  if (!workspace || !supabase || !user) return { ok: false, message: T.failed };
  const assignee = isSender(workspace.role) ? (p.data.assignee ?? user.id) : user.id;
  const { data: lead } = await supabase.from("leads").select("id").eq("id", p.data.leadId).eq("workspace_id", workspace.id).maybeSingle();
  if (!lead) return { ok: false, message: T.failed };
  const { error } = await supabase
    .from("tasks")
    .insert({ workspace_id: workspace.id, lead_id: p.data.leadId, kind: p.data.kind, title: p.data.note, due_at: due.iso, assignee_id: assignee });
  if (error) return { ok: false, message: T.failed };
  refresh();
  return { ok: true };
}

/** "Remarcar": a new New York date and time. RLS: senders, or the closer on her leads' tasks. */
export async function rescheduleTaskAction(id: string, d: string, tm: string): Promise<Result> {
  const t = await getT();
  const p = z.object({ id: z.uuid(), d: date, tm: time }).safeParse({ id, d, tm });
  if (!p.success) return { ok: false, message: t.tasks.form.invalid };
  const due = dueOf(p.data.d, p.data.tm);
  if ("err" in due) return { ok: false, message: due.err === "gap" ? t.tasks.form.badTime : t.tasks.form.badDate };
  const [supabase, workspace] = [await createClient(), await getCurrentWorkspace()];
  if (!supabase || !workspace) return { ok: false, message: t.tasks.failed };
  const { data, error } = await supabase.from("tasks").update({ due_at: due.iso }).eq("id", p.data.id).eq("workspace_id", workspace.id).select("id");
  if (error || !data?.length) return { ok: false, message: t.tasks.failed };
  refresh();
  return { ok: true };
}

/** "Marcar feito" and its undo. */
export async function setTaskDoneAction(id: string, done: boolean): Promise<Result> {
  const t = await getT();
  const p = z.object({ id: z.uuid(), done: z.boolean() }).safeParse({ id, done });
  const [supabase, workspace] = [await createClient(), await getCurrentWorkspace()];
  if (!p.success || !supabase || !workspace) return { ok: false, message: t.tasks.failed };
  const { data, error } = await supabase.from("tasks").update({ done_at: p.data.done ? new Date().toISOString() : null }).eq("id", p.data.id).eq("workspace_id", workspace.id).select("id");
  if (error || !data?.length) return { ok: false, message: t.tasks.failed };
  refresh();
  return { ok: true };
}
