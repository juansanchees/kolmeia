import "server-only";
import { z } from "zod";
import { COMPANY_TYPES, type CompanyType } from "@/lib/research/types";
import { runTask, type AiContext, type TaskDef, type TaskResult } from "./gateway";
import { MODELS } from "./models";
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
