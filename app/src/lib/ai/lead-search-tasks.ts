import "server-only";
import { z } from "zod";
import { EMAIL_QUALITIES } from "@/lib/leads/email-quality";
import type { NlFilters } from "@/lib/leads/nl-search";
import { fold } from "@/lib/leads/view";
import { COMPANY_TYPES, TEMPERATURES } from "@/lib/research/types";
import { runTask, type AiContext, type TaskDef, type TaskResult } from "./gateway";
import { MODELS } from "./models";
import { CONTEXT, UNTRUSTED, untrusted } from "./prompts/shared";

// Natural-language search, layer 2 (Fase 2, item 8): one small Haiku call, no web tools, in the user's session
// ledger (caps and allowlist apply in reserve_ai_call). The answer maps onto the SAME filters the facets use, and
// normalize keeps only cities the workspace's leads really have. Nothing is applied until the user clicks.

export const PROMPT_VERSION = "lead-search-2026-11-16.1";

const SYSTEM = `${CONTEXT}

Your job now: the user typed, in Portuguese or English, which of their saved leads they want to see. Turn it into filters. Use only what the text asks for; leave everything else at its "no filter" value (empty list, "any", false, 0, "all").
- cities: only names from the known_cities list, written exactly as listed.
- company_types: builder (construtora), developer (incorporadora), property_manager (administradora), other.
- temperature: very_hot, hot, warm, cold, or any.
- levels: exact data levels 0-4 asked for; min_level: "level N or more" (0 = no minimum).
- has_phone / has_email: true only when the text asks for leads with a phone / an e-mail.
- contact: new (never contacted), contacted, or all.
- email_quality: verified (confirmed by a paid verifier), domain_ok (the domain takes mail), catch_all, unknown, invalid; only when the text asks about e-mail quality.

${UNTRUSTED}`;

export const leadSearchSchema = z.object({
  cities: z.array(z.string()),
  company_types: z.array(z.enum(COMPANY_TYPES)),
  temperature: z.enum([...TEMPERATURES, "any"]),
  levels: z.array(z.number().int()),
  min_level: z.number().int(),
  has_phone: z.boolean(),
  has_email: z.boolean(),
  contact: z.enum(["new", "contacted", "all"]),
  email_quality: z.array(z.enum(EMAIL_QUALITIES)),
});
type Parsed = z.infer<typeof leadSearchSchema>;

export type LeadSearchInput = { text: string; cities: string[] };

const level = (n: number): n is 0 | 1 | 2 | 3 | 4 => Number.isInteger(n) && n >= 0 && n <= 4;

/** Model output -> filters: known cities only (as the list writes them), levels 0-4, defaults dropped. */
export function toFilters(p: Parsed, cities: string[]): NlFilters {
  const byFold = new Map(cities.map((c) => [fold(c.trim()), c.trim()]));
  const out: NlFilters = {};
  const picked = [...new Set(p.cities.map((c) => byFold.get(fold(c.trim()))).filter((c): c is string => Boolean(c)))];
  if (picked.length) out.cities = picked;
  if (p.company_types.length) out.companyTypes = [...new Set(p.company_types)];
  if (p.temperature !== "any") out.temperature = p.temperature;
  const levels = [...new Set(p.levels.filter(level))];
  if (levels.length) out.levels = levels;
  if (p.min_level > 0 && level(p.min_level)) out.minLevel = p.min_level;
  if (p.has_phone) out.hasPhone = true;
  if (p.has_email) out.hasEmail = true;
  if (p.contact !== "all") out.contact = p.contact;
  if (p.email_quality.length) out.emailQuality = [...new Set(p.email_quality)];
  return out;
}

export const leadSearchDef: TaskDef<LeadSearchInput, Parsed, NlFilters> = {
  task: "lead_search",
  model: MODELS.haiku,
  promptVersion: PROMPT_VERSION,
  system: SYSTEM,
  schema: leadSearchSchema,
  effort: "low",
  maxTokens: 600,
  buildUser: (i) => ["Known cities of the user's leads:", untrusted("known_cities", i.cities.join("\n")), "What the user typed:", untrusted("search_text", i.text)].join("\n"),
  normalize: (p, input) => toFilters(p, input.cities),
};

export function searchLeadsWithAi(ctx: AiContext, input: LeadSearchInput): Promise<TaskResult<NlFilters>> {
  return runTask(ctx, leadSearchDef, input);
}
