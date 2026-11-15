"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defaultTransport } from "@/lib/ai/gateway";
import { writeSequence } from "@/lib/ai/email-tasks";
import { isAiError, type AiErrorCode } from "@/lib/ai/errors";
import { sessionLedger } from "@/lib/ai/session-ledger";
import { audienceOf, pickLeads, selectLeads } from "@/lib/email-agent/queries";
import { emailAgentConfigSchema, leadFilterSchema, type EmailAgentConfig, type LeadCounts, type LeadFilterConfig } from "@/lib/email-agent/types";
import { SupabaseEmailStore } from "@/lib/email/supabase-store";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { t } from "@/messages/pt";

const E = t.emailAgent;
const name = z.string().trim().min(1).max(80);

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

/** Live counts for the leads card. Reads only; the workspace comes from the session. */
export async function countLeadsAction(filter: LeadFilterConfig): Promise<{ ok: true; counts: LeadCounts } | { ok: false; error: string }> {
  const ws = await requireSender();
  const f = leadFilterSchema.safeParse(filter);
  if (!f.success) return { ok: false, error: E.invalid };
  const db = await createClient();
  if (!db) return { ok: false, error: E.countsFailed };
  try {
    const r = await selectLeads(db, ws.id, f.data);
    return { ok: true, counts: { total: r.ids.length, withEmail: r.withEmail, withoutEmail: r.withoutEmail } };
  } catch {
    return { ok: false, error: E.countsFailed };
  }
}

type Created = { ok: true; agentId: string; added: Record<string, number> } | { ok: false; error: string; agentId?: string };

/**
 * Born paused, with a draft sequence (one Sonnet call, charged to this user's AI caps) that nobody has approved:
 * nothing is queued as sent and no mail leaves. An AI failure leaves the agent in draft with its campaign.
 */
export async function createEmailAgentAction(input: EmailAgentConfig, agentName: string, reuseAgentId: string | null = null): Promise<Created> {
  const ws = await requireSender();
  const cfg = emailAgentConfigSchema.safeParse(input);
  const n = name.safeParse(agentName);
  if (!cfg.success || !n.success) return { ok: false, error: E.invalid };
  const c = cfg.data;
  const db = await createClient();
  if (!db) return { ok: false, error: E.failed };

  const store = new SupabaseEmailStore(db);
  const [sender, profile] = await Promise.all([store.getSender(ws.id), store.getProfile(ws.id)]);
  if (!sender?.sender_name.trim() || !sender.postal_address.trim()) return { ok: false, error: E.noSender };

  let picked;
  try {
    picked = await pickLeads(db, ws.id, c.filter);
  } catch {
    return { ok: false, error: E.failed };
  }
  const withEmail = picked.filter((i) => Boolean(i.display.email));
  if (withEmail.length === 0) return { ok: false, error: E.noLeads };

  // A retry after an AI failure reuses the draft agent and its campaign (no second agent, leads not added twice)
  let agentId: string;
  let campaignId: string;
  let fresh = true;
  const reuse = z.string().uuid().safeParse(reuseAgentId);
  if (reuse.success) {
    const { data: a } = await db.from("agents").select("id").eq("id", reuse.data).eq("workspace_id", ws.id).eq("type", "email").eq("status", "draft").is("archived_at", null).maybeSingle();
    const { data: k } = a ? await db.from("email_campaigns").select("id").eq("agent_id", reuse.data).maybeSingle() : { data: null };
    if (!a || !k) return { ok: false, error: E.failed };
    agentId = String(a.id);
    campaignId = String(k.id);
    fresh = false;
  } else {
    const { data: agent, error: agentErr } = await db
      .from("agents")
      .insert({ workspace_id: ws.id, type: "email", name: n.data, config: c, schedule: "daily" })
      .select("id")
      .single();
    if (agentErr || !agent) return { ok: false, error: E.failed };
    agentId = String(agent.id);
    const { data: camp, error: campErr } = await db.rpc("create_email_agent_campaign", { p_agent: agentId, p_name: n.data, p_list_id: null });
    if (campErr || !camp) {
      await db.from("agents").delete().eq("id", agentId).eq("status", "draft");
      return { ok: false, error: E.failed };
    }
    campaignId = String(camp);
  }

  const undo = async () => {
    if (!fresh) return;
    await db.from("email_campaigns").delete().eq("id", campaignId);
    await db.from("agents").delete().eq("id", agentId).eq("status", "draft");
  };

  // every chosen mailbox goes into the campaign list, in screen order
  const { data: have } = await db.from("campaign_mailboxes").select("mailbox_id").eq("campaign_id", campaignId);
  const haveIds = new Set((have ?? []).map((r: { mailbox_id: string }) => r.mailbox_id));
  for (const mailboxId of c.mailboxIds.filter((m) => !haveIds.has(m))) {
    const { error } = await db.from("campaign_mailboxes").insert({ campaign_id: campaignId, mailbox_id: mailboxId });
    if (error) {
      await undo();
      return { ok: false, error: E.failed };
    }
  }

  const { data: counts, error: addErr } = await db.rpc("add_leads_to_campaign", { p_campaign: campaignId, p_leads: withEmail.map((i) => i.lead.id) });
  if (addErr) {
    await undo();
    return { ok: false, error: E.failed };
  }
  const added = (counts ?? {}) as Record<string, number>;
  revalidatePath("/agentes", "layout");

  let draft;
  try {
    const r = await writeSequence(
      { workspaceId: ws.id, runId: null, ledger: sessionLedger(db), transport: defaultTransport() },
      {
        workspaceName: ws.name,
        senderName: sender.sender_name.trim(),
        profile,
        tone: c.tone,
        steps: c.steps,
        delays: c.delays,
        audience: audienceOf(withEmail),
      },
    );
    draft = r.data;
  } catch (e) {
    // the agent and its campaign stay (draft): Task 8's "write again" retries without adding the leads twice
    return { ok: false, error: (isAiError(e) && AI_MESSAGES[e.code]) || t.ai.generic, agentId };
  }

  const { error: saveErr } = await db.rpc("save_sequence_draft", {
    p_campaign: campaignId,
    p_steps: draft.steps,
    p_tone: c.tone,
    p_step2: c.delays.step2,
    p_step3: c.delays.step3,
    p_ai_model: draft.model,
    p_prompt_version: draft.promptVersion,
    p_human_edited: false,
  });
  if (saveErr) return { ok: false, error: E.partial, agentId };

  // a draft agent may become paused once its sequence exists (guard_agent); an approved sequence is still needed to run
  const { error: pauseErr } = await db.from("agents").update({ status: "paused" }).eq("id", agentId).eq("status", "draft");
  if (pauseErr) return { ok: false, error: E.partial, agentId };
  revalidatePath("/agentes", "layout");
  return { ok: true, agentId, added };
}
