import "server-only";
import { z } from "zod";
import { CHECK_KINDS, CHECK_RESULTS, COMPANY_TYPES, EMAIL_TYPES, ENTRY_PATHS, SOURCE_KINDS, SOURCE_STATUSES } from "@/lib/research/types";

// Structured-output schemas, one per task. Kept free of nullables/optionals on purpose: the API compiles them to a
// grammar with limits on optional and union-typed fields. "Unknown" is an empty string, never a guess (P2).
// Lengths and counts are capped after validation (normalize), not in the grammar.

export const questionsSchema = z.object({
  understood: z.string(),
  places: z.array(z.string()),
  questions: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      options: z.array(z.string()),
      allow_free_text: z.boolean(),
    }),
  ),
});

export const planSchema = z.object({
  summary: z.string(),
  places: z.array(z.string()),
  source_types: z.array(z.string()),
  warnings: z.array(z.string()),
});

export const discoverSchema = z.object({
  sources: z.array(
    z.object({
      kind: z.enum(SOURCE_KINDS),
      title: z.string(),
      url: z.string(),
      status: z.enum(SOURCE_STATUSES),
      note: z.string(),
    }),
  ),
});

const evidenceSchema = z.object({ url: z.string(), title: z.string(), excerpt: z.string() });

/** G10: a job / permit / project whose builder is not identified on the page (empty strings when not shown). */
const jobSchema = z.object({
  address: z.string(),
  project_name: z.string(),
  job_type: z.string(),
  declared_value_usd: z.string(),
  date: z.string(),
  url: z.string(),
  excerpt: z.string(),
});

export const collectSchema = z.object({
  candidates: z.array(
    z.object({
      name: z.string(),
      city: z.string(),
      state: z.string(),
      region: z.string(),
      website: z.string(),
      phone: z.string(),
      phone_source_url: z.string(),
      company_type: z.enum(COMPANY_TYPES),
      size_note: z.string(),
      entry_path: z.enum(ENTRY_PATHS),
      found_at: evidenceSchema,
    }),
  ),
  jobs_without_builder: z.array(jobSchema),
  sources_tried: z.array(z.object({ url: z.string(), title: z.string(), status: z.enum(SOURCE_STATUSES), note: z.string() })),
  exhausted: z.boolean(),
});

const checkSchema = z.object({
  kind: z.enum(CHECK_KINDS),
  result: z.enum(CHECK_RESULTS),
  summary: z.string(),
  evidence: z.array(evidenceSchema),
});

const verifiedCompany = <R extends z.ZodType<string>>(ref: R) =>
  z.object({
    ref,
    urls_tried: z.array(z.string()),
    checks: z.array(checkSchema),
    permit_count: z.string(),
    total_value_usd: z.string(),
    last_permit_date: z.string(),
    biggest_job_address: z.string(),
    biggest_job_value_usd: z.string(),
    biggest_job_type: z.string(),
    biggest_job_description: z.string(),
    signal_match: z.string(),
    ask_for_name: z.string(),
    ask_for_title: z.string(),
    name_confidence: z.enum(["high", "medium", "low", "none"]),
    name_source_url: z.string(),
    name_note: z.string(),
    phone: z.string(),
    phone_source_url: z.string(),
    website: z.string(),
    public_email: z.string(),
    email_type: z.enum(EMAIL_TYPES),
    email_source_url: z.string(),
    google_rating: z.string(),
    review_count: z.string(),
    rating_source_url: z.string(),
    is_large_contractor: z.boolean(),
    supplier_portal_url: z.string(),
    hook: z.string(),
    notes: z.string(),
  });

export const verifySchema = z.object({ companies: z.array(verifiedCompany(z.string())), jobs_without_builder: z.array(jobSchema) });

/** Finding 18: the refs of this batch as an enum, so every entry names one of them exactly. */
export function verifySchemaFor(refs: string[]): typeof verifySchema {
  if (!refs.length) return verifySchema;
  return z.object({
    companies: z.array(verifiedCompany(z.enum(refs as [string, ...string[]]))),
    jobs_without_builder: z.array(jobSchema),
  }) as unknown as typeof verifySchema;
}

export const secondPassSchema = z.object({
  companies: z.array(
    z.object({
      ref: z.string(),
      urls_tried: z.array(z.string()),
      verdict: z.enum(["stands", "refuted", "unsure"]),
      checks: z.array(checkSchema),
    }),
  ),
});

export type QuestionsOut = z.infer<typeof questionsSchema>;
export type PlanOut = z.infer<typeof planSchema>;
export type DiscoverOut = z.infer<typeof discoverSchema>;
export type CollectOut = z.infer<typeof collectSchema>;
export type JobOut = z.infer<typeof jobSchema>;
export type VerifyOut = z.infer<typeof verifySchema>;
export type SecondPassOut = z.infer<typeof secondPassSchema>;
