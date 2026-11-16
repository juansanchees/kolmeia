import "server-only";
import { z } from "zod";
import type { LeadListItem, OriginList, Segment } from "@/lib/leads/types";
import { SEGMENTS } from "@/lib/leads/types";
import { hostOf } from "@/lib/safe-url";
import { reserveFor, runTask, type AiContext, type TaskDef, type TaskResult } from "./gateway";
import { MODELS } from "./models";
import * as P from "./prompts/lead-type";

// "Classificar tipo com IA": one Haiku call per batch of leads, no web tools, in the clicking user's ledger (caps and
// the ai_access allowlist in reserve_ai_call). The model only proposes; the caller writes a type only to leads that
// still have none (manual or derived) at write time.

export type { LeadTypeInput, LeadTypeItem } from "./prompts/lead-type";

// Lenient on purpose: one bad label must not throw away the whole batch; pickTypes drops it.
export const leadTypeSchema = z.object({ items: z.array(z.object({ ref: z.string(), type: z.string() })) });
type Parsed = z.infer<typeof leadTypeSchema>;
export type TypedLead = { ref: string; segment: Segment };

const LABEL = z.enum(SEGMENTS);

/** Valid labels for refs that were sent, first answer per ref; "unknown" and anything else is dropped (stays Sem tipo). */
export function pickTypes(p: Parsed, input: P.LeadTypeInput): TypedLead[] {
  const sent = new Set(input.leads.map((l) => l.ref));
  const out = new Map<string, Segment>();
  for (const it of p.items) {
    const ref = it.ref.trim();
    const label = LABEL.safeParse(it.type.trim().toLowerCase());
    if (sent.has(ref) && label.success && !out.has(ref)) out.set(ref, label.data);
  }
  return [...out].map(([ref, segment]) => ({ ref, segment }));
}

export const leadTypeDef: TaskDef<P.LeadTypeInput, Parsed, TypedLead[]> = {
  // "classify" is already allowed by the ai_calls_task check (0029), so no migration is needed
  task: "classify",
  model: MODELS.haiku,
  promptVersion: P.PROMPT_VERSION,
  system: P.SYSTEM,
  schema: leadTypeSchema,
  effort: "low",
  // ~15 output tokens per lead; 40 leads fit with room to spare
  maxTokens: 2000,
  buildUser: P.buildUser,
  normalize: pickTypes,
};

export function classifyLeadTypes(ctx: AiContext, input: P.LeadTypeInput): Promise<TaskResult<TypedLead[]>> {
  return runTask(ctx, leadTypeDef, input);
}

/** Worst-case cost of one batch call (what the gateway reserves); the UI multiplies it by the number of calls. */
export function leadTypeReserveUsd(): number {
  return reserveFor(leadTypeDef);
}

const cap = (s: string | null | undefined, n: number) => {
  const v = s?.replace(/\s+/g, " ").trim();
  return v ? v.slice(0, n) : null;
};

/** What the model reads about one lead: stored data only, every text capped so a batch stays small. */
export function typeItemOf(ref: string, i: Pick<LeadListItem, "best" | "display">, origins: OriginList[], note: string | null): P.LeadTypeItem {
  const b = i.best;
  const job = b?.biggest_job_type || b?.biggest_job_value_usd
    ? [b.biggest_job_type, b.biggest_job_value_usd ? `US$ ${Math.round(b.biggest_job_value_usd).toLocaleString("en-US")}` : null].filter(Boolean).join(", ")
    : null;
  return {
    ref,
    name: cap(i.display.name, 120) ?? "?",
    city: cap(i.display.city, 60),
    domain: i.display.website ? cap(hostOf(i.display.website) ?? i.display.website, 80) : null,
    companyType: cap(i.display.companyType ?? null, 40),
    notes: cap([b?.size_note, b?.notes, note].filter(Boolean).join(" · "), 300),
    biggestJob: cap(job, 100),
    lists: origins.slice(0, 3).map((o) => cap(o.name, 60)!).filter(Boolean),
  };
}
