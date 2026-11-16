"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isAiError, STOP_CODES } from "@/lib/ai/errors";
import { defaultTransport } from "@/lib/ai/gateway";
import { classifyLeadTypes, typeItemOf } from "@/lib/ai/lead-type-tasks";
import { sessionLedger } from "@/lib/ai/session-ledger";
import { AI_TYPE_BATCH, AI_TYPE_MAX, segmentInputOf, segmentOf, writableTypes } from "@/lib/leads/classify";
import { inChunks, inLeadChunks, listLeads, originListsOf } from "@/lib/leads/queries";
import type { Segment } from "@/lib/leads/types";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { t } from "@/messages/pt";

const T = t.leads.toolbar;
/** One batch call's deadline; 5 calls per click stay inside the page's maxDuration of 300 s. */
const AI_MS = 45_000;

export type TypeResult = { ok: true; typed: number; untyped: number; stopText: string | null } | { ok: false; error: string };

/**
 * "Classificar tipo com IA": owner/sdr only. The browser sends the ids it shows as "Sem tipo"; the server re-reads them
 * (RLS), keeps only those with no manual and no derived type, asks Haiku in batches, and writes through
 * set_leads_segment (sender check in SQL) only to leads whose stored type is still empty right before the write.
 */
export async function classifyTypesAction(leadIds: string[]): Promise<TypeResult> {
  const ws = await requireSender();
  const ids = z.array(z.string().uuid()).min(1).max(AI_TYPE_MAX).safeParse(leadIds);
  const db = await createClient();
  if (!db || !ids.success) return { ok: false, error: T.aiTypeFailed };

  let todo: { id: string; item: ReturnType<typeof typeItemOf> }[];
  try {
    const items = await listLeads(db, ws.id, { ids: ids.data });
    const origins = await originListsOf(db, items.map((i) => i.lead.id));
    const untyped = items.filter((i) => segmentOf(segmentInputOf(i.lead, i.best, i.display.companyType ?? null, origins.get(i.lead.id) ?? [])) === null);
    const notes = await inLeadChunks<{ lead_id: string; value: string }>(
      untyped.map((i) => i.lead.id),
      (c) => db.from("lead_fields").select("lead_id, value").in("lead_id", c).eq("field", "note").neq("status", "refuted") as never,
      "classifyTypes notes",
    );
    const noteOf = new Map(notes.map((n) => [n.lead_id, n.value]));
    todo = untyped.map((i, n) => ({ id: i.lead.id, item: typeItemOf(`L${n + 1}`, i, origins.get(i.lead.id) ?? [], noteOf.get(i.lead.id) ?? null) }));
  } catch {
    return { ok: false, error: T.aiTypeFailed };
  }
  if (todo.length === 0) return { ok: true, typed: 0, untyped: 0, stopText: null };

  const ai = { workspaceId: ws.id, runId: null, ledger: sessionLedger(db), transport: defaultTransport(), deadlineMs: AI_MS };
  const suggested: { id: string; segment: Segment }[] = [];
  let stopText: string | null = null;
  for (let at = 0; at < todo.length; at += AI_TYPE_BATCH) {
    const batch = todo.slice(at, at + AI_TYPE_BATCH);
    const idOf = new Map(batch.map((b) => [b.item.ref, b.id]));
    try {
      const r = await classifyLeadTypes(ai, { leads: batch.map((b) => b.item) });
      for (const x of r.data) suggested.push({ id: idOf.get(x.ref)!, segment: x.segment });
    } catch (e) {
      // a cap or no access stops spending; a bad answer only skips this batch (its leads stay Sem tipo)
      if (isAiError(e) && STOP_CODES.has(e.code)) {
        stopText = (t.email.ai as Record<string, string>)[e.code] ?? t.ai.generic;
        break;
      }
    }
  }

  let typed = 0;
  if (suggested.length > 0) {
    const stored = await inChunks<{ id: string; segment: Segment | null }>(
      suggested.map((s) => s.id),
      (c) => db.from("leads").select("id, segment").eq("workspace_id", ws.id).in("id", c) as never,
      "classifyTypes stored",
    ).catch(() => []);
    const ok = writableTypes(suggested, new Map(stored.map((r) => [r.id, r.segment])));
    for (const seg of ["residential", "small", "large"] as const) {
      const group = ok.filter((s) => s.segment === seg).map((s) => s.id);
      if (group.length === 0) continue;
      const { data, error } = await db.rpc("set_leads_segment", { p_ws: ws.id, p_leads: group, p_segment: seg });
      if (!error) typed += typeof data === "number" ? data : group.length;
    }
    if (typed > 0) revalidatePath("/leads", "layout");
  }
  return { ok: true, typed, untyped: todo.length - typed, stopText };
}
