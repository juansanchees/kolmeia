"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defaultTransport } from "@/lib/ai/gateway";
import { writeSequence } from "@/lib/ai/email-tasks";
import { isAiError, type AiErrorCode } from "@/lib/ai/errors";
import { sessionLedger } from "@/lib/ai/session-ledger";
import { audienceOf } from "@/lib/email-agent/queries";
import { emailAgentConfigSchema, TONES } from "@/lib/email-agent/types";
import { validDelays } from "@/lib/email/schedule";
import { stepProblems, type SequenceStep } from "@/lib/email/template";
import { SupabaseEmailStore } from "@/lib/email/supabase-store";
import { listLeads } from "@/lib/leads/queries";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { t } from "@/messages/pt";

const E = t.emailAgent.detail;
const uuid = z.string().uuid();

export type EmailActionResult = { status: "ok" | "error" | "changed"; message?: string };

const AI_MESSAGES: Partial<Record<AiErrorCode, string>> = {
  not_configured: t.ai.notConfigured,
  no_access: t.ai.noAccess,
  daily_cap: t.ai.dailyCap,
  user_cap: t.ai.userCap,
  global_cap: t.ai.globalCap,
  refused: t.ai.refused,
  invalid_output: t.ai.invalidOutput,
  truncated: t.ai.truncated,
};

const stepsSchema = z
  .array(z.object({ step: z.union([z.literal(1), z.literal(2), z.literal(3)]), subject: z.string(), body: z.string() }))
  .min(1)
  .max(3)
  .refine((s) => s.every((x, i) => x.step === i + 1));
const delaysSchema = z.object({ step2: z.number().int(), step3: z.number().int() }).refine(validDelays);

/** The campaign of an e-mail agent of this workspace, as the user (RLS). */
async function ownCampaign(campaignId: string, wsId: string) {
  const db = await createClient();
  if (!db) return null;
  const { data } = await db.from("email_campaigns").select("id, agent_id, workspace_id").eq("id", campaignId).eq("workspace_id", wsId).maybeSingle();
  return data?.agent_id ? { db, campaignId: String(data.id), agentId: String(data.agent_id) } : null;
}

function revalidate(agentId: string) {
  revalidatePath(`/agentes/${agentId}`);
  revalidatePath("/agentes", "layout");
}

/**
 * The person's own text becomes a new draft version (human_edited). The old versions are superseded and the unsent
 * messages of the old text cancelled by the database: an edit always goes back to approval.
 */
export async function saveSequenceEditAction(campaignId: string, steps: SequenceStep[], tone: string, delays: { step2: number; step3: number }): Promise<EmailActionResult> {
  const ws = await requireSender();
  const s = stepsSchema.safeParse(steps);
  const d = delaysSchema.safeParse(delays);
  if (!uuid.safeParse(campaignId).success || !s.success || !d.success || !(TONES as readonly string[]).includes(tone)) return { status: "error", message: E.invalid };
  if (s.data.some((x) => stepProblems(x).length > 0)) return { status: "error", message: E.invalid };
  const own = await ownCampaign(campaignId, ws.id);
  if (!own) return { status: "error", message: E.failed };
  const { error } = await own.db.rpc("save_sequence_draft", {
    p_campaign: campaignId,
    p_steps: s.data,
    p_tone: tone,
    p_step2: d.data.step2,
    p_step3: d.data.step3,
    p_ai_model: null,
    p_prompt_version: null,
    p_human_edited: true,
  });
  if (error) return { status: "error", message: E.failed };
  revalidate(own.agentId);
  return { status: "ok", message: E.saved };
}

/** One Sonnet call per click, inside the user's AI caps. The result is a new draft that still needs the owner's approval. */
export async function rewriteSequenceAction(campaignId: string): Promise<EmailActionResult> {
  const ws = await requireSender();
  if (!uuid.safeParse(campaignId).success) return { status: "error", message: E.failed };
  const own = await ownCampaign(campaignId, ws.id);
  if (!own) return { status: "error", message: E.failed };
  const { db } = own;

  const store = new SupabaseEmailStore(db);
  const [sender, profile, agentRow, seqRow, prospects] = await Promise.all([
    store.getSender(ws.id),
    store.getProfile(ws.id),
    db.from("agents").select("config").eq("id", own.agentId).maybeSingle(),
    db.from("email_sequences").select("tone, steps, step2_delay_days, step3_delay_days").eq("campaign_id", campaignId).order("version", { ascending: false }).limit(1).maybeSingle(),
    db.from("email_prospects").select("lead_id").eq("campaign_id", campaignId).eq("status", "active").not("lead_id", "is", null).limit(500),
  ]);
  if (!sender?.sender_name.trim() || !sender.postal_address.trim()) return { status: "error", message: t.emailAgent.noSender };

  // the settings the person already has: the newest sequence, else what the creation chat stored
  const cfg = emailAgentConfigSchema.safeParse(agentRow.data?.config);
  const seq = seqRow.data as { tone: "direct" | "friendly" | "consultive"; steps: unknown[]; step2_delay_days: number | null; step3_delay_days: number | null } | null;
  const tone = seq?.tone ?? (cfg.success ? cfg.data.tone : null);
  const count = seq ? seq.steps.length : cfg.success ? cfg.data.steps : null;
  const delays = seq?.step2_delay_days && seq.step3_delay_days ? { step2: seq.step2_delay_days, step3: seq.step3_delay_days } : cfg.success ? cfg.data.delays : null;
  if (!tone || (count !== 1 && count !== 2 && count !== 3) || !delays) return { status: "error", message: E.failed };

  let draft;
  try {
    const ids = ((prospects.data ?? []) as { lead_id: string }[]).map((r) => r.lead_id);
    const leads = ids.length > 0 ? await listLeads(db, ws.id, { ids }) : [];
    const r = await writeSequence(
      { workspaceId: ws.id, runId: null, ledger: sessionLedger(db), transport: defaultTransport() },
      { workspaceName: ws.name, senderName: sender.sender_name.trim(), profile, tone, steps: count, delays, audience: audienceOf(leads) },
    );
    draft = r.data;
  } catch (e) {
    return { status: "error", message: (isAiError(e) && AI_MESSAGES[e.code]) || t.ai.generic };
  }

  const { error } = await db.rpc("save_sequence_draft", {
    p_campaign: campaignId,
    p_steps: draft.steps,
    p_tone: tone,
    p_step2: delays.step2,
    p_step3: delays.step3,
    p_ai_model: draft.model,
    p_prompt_version: draft.promptVersion,
    p_human_edited: false,
  });
  if (error) return { status: "error", message: E.failed };
  // an e-mail agent may leave draft once a sequence exists (guard_agent)
  await db.from("agents").update({ status: "paused" }).eq("id", own.agentId).eq("status", "draft");
  revalidate(own.agentId);
  return { status: "ok", message: E.rewritten };
}

/**
 * Only the owner approves, and only the digest the screen showed. If anything changed meanwhile the database answers
 * 40001: nothing is approved and the screen reloads its examples.
 */
export async function approveSequenceAction(sequenceId: string, digest: string): Promise<EmailActionResult> {
  const ws = await requireSender();
  if (ws.role !== "owner") return { status: "error", message: E.onlyOwner };
  if (!uuid.safeParse(sequenceId).success || !/^[0-9a-f]{64}$/.test(digest)) return { status: "error", message: E.failed };
  const db = await createClient();
  if (!db) return { status: "error", message: E.failed };
  const { error } = await db.rpc("approve_email_sequence", { p_sequence: sequenceId, p_digest: digest });
  if (error) {
    revalidatePath("/agentes", "layout");
    if (error.code === "40001") return { status: "changed", message: E.changed };
    if (error.code === "42501") return { status: "error", message: E.onlyOwner };
    return { status: "error", message: E.approveFailed };
  }
  revalidatePath("/agentes", "layout");
  return { status: "ok", message: E.approved };
}

/** Ligar / Pausar. The database refuses Ligar without an approved version, a mailbox and the sender profile. */
export async function setEmailAgentRunningAction(agentId: string, on: boolean): Promise<EmailActionResult> {
  const ws = await requireSender();
  if (!uuid.safeParse(agentId).success) return { status: "error", message: E.failed };
  const db = await createClient();
  if (!db) return { status: "error", message: E.failed };
  const { data: a } = await db.from("agents").select("id").eq("id", agentId).eq("workspace_id", ws.id).eq("type", "email").maybeSingle();
  if (!a) return { status: "error", message: E.failed };
  const { error } = await db.rpc("set_email_agent_running", { p_agent: agentId, p_on: on });
  if (error) return { status: "error", message: on ? E.turnOnFailed : E.failed };
  revalidate(agentId);
  return { status: "ok" };
}
