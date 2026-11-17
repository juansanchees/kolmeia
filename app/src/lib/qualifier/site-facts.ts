import { hostOf } from "@/lib/safe-url";
import { cut, type Found } from "./site/extract";
import type { SiteRead } from "./site/reader";
import type { FieldIn, FieldRow, LeadSnapshot } from "./types";

// Pure: what a site read adds to a lead, and what it refutes. Only values written on the page, each with its URL and
// excerpt; a value the lead already holds as confirmed (any source) is not added again.

const IMPORT_LIKE = new Set(["import", "apify_maps", "apollo", "shovels", "research"]);
const MAX_ROWS = 40;
const fold = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const digits = (s: string) => s.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

/** Comparison form of a value: by kind, the same thing the database keys on. */
export function fieldKey(field: string, value: string): string {
  if (field === "phone") return digits(value);
  if (field === "email") return value.trim().toLowerCase();
  if (field === "website") return hostOf(value) ?? fold(value);
  return fold(value);
}

/** The website the cascade reads: a confirmed one first, else the oldest non-refuted one. */
export function siteField(s: LeadSnapshot): FieldRow | null {
  const live = s.fields.filter((f) => f.field === "website" && f.status !== "refuted");
  return live.find((f) => f.status === "confirmed") ?? live[0] ?? null;
}

export function factsToFields(read: SiteRead, s: LeadSnapshot): { add: FieldIn[]; refute: string[] } {
  if (read.outcome === "site_down") {
    const w = siteField(s);
    return { add: [], refute: w && IMPORT_LIKE.has(w.source) ? [w.id] : [] };
  }
  if (read.outcome !== "ok" || !read.finalHome) return { add: [], refute: [] };

  const have = new Set(s.fields.filter((f) => f.status === "confirmed").map((f) => `${f.field}:${fieldKey(f.field, f.value)}`));
  const add: FieldIn[] = [];
  const push = (field: string, value: string, url: string, excerpt: string | null) => {
    const id = `${field}:${fieldKey(field, value)}`;
    // a value over the database's 1000 characters is skipped, never cut into a different value
    if (!fieldKey(field, value) || [...value].length > 1000 || have.has(id) || add.length >= MAX_ROWS) return;
    have.add(id);
    add.push({ field, value, source: "site", source_ref: url, status: "confirmed", excerpt: excerpt ? cut(excerpt, 300) : null });
  };

  push("website", read.finalHome, read.finalHome, "Página inicial lida");
  const one = (field: string, f: Found | null) => f && push(field, f.value, f.url, f.excerpt);
  for (const p of read.pages) {
    for (const f of p.facts.phones) push("phone", f.value, f.url, f.excerpt);
    for (const f of p.facts.emails) push("email", f.value, f.url, f.excerpt);
  }
  for (const field of ["address", "city", "state", "zip"] as const) {
    const first = read.pages.map((p) => p.facts[field]).find((f) => f !== null) ?? null;
    one(field, first);
  }
  return { add, refute: [] };
}

/** The fields as the cascade now sees them: what was added counts as confirmed, what was refuted as refuted. */
export function liveFields(s: LeadSnapshot, add: FieldIn[], refute: string[]): FieldRow[] {
  const added: FieldRow[] = add.map((a, i) => ({
    id: `new:${i}`,
    leadId: s.leadId,
    field: a.field,
    value: a.value,
    source: a.source,
    sourceRef: a.source_ref ?? null,
    status: a.status ?? "unverified",
    excerpt: a.excerpt ?? null,
    seenAt: null,
  }));
  return [...s.fields.map((f) => (refute.includes(f.id) ? { ...f, status: "refuted" as const } : f)), ...added];
}

/** Level the lead holds now, from what this pass wrote: never below the one the database reported (levels 3-4 come from research). */
export function liveLevel(base: number, fields: FieldRow[]): number {
  const live = fields.filter((f) => f.status !== "refuted");
  const ok = (name: string) => live.some((f) => f.field === name && f.status === "confirmed");
  const reach = live.some((f) => f.field === "phone" || f.field === "email");
  const own = ok("active_project") ? 4 : ok("contact_name") && ok("contact_title") ? 3 : ok("website") && ok("address") ? 2 : reach ? 1 : 0;
  return Math.max(base, own);
}
