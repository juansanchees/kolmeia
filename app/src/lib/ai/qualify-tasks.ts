import "server-only";
import { z } from "zod";
import { displayOf } from "@/lib/leads/view";
import type { LeadFieldRow } from "@/lib/leads/types";
import type { LeadSnapshot } from "@/lib/qualifier/types";
import { COMPANY_TYPES, type CompanyType } from "@/lib/research/types";
import { runTask, type AiContext, type TaskDef, type TaskResult } from "./gateway";
import { MODELS } from "./models";
import type { ProfileInput } from "./prompts/shared";
import { TASK_DEFS, type VerifyResult } from "./tasks";
import * as lightP from "./prompts/qualify-light";
import type { LightInput } from "./prompts/qualify-light";

// The Qualificador's own AI tasks. P4 (qualify_light): Haiku, no web tools, reads page text the app already fetched.
// Page text is untrusted data. A value is kept only when it is literally written in that text (R18); the model's word
// alone never becomes a stored fact.

export type { LightInput };

// "Unknown" is an empty string, never a guess; counts are capped after validation (see schemas.ts).
export const lightSchema = z.object({
  company_type: z.enum([...COMPANY_TYPES, "unknown"]),
  city: z.string(),
  state: z.string(),
  size_note: z.string(),
  address: z.string(),
  contacts: z.array(z.object({ name: z.string(), title: z.string(), email: z.string(), phone: z.string() })),
});
type LightParsed = z.infer<typeof lightSchema>;

export type LightField = "city" | "state" | "address" | "contact_name" | "contact_title" | "email" | "phone";
export type LightOut = {
  companyType: CompanyType | null;
  values: { field: LightField; value: string; url: string; excerpt: string }[];
};

const MAX_VALUE = 300;
const MAX_CONTACTS = 5;
const EXCERPT_RADIUS = 110;

const fold = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const phoneDigits = (s: string) => s.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

/** Up to 300 characters of the page around [start, end), whole words not required, never half a surrogate pair. */
function around(text: string, start: number, end: number): string {
  let a = Math.max(0, start - EXCERPT_RADIUS);
  let b = Math.min(text.length, end + EXCERPT_RADIUS);
  if (b - a > 300) b = a + 300;
  if (a > 0 && /[\udc00-\udfff]/.test(text[a])) a++;
  if (b < text.length && /[\ud800-\udbff]/.test(text[b - 1])) b--;
  return text.slice(a, b).trim();
}

/**
 * Where a value the model returned is written in the page text, or null (dropped). Phones are compared by digits,
 * e-mails exactly (case aside, and not inside a longer address), anything else case- and space-folded.
 */
export function keepIfInText(value: string, kind: "phone" | "email" | "text", pages: LightInput["pages"]): { url: string; excerpt: string } | null {
  const v = value.trim();
  if (!v || v.length > MAX_VALUE) return null;
  for (const p of pages) {
    const text = p.text.replace(/\s+/g, " ");
    if (kind === "phone") {
      const want = phoneDigits(v);
      if (want.length < 7) continue;
      for (const m of text.matchAll(/\+?\d[\d\s().\-]{5,}\d/g)) {
        if (phoneDigits(m[0]) === want) return { url: p.url, excerpt: around(text, m.index, m.index + m[0].length) };
      }
    } else if (kind === "email") {
      const want = v.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(want)) continue;
      const low = text.toLowerCase();
      for (let i = low.indexOf(want); i >= 0; i = low.indexOf(want, i + 1)) {
        const before = low[i - 1] ?? " ";
        const after = low.slice(i + want.length, i + want.length + 2);
        if (/[a-z0-9._%+\-]/.test(before) || /^[a-z0-9\-]/.test(after) || /^\.[a-z0-9]/.test(after)) continue;
        return { url: p.url, excerpt: around(text, i, i + want.length) };
      }
    } else {
      const want = fold(v);
      if (want.length < 2) continue;
      const low = text.toLowerCase();
      const i = low.indexOf(want);
      if (i >= 0) return { url: p.url, excerpt: around(text, i, i + want.length) };
    }
  }
  return null;
}

export const lightDef: TaskDef<LightInput, LightParsed, LightOut> = {
  task: "qualify_light",
  model: MODELS.haiku,
  promptVersion: lightP.PROMPT_VERSION,
  system: lightP.SYSTEM,
  schema: lightSchema,
  effort: "low",
  maxTokens: 2000,
  buildUser: lightP.buildUser,
  normalize: (p, input) => {
    const values: LightOut["values"] = [];
    const keep = (field: LightField, raw: string, kind: "phone" | "email" | "text") => {
      const v = kind === "email" ? raw.trim().toLowerCase() : raw.trim();
      if (!v) return;
      const at = keepIfInText(v, kind, input.pages);
      if (at) values.push({ field, value: v, url: at.url, excerpt: at.excerpt });
    };
    keep("city", p.city, "text");
    keep("state", p.state, "text");
    keep("address", p.address, "text");
    for (const c of p.contacts.slice(0, MAX_CONTACTS)) {
      keep("contact_name", c.name, "text");
      keep("contact_title", c.title, "text");
      keep("email", c.email, "email");
      keep("phone", c.phone, "phone");
    }
    return { companyType: p.company_type === "unknown" ? null : p.company_type, values };
  },
};

export function lightQualify(ctx: AiContext, input: LightInput): Promise<TaskResult<LightOut>> {
  return runTask(ctx, lightDef, input);
}

// P5 (qualify_deep): the research verify task under its own task name, so the ledger and Gastos tell it apart. Same
// model (Sonnet), same "careful" web budget and the same evidence rules (an "ok" needs a source the web tools returned).
// One company per call; the page and web text it reads is untrusted data, as in research.

export const DEEP_REQUEST =
  "Confirm this company is active, whether it has construction work happening now (with a dated public source), and who decides on HVAC or mechanical subcontractors.";
export const deepDef = { ...TASK_DEFS.verifyDef, task: "qualify_deep" as const };
const DEEP_KINDS = ["exists_active", "has_work", "decision_maker"] as const;

/** The approved company profile as the verify prompt wants it; anything else is "not filled in yet". */
function profileOf(raw: unknown): ProfileInput {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!r) return null;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const wanted = Array.isArray(r.wanted_work) ? r.wanted_work.filter((x): x is string => typeof x === "string") : [];
  return { what_we_do: s(r.what_we_do), service_area: s(r.service_area), wanted_work: wanted, good_customer: s(r.good_customer), not_wanted: s(r.not_wanted) };
}

export function verifyLead(ctx: AiContext, s: LeadSnapshot, today: string): Promise<TaskResult<VerifyResult>> {
  const epoch = new Date(0).toISOString();
  const rows: LeadFieldRow[] = s.fields.map((f) => ({
    id: f.id,
    lead_id: f.leadId,
    field: f.field as LeadFieldRow["field"],
    value: f.value,
    source: f.source as LeadFieldRow["source"],
    source_ref: f.sourceRef,
    status: f.status,
    excerpt: f.excerpt,
    seen_at: f.seenAt ?? epoch,
  }));
  const shown = displayOf(null, rows);
  const company = {
    ref: "L1",
    name: s.best?.name ?? shown.name,
    city: s.best?.city ?? shown.city,
    state: s.best?.state ?? null,
    website: s.best?.website ?? shown.website,
    phone: s.best?.phone ?? shown.phone,
  };
  return runTask(ctx, deepDef, { rigor: "careful", kinds: DEEP_KINDS, profile: profileOf(s.companyProfile), request: DEEP_REQUEST, today, companies: [company] });
}
