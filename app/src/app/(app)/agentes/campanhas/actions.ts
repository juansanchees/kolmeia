"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { applyInstruction, decidePreference, startCampaign, type Campaign } from "@/lib/hunt/flow";
import { supabaseHuntDb } from "@/lib/hunt/db";
import { interpretInstruction } from "@/lib/hunt/interpret";
import { mergeParams } from "@/lib/hunt/rescore";
import { getLocale, getT } from "@/lib/i18n/server";
import { OFFERS } from "@/lib/offers";
import type { CampaignParams } from "@/lib/offers/types";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";

const uuid = z.string().uuid();
const text = (f: FormData, k: string, max: number) => String(f.get(k) ?? "").trim().slice(0, max);
const back = (path: string, erro: string, q?: string): never => redirect(`${path}?${new URLSearchParams({ ...(q ? { q } : {}), erro })}`);

/** "Começar por esta" / "Outra busca": creates the campaign and round 1 (waiting for the operator's run), then opens its conversation. */
export async function startCampaignAction(form: FormData): Promise<void> {
  const workspace = await requireSender();
  const [t, lang, db] = [await getT(), await getLocale(), await createClient()];
  const request = text(form, "request", 1000) || t.hunt.entry.placeholder;
  const offer = text(form, "offer", 60);
  if (!db) return back("/agentes/clientes", "failed", request);
  if (!(offer in OFFERS)) return back("/agentes/clientes", "empty", request);
  let region = text(form, "region", 200);
  if (!region) {
    const { data } = await db.from("company_profiles").select("service_area").eq("workspace_id", workspace.id).maybeSingle();
    region = String(data?.service_area ?? "").trim().slice(0, 200);
  }
  if (!region) return back("/agentes/clientes", "region", request);
  // "Ajustar" is optional text on a suggestion; "Outra busca" sends the request itself as the instruction.
  const instruction = text(form, "adjust", 1000) || (form.get("kind") === "other" ? request : "");
  const it = instruction ? interpretInstruction(instruction, lang) : { params: {}, understoodCodes: [], unknown: [] };
  let id: string;
  try {
    id = await startCampaign(supabaseHuntDb(db), t.hunt, { ws: workspace.id, offer, region, request, params: mergeParams({}, it.params), understood: it.understoodCodes, unknown: it.unknown });
  } catch {
    return back("/agentes/clientes", "failed", request);
  }
  revalidatePath("/agentes");
  redirect(`/agentes/campanhas/${id}`);
}

async function loadCampaign(id: string): Promise<Campaign | null> {
  const workspace = await requireSender();
  const db = await createClient();
  if (!db || !uuid.safeParse(id).success) return null;
  const { data } = await db.from("hunt_campaigns").select("id, workspace_id, offer, params").eq("id", id).maybeSingle();
  return data && data.workspace_id === workspace.id ? { id: data.id, workspace_id: data.workspace_id, offer: data.offer, params: data.params as CampaignParams } : null;
}

/** An instruction in the campaign chat. */
export async function instructAction(campaignId: string, form: FormData): Promise<void> {
  const path = `/agentes/campanhas/${campaignId}`;
  const c = await loadCampaign(campaignId);
  const body = text(form, "instruction", 1000);
  if (!c) return redirect("/agentes");
  if (!body) return back(path, "empty");
  try {
    await applyInstruction(supabaseHuntDb((await createClient())!), (await getT()).hunt, await getLocale(), c, body);
  } catch {
    return back(path, "failed");
  }
  revalidatePath(path);
  redirect(path);
}

/** Approve a proposed rule, or undo an approved one. "Agora não" on a proposal only marks it undone (nothing was applied). */
export async function preferenceAction(campaignId: string, prefId: string, decision: "approved" | "undone" | "later"): Promise<void> {
  const path = `/agentes/campanhas/${campaignId}`;
  const c = await loadCampaign(campaignId);
  if (!c || !uuid.safeParse(prefId).success) return redirect("/agentes");
  const db = supabaseHuntDb((await createClient())!);
  try {
    if (decision === "later") await db.rpc("offer_preference_decide", { p_pref: prefId, p_decision: "undone" });
    else await decidePreference(db, (await getT()).hunt, c, prefId, decision);
  } catch {
    return back(path, "failed");
  }
  revalidatePath(path);
  redirect(path);
}
