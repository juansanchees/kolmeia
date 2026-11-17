"use server";

import { z } from "zod";
import { isAiError } from "@/lib/ai/errors";
import { defaultTransport } from "@/lib/ai/gateway";
import { explainLead } from "@/lib/ai/lead-ai-tasks";
import { sessionLedger } from "@/lib/ai/session-ledger";
import { getLead } from "@/lib/leads/queries";
import { displayOf } from "@/lib/leads/view";
import { isThin, whyHotFacts } from "@/lib/leads/why-hot";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { getT } from "@/lib/i18n/server";
import { ptMessages } from "@/lib/i18n";

export type WhyResult = { ok: true; summary: string } | { ok: false; error: string };

/**
 * "Resumir com IA": one Haiku call in the user's AI caps. The facts are rebuilt here from what the lead stores (never
 * taken from the browser), and the summary must cite them by number (checkExplain drops anything else).
 */
export async function summarizeWhyHotAction(leadId: string): Promise<WhyResult> {
  const t = await getT();
  const ws = await requireSender();
  const db = await createClient();
  if (!db || !z.string().uuid().safeParse(leadId).success) return { ok: false, error: t.leads.whyHot.failed };
  const d = await getLead(db, leadId).catch(() => null);
  if (!d) return { ok: false, error: t.leads.whyHot.failed };
  const best = d.candidates.find((c) => c.id === d.lead.best_candidate_id) ?? d.candidates[0] ?? null;
  // AI input: the facts stay Portuguese like the prompt, whatever the UI language (the numbering is the same)
  const facts = whyHotFacts({ level: d.lead.level, best, fields: d.fields, checks: d.checks }, ptMessages);
  if (isThin(facts)) return { ok: false, error: t.leads.whyHot.none };
  try {
    const r = await explainLead(
      { workspaceId: ws.id, runId: null, ledger: sessionLedger(db), transport: defaultTransport(), deadlineMs: 30_000 },
      { company: displayOf(best, d.fields).name, facts: facts.map((f) => f.text) },
    );
    return { ok: true, summary: r.data.summary };
  } catch (e) {
    // the e-mail area's code-keyed AI texts are neutral (no "research paused" wording)
    return { ok: false, error: (isAiError(e) && (t.email.ai as Record<string, string>)[e.code]) || t.leads.whyHot.failed };
  }
}
