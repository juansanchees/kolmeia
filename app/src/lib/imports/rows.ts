// Row validation for "Subir lista": pure, runs in the browser. A row with any error is not imported.
import { dedupe, domainKey, nameKey, phoneKey } from "@/lib/research/dedupe";
import { hostOf, sanitizeUrl } from "@/lib/safe-url";
import type { ImportField, Mapping } from "./fields";

export type ImportRow = { row: number; name: string; name_key: string } & Partial<Record<Exclude<ImportField, "name">, string | null>>;
export type RowErrorCode = "empty" | "phone" | "email" | "website" | "too_long";
export type RowError = { row: number; error: RowErrorCode; data: Record<string, string> };

export const WEBMAIL_HOSTS: readonly string[] = [
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "aol.com",
  "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "comcast.net", "verizon.net", "att.net", "gmx.com",
];
export const IMPORT_CAPS = { name: 200, field: 300, note: 1000 };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** null = blank row (skipped, not an error). Cell text is kept verbatim: a formula or markup is only ever text. */
export function mapRow(cells: string[], mapping: Mapping, row: number): ImportRow | RowError | null {
  const v: Partial<Record<ImportField, string>> = {};
  const data: Record<string, string> = {};
  let any = false;
  mapping.forEach((f, i) => {
    const raw = (cells[i] ?? "").trim();
    if (raw) any = true;
    if (f && raw && v[f] === undefined) {
      v[f] = raw;
      data[f] = raw.length > IMPORT_CAPS.note ? raw.slice(0, IMPORT_CAPS.note) : raw;
    }
  });
  if (!any) return null;
  const fail = (error: RowErrorCode): RowError => ({ row, error, data });

  for (const f of Object.keys(v) as ImportField[]) {
    const cap = f === "name" ? IMPORT_CAPS.name : f === "note" ? IMPORT_CAPS.note : IMPORT_CAPS.field;
    if (v[f]!.length > cap) return fail("too_long");
  }
  if (!v.name && !v.website && !v.phone && !v.email) return fail("empty");
  // Excel shows long numbers as 5.09E+09: the digits are lost, so never guess a number from them.
  if (v.phone && (/^[\d.,]+e[+-]?\d+$/i.test(v.phone) || !phoneKey(v.phone))) return fail("phone");
  if (v.email && (v.email.length > 254 || !EMAIL.test(v.email))) return fail("email");
  let website: string | null = null;
  if (v.website) {
    website = sanitizeUrl(/^[a-z][a-z0-9+.-]*:/i.test(v.website) ? v.website : `https://${v.website}`);
    if (!website) return fail("website");
  } else if (v.email) {
    const domain = v.email.slice(v.email.lastIndexOf("@") + 1).toLowerCase();
    if (!WEBMAIL_HOSTS.includes(domain) && domainKey(`https://${domain}`)) website = `https://${domain}`;
  }
  const name = v.name || (website ? hostOf(website) : null) || v.email || v.phone;
  if (!name) return fail("empty");
  const out: ImportRow = { row, name, name_key: nameKey(name) };
  out.website = website;
  for (const f of ["phone", "email", "address", "city", "state", "zip", "contact_name", "contact_title", "note"] as const) out[f] = v[f] ?? null;
  return out;
}

/** "merged" when the database found a lead for the row (existing) OR an earlier row of the file is the same company. */
export function previewOutcomes(rows: ImportRow[], existing: Map<number, string | null>): { row: number; outcome: "new" | "merged" }[] {
  const pending = rows.filter((r) => !existing.get(r.row));
  const fresh = new Set(dedupe([], pending.map((r) => ({ name: r.name, website: r.website, phone: r.phone, row: r.row }))).fresh.map((r) => r.row));
  return rows.map((r) => ({ row: r.row, outcome: existing.get(r.row) || !fresh.has(r.row) ? "merged" : "new" }));
}
