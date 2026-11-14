"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { archiveAgent, finishHunter, startHunter, type Actor } from "@/lib/agents/commands";
import { SupabaseAgentStore } from "@/lib/agents/store";
import type { FormState } from "@/lib/form-state";
import { researchSession } from "@/lib/research/session";
import { t } from "@/messages/pt";

const E = t.agents.hunter.errors;
const uuid = z.string().uuid();

function actorOf(s: NonNullable<Awaited<ReturnType<typeof researchSession>>>): Actor {
  return { workspaceId: s.workspace.id, role: s.workspace.role };
}

export async function startHunterAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const s = await researchSession();
  if (!s) return { status: "error", message: E.failed };
  const str = (k: string) => String(formData.get(k) ?? "");
  const res = await startHunter(new SupabaseAgentStore(s.supabase), s.store, actorOf(s), {
    profileSource: str("profileSource"),
    companyNote: str("companyNote"),
    audience: str("audience"),
    audienceText: str("audienceText"),
    region: str("region"),
  });
  if (!res.ok) {
    if (res.error === "forbidden") redirect("/leads");
    if (res.error === "invalid") {
      const fieldErrors: Record<string, string> = {};
      for (const k of Object.keys(res.fieldErrors ?? {})) {
        fieldErrors[k] = (E as Record<string, string>)[k] ?? E.invalid;
      }
      return { status: "error", message: E.invalid, fieldErrors };
    }
    return { status: "error", message: E.failed };
  }
  revalidatePath("/agentes", "layout");
  redirect(`/agentes/${res.agentId}`);
}

async function archive(agentId: string): Promise<FormState | null> {
  const s = await researchSession();
  if (!s || !uuid.safeParse(agentId).success) return { status: "error", message: E.failed };
  const res = await archiveAgent(new SupabaseAgentStore(s.supabase), actorOf(s), agentId);
  if (!res.ok) {
    if (res.error === "forbidden") redirect("/leads");
    return { status: "error", message: E.failed };
  }
  revalidatePath("/agentes", "layout");
  return null;
}

export async function archiveAgentAction(agentId: string): Promise<FormState> {
  const err = await archive(agentId);
  if (err) return err;
  redirect("/agentes");
}

/** "Recomeçar": a setup run exists once per agent, so restarting = archive this agent and start a new one. */
export async function restartHunterAction(agentId: string): Promise<FormState> {
  const err = await archive(agentId);
  if (err) return err;
  redirect("/agentes/novo");
}

/** "Criar agente (pausado)". The agent is born paused; nothing runs. */
export async function finishHunterAction(agentId: string, input: { name: string; rigor: string; schedule: string }): Promise<FormState> {
  const s = await researchSession();
  if (!s || !uuid.safeParse(agentId).success) return { status: "error", message: E.failed };
  const res = await finishHunter(new SupabaseAgentStore(s.supabase), actorOf(s), agentId, input);
  if (!res.ok) {
    if (res.error === "forbidden") redirect("/leads");
    if (res.error === "not_ready") return { status: "error", message: E.notReady };
    if (res.error === "invalid") return { status: "error", message: E.invalid, fieldErrors: Object.fromEntries(Object.keys(res.fieldErrors ?? {}).map((k) => [k, E.invalid])) };
    return { status: "error", message: E.failed };
  }
  revalidatePath("/agentes", "layout");
  redirect("/agentes");
}
