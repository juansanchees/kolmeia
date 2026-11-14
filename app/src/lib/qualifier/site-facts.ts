import { hostOf } from "@/lib/safe-url";
import type { Found } from "./site/extract";
import type { SiteRead } from "./site/reader";
import type { FieldIn, FieldRow, LeadSnapshot } from "./types";

// Pure: what a site read adds to a lead, and what it refutes. Only values written on the page, each with its URL and
// excerpt; a value the lead already holds as confirmed (any source) is not added again.

const IMPORT_LIKE = new Set(["import", "apify_maps", "apollo", "research"]);
const MAX_ROWS = 40;
const fold = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const digits = (s: string) => s.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

/** Comparison form of a value: by kind, the same thing the database keys on. */
function norm(field: string, value: string): string {
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

  const have = new Set(s.fields.filter((f) => f.status === "confirmed").map((f) => `${f.field}:${norm(f.field, f.value)}`));
  const add: FieldIn[] = [];
  const push = (field: string, value: string, url: string, excerpt: string | null) => {
    const id = `${field}:${norm(field, value)}`;
    if (!norm(field, value) || have.has(id) || add.length >= MAX_ROWS) return;
    have.add(id);
    add.push({ field, value: value.slice(0, 1000), source: "site", source_ref: url, status: "confirmed", excerpt: excerpt ? excerpt.slice(0, 300) : null });
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
