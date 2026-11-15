"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { MailboxKeyError } from "@/lib/email/config";
import { bodyProblem, subjectProblem } from "@/lib/email/compose";
import { encryptSecret, mailboxAad } from "@/lib/email/crypto";
import { draftAnswer, fetchReplies, handOffWithBrief, refreshBrief, sendTestToSelf, templateDrafts, verifyMailbox } from "@/lib/email/engine";
import { emailOrigins, emailSession } from "@/lib/email/session";
import { MAX_CAMPAIGN_MAILBOXES, mailboxListChange } from "@/lib/email/rotation";
import { validDelays } from "@/lib/email/schedule";
import { REPLY_CLASSES, SUPPRESSION_REASONS, type ApprovalResult, type MessageVersion } from "@/lib/email/types";
import { timeOf } from "@/components/email/format";
import type { FormState } from "@/lib/form-state";
import { fill, t } from "@/messages/pt";

// Every action runs as the logged-in user (RLS; R14). The database re-checks roles and rules in its functions.
// Approval exists ONLY here, as a person's click (R1, R13): the AI and the engine never call set_email_approval.

const M = t.email;
const uuid = z.string().uuid();
const versions = z.array(z.object({ id: uuid, updatedAt: z.string().min(10).max(40) })).min(1).max(200);
const EMAIL = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

export type ActionResult = { ok: boolean; message?: string };

const ok = (message?: string): ActionResult => ({ ok: true, message });
const err = (message: string = M.genericError): ActionResult => ({ ok: false, message });

async function sender() {
  const s = await emailSession();
  return s && s.canSend ? s : null;
}

/** Portuguese text for a mailbox error code (SMTP / stored secret / configuration). */
function mailboxError(code: string | null | undefined, waitUntil?: string): string {
  switch (code) {
    case "auth_failed":
    case "mailbox_secret":
    case "key_missing":
    case "sender_incomplete":
    case "no_public_origin":
      return M.mailbox.errors[code];
    case "test_limit":
      return fill(M.mailbox.errors.test_limit, { time: timeOf(waitUntil) });
    case "sending_paused":
      return M.send.outcomes.sending_paused;
    default:
      return M.mailbox.errors.generic;
  }
}

function refresh(...paths: string[]) {
  for (const p of paths) revalidatePath(p);
  revalidatePath("/campanhas", "layout");
}

// ---------------------------------------------------------------- sender profile (R4)
const senderSchema = z.object({
  legal_name: z.string().trim().min(2).max(120).regex(/^[^\r\n]*$/),
  postal_address: z.string().trim().min(10).max(300),
  sender_name: z.string().trim().min(2).max(80).regex(/^[^\r\n<>"\\]*$/),
});

export async function saveSenderProfile(_prev: FormState, form: FormData): Promise<FormState> {
  const parsed = senderSchema.safeParse({
    legal_name: form.get("legal_name") ?? "",
    postal_address: form.get("postal_address") ?? "",
    sender_name: form.get("sender_name") ?? "",
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of parsed.error.issues) {
      const k = String(i.path[0]) as keyof typeof M.sender.errors;
      fieldErrors[k] = M.sender.errors[k];
    }
    return { status: "error", fieldErrors };
  }
  const s = await sender();
  if (!s) return { status: "error", message: M.genericError };
  const { data: updated, error } = await s.supabase.from("sender_profiles").update(parsed.data).eq("workspace_id", s.workspace.id).select("workspace_id");
  if (error || !updated?.length) {
    const ins = await s.supabase.from("sender_profiles").insert({ workspace_id: s.workspace.id, ...parsed.data });
    if (ins.error) return { status: "error", message: M.genericError };
  }
  refresh("/configuracoes/caixas");
  return { status: "success", message: M.saved };
}

// ---------------------------------------------------------------- mailboxes
const connectSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).regex(EMAIL),
  password: z
    .string()
    .transform((v) => v.replace(/\s+/g, ""))
    .pipe(z.string().regex(/^[a-zA-Z]{16}$/)),
});

export async function connectMailbox(_prev: FormState, form: FormData): Promise<FormState> {
  const parsed = connectSchema.safeParse({ email: form.get("email") ?? "", password: form.get("password") ?? "" });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of parsed.error.issues) {
      if (i.path[0] === "email") fieldErrors.email = M.mailbox.errors.address;
      if (i.path[0] === "password") fieldErrors.password = M.mailbox.errors.password;
    }
    return { status: "error", fieldErrors };
  }
  const s = await sender();
  if (!s) return { status: "error", message: M.mailbox.errors.generic };
  let ciphertext: string;
  try {
    ciphertext = encryptSecret(parsed.data.password, mailboxAad(s.workspace.id, parsed.data.email));
  } catch (e) {
    return { status: "error", message: e instanceof MailboxKeyError ? M.keyMissing : M.mailbox.errors.generic };
  }
  const { data: id, error } = await s.supabase.rpc("save_mailbox", { p_workspace: s.workspace.id, p_email: parsed.data.email, p_ciphertext: ciphertext });
  if (error || typeof id !== "string") return { status: "error", message: M.mailbox.errors.generic };
  const v = await verifyMailbox(s.deps, id).catch(() => ({ ok: false, error: "generic" }));
  refresh("/configuracoes/caixas");
  if (!v.ok) return { status: "error", message: mailboxError(v.error) };
  return { status: "success", message: M.saved };
}

export async function reverifyMailbox(mailboxId: string): Promise<ActionResult> {
  const s = await sender();
  if (!s || !uuid.safeParse(mailboxId).success) return err();
  try {
    const v = await verifyMailbox(s.deps, mailboxId);
    refresh("/configuracoes/caixas");
    return v.ok ? ok(M.saved) : err(mailboxError(v.error));
  } catch (e) {
    return err(e instanceof MailboxKeyError ? M.keyMissing : M.mailbox.errors.generic);
  }
}

export async function sendTestMessage(mailboxId: string): Promise<ActionResult> {
  const s = await sender();
  const self = s?.user.email?.toLowerCase();
  if (!s || !self || !uuid.safeParse(mailboxId).success) return err();
  try {
    // Only to the logged-in user's own account address (from the session; never typed). At most 5 a day.
    const r = await sendTestToSelf(s.deps, mailboxId, self, s.workspace.name, await emailOrigins());
    refresh("/configuracoes/caixas");
    if (r.ok) return ok(fill(M.mailbox.testSent, { email: self }));
    return err(mailboxError(r.error, r.waitUntil));
  } catch (e) {
    return err(e instanceof MailboxKeyError ? M.keyMissing : M.mailbox.errors.generic);
  }
}

export async function removeMailbox(mailboxId: string): Promise<ActionResult> {
  const s = await sender();
  if (!s || !uuid.safeParse(mailboxId).success) return err();
  const { error } = await s.supabase.from("mailboxes").delete().eq("id", mailboxId);
  refresh("/configuracoes/caixas");
  return error ? err() : ok();
}

export async function setMailboxLimit(mailboxId: string, limit: number): Promise<ActionResult> {
  const s = await emailSession();
  if (!s || s.workspace.role !== "owner" || !uuid.safeParse(mailboxId).success || !Number.isInteger(limit) || limit < 1 || limit > 50) return err();
  const { data, error } = await s.supabase.from("mailboxes").update({ daily_limit: limit }).eq("id", mailboxId).select("id");
  refresh("/configuracoes/caixas");
  return error || !data?.length ? err() : ok(M.saved);
}

// ---------------------------------------------------------------- campaigns
const campaignSchema = z.object({ list_id: uuid, mailbox_id: uuid, name: z.string().trim().min(1).max(120) });

export async function createCampaign(_prev: FormState, form: FormData): Promise<FormState> {
  const parsed = campaignSchema.safeParse({ list_id: form.get("list_id"), mailbox_id: form.get("mailbox_id"), name: form.get("name") ?? "" });
  if (!parsed.success) return { status: "error", message: M.campaigns.errors.invalid };
  const s = await sender();
  if (!s) return { status: "error", message: M.campaigns.errors.generic };
  const { data, error } = await s.supabase
    .from("email_campaigns")
    .insert({ workspace_id: s.workspace.id, ...parsed.data })
    .select("id")
    .single();
  if (error || !data) return { status: "error", message: M.campaigns.errors.generic };
  const imp = await s.supabase.rpc("import_list_into_campaign", { p_campaign: data.id });
  if (imp.error) return { status: "error", message: M.campaigns.errors.generic };
  refresh("/campanhas");
  redirect(`/campanhas/${data.id}`);
}

export async function setCampaignStatus(campaignId: string, status: "active" | "paused" | "done" | "archived"): Promise<ActionResult> {
  const s = await sender();
  if (!s || !uuid.safeParse(campaignId).success || !["active", "paused", "done", "archived"].includes(status)) return err();
  // 'archived' replaces deletion: history, unsubscribe links and the R2 counters stay (the database refuses to
  // delete a campaign that has claimed anything).
  const { data, error } = await s.supabase.from("email_campaigns").update({ status }).eq("id", campaignId).select("id");
  refresh(`/campanhas/${campaignId}`, "/campanhas");
  return error || !data?.length ? err() : ok();
}

/** "Pausar tudo": every campaign of this workspace that is sending. */
export async function pauseAllCampaigns(): Promise<ActionResult> {
  const s = await sender();
  if (!s) return err();
  const { data, error } = await s.supabase.from("email_campaigns").update({ status: "paused" }).eq("workspace_id", s.workspace.id).eq("status", "active").select("id");
  refresh("/campanhas");
  return error ? err() : ok(fill(M.overview.pausedN, { n: data?.length ?? 0 }));
}

/**
 * E4 emergency stop ("Parar todos os envios"): any sender turns it on; only an owner turns it off (checked again in SQL).
 * While on, no claim of any kind happens (click, clock, rehearsal, real, answers).
 */
export async function setSendingPaused(on: boolean): Promise<ActionResult> {
  const s = await sender();
  if (!s || typeof on !== "boolean") return err();
  if (!on && s.workspace.role !== "owner") return err(M.stop.onlyOwner);
  const { error } = await s.supabase.rpc("set_sending_paused", { p_ws: s.workspace.id, p_on: on });
  refresh("/campanhas", "/configuracoes/caixas");
  return error ? err() : ok(on ? M.stop.done : M.stop.resumed);
}

/** E4: an owner puts a mailbox paused on bounces back to work. */
export async function clearMailboxPause(mailboxId: string): Promise<ActionResult> {
  const s = await emailSession();
  if (!s || s.workspace.role !== "owner" || !uuid.safeParse(mailboxId).success) return err();
  const { error } = await s.supabase.rpc("clear_mailbox_pause", { p_mailbox: mailboxId });
  refresh("/configuracoes/caixas");
  return error ? err() : ok(M.saved);
}

/** Rehearsal <-> real. Real is owner-only, with a verified mailbox and postal address (checked again in SQL; R4). */
export async function setSendMode(campaignId: string, mode: "dry_run" | "real"): Promise<ActionResult> {
  const s = await sender();
  if (!s || !uuid.safeParse(campaignId).success || !["dry_run", "real"].includes(mode)) return err();
  if (mode === "real" && s.workspace.role !== "owner") return err(M.campaign.ownerOnly);
  const { error } = await s.supabase.rpc("set_campaign_send_mode", { p_campaign: campaignId, p_mode: mode });
  refresh(`/campanhas/${campaignId}`);
  if (error && /in progress/i.test(error.message)) return err(M.campaign.sendInProgress);
  return error ? err(mode === "real" ? M.campaign.goRealNeeds : M.genericError) : ok();
}

export async function setDelays(campaignId: string, step2: number, step3: number): Promise<ActionResult> {
  const s = await sender();
  if (!s || !uuid.safeParse(campaignId).success || !validDelays({ step2, step3 })) return err(M.campaign.delaysError);
  const { error } = await s.supabase.rpc("set_campaign_delays", { p_campaign: campaignId, p_step2: step2, p_step3: step3 });
  refresh(`/campanhas/${campaignId}`);
  if (error?.code === "55000") return err(M.campaign.delaysFromSequence);
  return error ? err(M.campaign.delaysError) : ok(M.saved);
}

/**
 * The campaign's mailbox list (E3): 1 to 10 mailboxes of this workspace. Unticked ones are removed first (so a swap at
 * the cap fits), then the new ones are added in screen order. The database re-checks workspace, role and the cap.
 */
export async function setCampaignMailboxes(campaignId: string, mailboxIds: string[]): Promise<ActionResult> {
  const s = await sender();
  const ids = z.array(uuid).min(1).max(MAX_CAMPAIGN_MAILBOXES).safeParse(mailboxIds);
  if (!s || !uuid.safeParse(campaignId).success) return err();
  if (!ids.success) return err(M.campaign.mailboxesError);
  const { data: cur, error: readError } = await s.supabase.from("campaign_mailboxes").select("mailbox_id").eq("campaign_id", campaignId).order("seq", { ascending: true });
  if (readError) return err(M.campaign.mailboxesError);
  const { remove, add } = mailboxListChange(((cur ?? []) as { mailbox_id: string }[]).map((r) => r.mailbox_id), ids.data);
  let failure: string | null = null;
  if (remove.length) {
    const del = await s.supabase.from("campaign_mailboxes").delete().eq("campaign_id", campaignId).in("mailbox_id", remove);
    if (del.error) failure = del.error.message;
  }
  for (const mailboxId of add) {
    if (failure) break;
    const ins = await s.supabase.from("campaign_mailboxes").insert({ campaign_id: campaignId, mailbox_id: mailboxId });
    if (ins.error) failure = ins.error.message;
  }
  refresh(`/campanhas/${campaignId}`, "/campanhas");
  if (failure) return err(/at most 10/i.test(failure) ? M.campaign.mailboxesMax : M.campaign.mailboxesError);
  return ok(M.saved);
}

/** Without AI (or by choice): honest template drafts that a person edits and approves. */
export async function writeTemplateDrafts(campaignId: string): Promise<ActionResult> {
  const s = await sender();
  if (!s || !uuid.safeParse(campaignId).success) return err();
  try {
    await templateDrafts(s.deps, campaignId, s.workspace.name);
  } catch {
    return err();
  }
  refresh(`/campanhas/${campaignId}`);
  return ok();
}

// ---------------------------------------------------------------- prospects
export async function setProspectEmail(prospectId: string, raw: string): Promise<ActionResult> {
  const s = await sender();
  const value = raw.trim().toLowerCase();
  if (!s || !uuid.safeParse(prospectId).success) return err(M.campaign.emailErrors.generic);
  if (value && !EMAIL.test(value)) return err(M.campaign.emailErrors.invalid);
  const { count } = await s.supabase.from("email_messages").select("id", { count: "exact", head: true }).eq("prospect_id", prospectId).eq("status", "approved");
  // R18: a typed address is stored as 'manual' (stamped with who typed it) by the database trigger, which also
  // returns this prospect's approved e-mails to draft (R1: the approval was for the old address).
  const { data, error } = await s.supabase.from("email_prospects").update({ email: value || null }).eq("id", prospectId).select("campaign_id");
  if (error || !data?.length) return err(M.campaign.emailErrors.generic);
  refresh(`/campanhas/${(data[0] as { campaign_id: string }).campaign_id}`);
  return ok((count ?? 0) > 0 ? M.campaign.emailReset : M.saved);
}

/** R18: a person confirms the address the research saw without proof; it becomes 'manual', confirmed by them. */
export async function confirmSuggestedEmail(prospectId: string): Promise<ActionResult> {
  const s = await sender();
  if (!s || !uuid.safeParse(prospectId).success) return err(M.campaign.emailErrors.generic);
  const { data } = await s.supabase.from("email_prospects").select("suggested_email").eq("id", prospectId).maybeSingle();
  const suggested = (data as { suggested_email: string | null } | null)?.suggested_email;
  if (!suggested) return err(M.campaign.emailErrors.generic);
  return setProspectEmail(prospectId, suggested);
}

export async function setProspectSkipped(prospectId: string, skipped: boolean): Promise<ActionResult> {
  const s = await sender();
  if (!s || !uuid.safeParse(prospectId).success) return err();
  const { data, error } = await s.supabase
    .from("email_prospects")
    .update({ status: skipped ? "skipped" : "active" })
    .eq("id", prospectId)
    .eq("status", skipped ? "active" : "skipped")
    .select("campaign_id");
  if (error) return err();
  if (data?.length) refresh(`/campanhas/${(data[0] as { campaign_id: string }).campaign_id}`);
  return ok();
}

// ---------------------------------------------------------------- messages (R1, R4, R12)
export async function saveMessage(messageId: string, subject: string, body: string): Promise<ActionResult> {
  const s = await sender();
  if (!s || !uuid.safeParse(messageId).success) return err(M.review.errors.generic);
  const { data: row } = await s.supabase.from("email_messages").select("kind, campaign_id").eq("id", messageId).maybeSingle();
  if (!row) return err(M.review.errors.generic);
  const kind = (row as { kind: "sequence" | "reply" }).kind;
  const problem = subjectProblem(subject, kind) ?? bodyProblem(body, kind);
  if (problem) return err(M.review.errors[problem]);
  // Editing an approved message drops its approval (database trigger; R1).
  const { error } = await s.supabase.from("email_messages").update({ subject: subject.trim(), body: body.replace(/\r\n?/g, "\n").trim() }).eq("id", messageId);
  refresh(`/campanhas/${(row as { campaign_id: string }).campaign_id}/revisar`, "/campanhas/respostas");
  return error ? err(M.review.errors.generic) : ok(M.saved);
}

function approvalText(r: ApprovalResult, action: string): string | undefined {
  const parts: string[] = [];
  if (action === "approve") parts.push(fill(M.review.approvedN, { n: r.done }));
  if (r.changed) parts.push(fill(M.review.skippedChanged, { n: r.changed }));
  if (r.skipped) parts.push(fill(M.review.skippedState, { n: r.skipped }));
  return parts.length ? parts.join(" ") : undefined;
}

/**
 * A person's approval (or rejection) of the messages exactly as their screen showed them (id + updated_at).
 * Stamped with their user id, the time and the recipient address by set_email_approval() (R1); a row changed
 * since it was shown is skipped and reported.
 */
export async function decideMessages(items: MessageVersion[], action: "approve" | "reject" | "unapprove"): Promise<ActionResult> {
  const s = await sender();
  if (!s || !versions.safeParse(items).success || !["approve", "reject", "unapprove"].includes(action)) return err();
  const { data, error } = await s.supabase.rpc("set_email_approval", {
    p_ids: items.map((i) => i.id),
    p_versions: items.map((i) => i.updatedAt),
    p_action: action,
  });
  revalidatePath("/campanhas", "layout");
  if (error) return err();
  const r = (data ?? { done: 0, changed: 0, skipped: 0 }) as ApprovalResult;
  return { ok: r.changed === 0, message: approvalText(r, action) };
}

/**
 * "Aprovar todos os revisados": only the messages whose full text the person opened on the list (sent back with
 * the version they saw), and only drafts of the 3-step sequence: never a rejected e-mail, never an answer to a
 * reply. Everything else is skipped and counted in the result.
 */
export async function approveReviewed(items: MessageVersion[]): Promise<ActionResult> {
  const s = await sender();
  if (!s || !versions.safeParse(items).success) return err();
  const { data, error } = await s.supabase.from("email_messages").select("id, kind, status").in("id", items.map((i) => i.id));
  if (error) return err();
  const eligible = new Set(((data ?? []) as { id: string; kind: string; status: string }[]).filter((m) => m.kind === "sequence" && m.status === "draft").map((m) => m.id));
  const chosen = items.filter((i) => eligible.has(i.id));
  const notDraft = items.length - chosen.length;
  if (!chosen.length) return ok(approvalText({ done: 0, changed: 0, skipped: notDraft }, "approve"));
  const r = await decideMessages(chosen, "approve");
  if (!notDraft) return r;
  return { ok: r.ok, message: [r.message, fill(M.review.skippedState, { n: notDraft })].filter(Boolean).join(" ") };
}

/**
 * "Tentar de novo". The attempt stays counted (R2). A real send whose result is unknown ("interrupted") needs
 * confirmedNotSent: the person checked the Gmail Sent folder (R9); the database refuses it otherwise.
 */
export async function retryMessage(messageId: string, confirmedNotSent = false): Promise<ActionResult> {
  const s = await sender();
  if (!s || !uuid.safeParse(messageId).success) return err();
  const { data, error } = await s.supabase.rpc("retry_failed_email", { p_message: messageId, p_confirmed_not_sent: confirmedNotSent === true });
  revalidatePath("/campanhas", "layout");
  if (error) return err(/R9/.test(error.message) ? M.send.interrupted : M.genericError);
  return ok(data === "draft" ? M.send.retryDraft : undefined);
}

// ---------------------------------------------------------------- replies
export type FetchResult = ActionResult & { stored?: number; bounces?: number; classified?: number };

export async function fetchRepliesAction(mailboxId: string): Promise<FetchResult> {
  const s = await sender();
  if (!s || !uuid.safeParse(mailboxId).success) return err();
  try {
    const r = await fetchReplies(s.deps, mailboxId);
    revalidatePath("/campanhas", "layout");
    const note = r.aiProblem && r.aiProblem !== "not_configured" ? ` ${M.ai[r.aiProblem] ?? ""}` : "";
    return { ok: true, message: fill(M.replies.fetched, { stored: r.stored, bounces: r.bounces, possible: r.possibleBounces, classified: r.classified }) + note, ...r };
  } catch (e) {
    return err(e instanceof MailboxKeyError ? M.keyMissing : mailboxError(e instanceof Error && e.name === "SecretError" ? "mailbox_secret" : null));
  }
}

/** "Possível devolução": a person confirms it (suppress and stop) or dismisses it. */
export async function confirmBounce(replyId: string, isBounce: boolean): Promise<ActionResult> {
  const s = await sender();
  if (!s || !uuid.safeParse(replyId).success) return err();
  const { error } = await s.supabase.rpc("confirm_possible_bounce", { p_reply: replyId, p_is_bounce: isBounce === true });
  revalidatePath("/campanhas", "layout");
  return error ? err() : ok();
}

export async function setReplyLabel(replyId: string, label: string): Promise<ActionResult> {
  const s = await sender();
  const cls = z.enum(REPLY_CLASSES).safeParse(label);
  if (!s || !uuid.safeParse(replyId).success || !cls.success) return err();
  const { error } = await s.supabase.rpc("set_reply_class", { p_reply: replyId, p_class: cls.data, p_source: "human", p_reason: null, p_model: null });
  revalidatePath("/campanhas", "layout");
  return error ? err() : ok();
}

export async function draftAnswerAction(replyId: string): Promise<ActionResult> {
  const s = await sender();
  if (!s || !uuid.safeParse(replyId).success) return err();
  const reply = await s.store.getReply(replyId);
  if (!reply) return err();
  const r = await draftAnswer(s.deps, reply, s.workspace.name);
  revalidatePath("/campanhas", "layout");
  return r.ok ? ok() : err(M.ai[r.code] ?? M.genericError);
}

// ---------------------------------------------------------------- closer
export async function handOffAction(prospectId: string): Promise<ActionResult> {
  const s = await sender();
  if (!s || !uuid.safeParse(prospectId).success) return err();
  try {
    const r = await handOffWithBrief(s.deps, prospectId, s.workspace.name);
    revalidatePath("/campanhas", "layout");
    if (!r.handedOff) return err();
    return r.aiProblem ? ok(M.ai[r.aiProblem] ?? undefined) : ok();
  } catch {
    return err();
  }
}

export async function refreshBriefAction(prospectId: string): Promise<ActionResult> {
  const s = await sender();
  if (!s || !uuid.safeParse(prospectId).success) return err();
  const r = await refreshBrief(s.deps, prospectId, s.workspace.name);
  revalidatePath("/leads/closer");
  return r.brief ? ok() : err(r.aiProblem ? M.ai[r.aiProblem] : M.genericError);
}

// ---------------------------------------------------------------- suppressions (R3)
const suppressionSchema = z.object({
  value: z.string().trim().toLowerCase().max(254),
  reason: z.enum(SUPPRESSION_REASONS).refine((r) => r === "manual" || r === "asked_to_stop"),
  note: z.string().trim().max(300),
});

export async function addSuppression(_prev: FormState, form: FormData): Promise<FormState> {
  const parsed = suppressionSchema.safeParse({ value: form.get("value") ?? "", reason: form.get("reason") ?? "manual", note: form.get("note") ?? "" });
  if (!parsed.success) return { status: "error", fieldErrors: { value: M.blocked.errors.invalid } };
  const v = parsed.data.value.replace(/^@/, "");
  const kind = EMAIL.test(v) ? "address" : DOMAIN.test(v) ? "domain" : null;
  if (!kind) return { status: "error", fieldErrors: { value: M.blocked.errors.invalid } };
  const s = await emailSession();
  if (!s) return { status: "error", message: M.blocked.errors.generic };
  const { error } = await s.supabase.from("suppressions").insert({ workspace_id: s.workspace.id, kind, value: v, reason: parsed.data.reason, note: parsed.data.note });
  if (error && !/duplicate|unique/i.test(error.message)) return { status: "error", message: M.blocked.errors.generic };
  refresh("/configuracoes/bloqueados");
  return { status: "success", message: M.saved };
}

export async function removeSuppression(id: string): Promise<ActionResult> {
  const s = await emailSession();
  if (!s || !uuid.safeParse(id).success) return err();
  if (s.workspace.role !== "owner") return err(M.blocked.ownerOnly);
  const { data, error } = await s.supabase.from("suppressions").delete().eq("id", id).select("id");
  refresh("/configuracoes/bloqueados");
  return error || !data?.length ? err(M.blocked.ownerOnly) : ok();
}
