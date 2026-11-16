"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { townOf } from "@/lib/coverage/region";
import { defaultTransport } from "@/lib/ai/gateway";
import { isAiError, type AiErrorCode } from "@/lib/ai/errors";
import { learnProfile, SOCIAL } from "@/lib/ai/profile-tasks";
import { learnFromResults } from "@/lib/ai/results-tasks";
import { currentProfileOf, learnBlock, resultCounts, type ResultsData } from "@/lib/learning/results";
import { sessionLedger } from "@/lib/ai/session-ledger";
import { openProposalId } from "@/lib/profile/queries";
import { sampleRows } from "@/lib/profile/sample";
import { POINT_KEYS, type LearnedProfile, type TrainingRow } from "@/lib/profile/types";
import { COMPANY_TYPES } from "@/lib/research/types";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { t } from "@/messages/pt";

const E = t.profile.errors;
const uuid = z.string().uuid();
const PAGE = 1000;

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

/** The owner's edit, held to the same limits as the AI's proposal (the database only checks the top-level keys). */
const edited = z.object({
  points: z.array(z.object({ key: z.enum(POINT_KEYS), text: z.string().trim().min(1).max(200), rows: z.array(z.number().int().min(1).max(5000)).min(1).max(20) })).max(12),
  filter: z.object({ companyTypes: z.array(z.enum(COMPANY_TYPES)).max(4), towns: z.array(z.string().max(80)).max(60) }),
  searchQueries: z.array(z.string().trim().min(1).max(120)).max(8),
});

function cleanEdit(p: LearnedProfile): LearnedProfile | null {
  const r = edited.safeParse(p);
  if (!r.success) return null;
  const towns = [...new Set(r.data.filter.towns.map(townOf).filter((x): x is string => x !== null))];
  return {
    points: r.data.points,
    filter: { companyTypes: [...new Set(r.data.filter.companyTypes)], towns },
    searchQueries: [...new Set(r.data.searchQueries.filter((q) => !SOCIAL.test(q)))],
  };
}

type Done = { ok: true } | { ok: false; error: string };

/** One Sonnet call in this user's session over a sample of the list; saves a PROPOSAL only. Nothing is applied. */
export async function trainProfileAction(importId: string): Promise<{ ok: true; profileId: string } | { ok: false; error: string }> {
  const workspace = await requireSender();
  if (!uuid.safeParse(importId).success) return { ok: false, error: E.failed };
  const db = await createClient();
  if (!db) return { ok: false, error: E.failed };
  const { data: imp } = await db.from("lead_imports").select("id, list_name, status, use_as_training").eq("id", importId).eq("workspace_id", workspace.id).maybeSingle();
  if (!imp || !imp.use_as_training || imp.status !== "done") return { ok: false, error: E.notTraining };

  const open = await openProposalId(db, importId).catch(() => null);
  if (open) return { ok: true, profileId: open };

  const rows: TrainingRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("lead_import_rows")
      .select("row_number, data")
      .eq("import_id", importId)
      .in("outcome", ["new", "merged"])
      .order("row_number")
      .range(from, from + PAGE - 1);
    if (error) return { ok: false, error: E.failed };
    for (const r of data ?? []) {
      const d = (r.data ?? {}) as Record<string, string | undefined>;
      rows.push({ row: r.row_number as number, name: d.name ?? "", city: d.city ?? null, state: d.state ?? null, website: d.website ?? null, contact_title: d.contact_title ?? null, note: d.note ?? null });
    }
    if ((data ?? []).length < PAGE) break;
  }
  const sample = sampleRows(rows);
  if (sample.length === 0) return { ok: false, error: E.notTraining };

  let profile: LearnedProfile;
  try {
    const r = await learnProfile({ workspaceId: workspace.id, runId: null, ledger: sessionLedger(db), transport: defaultTransport() }, { listName: String(imp.list_name), rows: sample });
    profile = r.data;
  } catch (e) {
    return { ok: false, error: (isAiError(e) && AI_MESSAGES[e.code]) || t.ai.generic };
  }
  if (profile.points.length === 0) return { ok: false, error: E.empty };

  const { data, error } = await db.rpc("propose_profile", { p_import: importId, p_profile: profile, p_sample_rows: sample.length });
  if (error || !data) return { ok: false, error: E.failed };
  revalidatePath("/leads/subir");
  return { ok: true, profileId: String(data) };
}

/**
 * "Aprender com os resultados": one Sonnet call in this user's session over the leads with a result; saves a PROPOSAL
 * only (an open one is returned instead of paying twice). Needs 10 labeled leads, 3 of them good.
 */
export async function learnFromResultsAction(): Promise<{ ok: true; profileId: string } | { ok: false; error: string }> {
  const workspace = await requireSender();
  const db = await createClient();
  if (!db) return { ok: false, error: E.failed };
  const { data, error } = await db.rpc("results_learning_rows", { p_ws: workspace.id });
  if (error || !data) return { ok: false, error: E.failed };
  const d = data as ResultsData;
  if (d.open_id) return { ok: true, profileId: d.open_id };
  const block = learnBlock(resultCounts(d.rows));
  if (block) return { ok: false, error: t.profile.results[block] };

  let profile: LearnedProfile;
  let sampleRows: number;
  try {
    const r = await learnFromResults({ workspaceId: workspace.id, runId: null, ledger: sessionLedger(db), transport: defaultTransport() }, d.rows, currentProfileOf(d.current));
    profile = r.data;
    sampleRows = r.sampleRows;
  } catch (e) {
    return { ok: false, error: (isAiError(e) && AI_MESSAGES[e.code]) || t.ai.generic };
  }
  if (profile.points.length === 0) return { ok: false, error: t.profile.results.empty };

  const { data: id, error: pErr } = await db.rpc("propose_results_profile", { p_ws: workspace.id, p_profile: profile, p_sample_rows: sampleRows });
  if (pErr || !id) return { ok: false, error: E.failed };
  revalidatePath("/leads/perfil");
  return { ok: true, profileId: String(id) };
}

/** The only way a profile starts to apply. `editedProfile` replaces the proposal's content (the original is kept). */
export async function approveProfileAction(profileId: string, editedProfile: LearnedProfile | null, agentId: string | null): Promise<Done> {
  await requireSender();
  if (!uuid.safeParse(profileId).success || (agentId !== null && !uuid.safeParse(agentId).success)) return { ok: false, error: E.failed };
  const clean = editedProfile === null ? null : cleanEdit(editedProfile);
  if (editedProfile !== null && !clean) return { ok: false, error: E.failed };
  const db = await createClient();
  if (!db) return { ok: false, error: E.failed };
  const { error } = await db.rpc("approve_profile", { p_profile: profileId, p_edited: clean, p_agent: agentId });
  if (error) return { ok: false, error: /profile is/.test(error.message) ? E.notProposed : E.failed };
  revalidatePath(`/leads/perfil/${profileId}`);
  revalidatePath("/leads");
  return { ok: true };
}

export async function rejectProfileAction(profileId: string): Promise<Done> {
  await requireSender();
  if (!uuid.safeParse(profileId).success) return { ok: false, error: E.failed };
  const db = await createClient();
  if (!db) return { ok: false, error: E.failed };
  const { error } = await db.rpc("reject_profile", { p_profile: profileId });
  if (error) return { ok: false, error: /not proposed/.test(error.message) ? E.notProposed : E.failed };
  revalidatePath(`/leads/perfil/${profileId}`);
  return { ok: true };
}
