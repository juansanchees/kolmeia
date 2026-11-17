"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { callAgentConfigSchema, type CallAgentConfig } from "@/lib/calls/types";
import type { FormState } from "@/lib/form-state";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { fill } from "@/lib/i18n";
import { getT } from "@/lib/i18n/server";

const uuid = z.string().uuid();
const name = z.string().trim().min(1).max(80);

/** Born paused (the database lets a call agent leave draft only with a valid config). The caller redirects. */
export async function createCallAgentAction(input: { name: string; config: CallAgentConfig }): Promise<{ ok: true; agentId: string } | { ok: false; error: string }> {
  const t = await getT();
  const C = t.callAgent;
  const ws = await requireSender();
  const n = name.safeParse(input.name);
  const cfg = callAgentConfigSchema.safeParse(input.config);
  if (!n.success || !cfg.success) return { ok: false, error: C.invalid };
  const db = await createClient();
  if (!db) return { ok: false, error: C.failed };
  const { data, error } = await db
    .from("agents")
    .insert({ workspace_id: ws.id, type: "call", name: n.data, config: cfg.data, schedule: "daily" })
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: C.failed };
  const { error: upErr } = await db.from("agents").update({ status: "paused" }).eq("id", data.id).eq("status", "draft");
  if (upErr) {
    // the insert always lands as draft; do not leave an orphan that a retry would duplicate (best effort)
    await db.from("agents").delete().eq("id", data.id).eq("status", "draft");
    return { ok: false, error: C.failed };
  }
  revalidatePath("/agentes", "layout");
  return { ok: true, agentId: data.id as string };
}

/** "Montar lista de hoje": idempotent per day, never past per_day (build_call_list). */
export async function buildListAction(agentId: string): Promise<FormState> {
  const t = await getT();
  const C = t.callAgent;
  await requireSender();
  if (!uuid.safeParse(agentId).success) return { status: "error", message: C.failed };
  const db = await createClient();
  if (!db) return { status: "error", message: C.failed };
  const { data, error } = await db.rpc("build_call_list", { p_agent: agentId });
  if (error) return { status: "error", message: /not a running call agent/.test(error.message) ? C.buildNeedsRunning : C.failed };
  revalidatePath(`/agentes/${agentId}`);
  revalidatePath("/leads/ligar");
  revalidatePath("/inicio");
  const n = Number(data ?? 0);
  return { status: "success", message: n > 0 ? fill(C.built, { n }) : C.buildNone };
}

/**
 * Ligar / Pausar for a call agent. The Caçador action (turnOnHunterAction) refuses any other type ("not_ready"), so
 * this one exists. The database re-checks the config on Ligar (the caller must still be a member).
 */
export async function setCallAgentRunningAction(agentId: string, on: boolean): Promise<FormState> {
  const t = await getT();
  const C = t.callAgent;
  const ws = await requireSender();
  if (!uuid.safeParse(agentId).success) return { status: "error", message: C.failed };
  const db = await createClient();
  if (!db) return { status: "error", message: C.failed };
  const { error } = await db
    .from("agents")
    .update({ status: on ? "running" : "paused" })
    .eq("id", agentId)
    .eq("workspace_id", ws.id)
    .eq("type", "call")
    .eq("status", on ? "paused" : "running");
  if (error) return { status: "error", message: on ? t.agents.errors.tooMany : C.failed };
  // no row changed = already in that state elsewhere: nothing to do
  revalidatePath("/agentes", "layout");
  revalidatePath("/leads/ligar");
  return { status: "success" };
}
