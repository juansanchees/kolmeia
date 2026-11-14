// Row validation for "Subir lista": pure, runs in the browser. A row with any error is not imported.
import { dedupe, domainKey, nameKey, phoneKey } from "@/lib/research/dedupe";
import { hostOf, sanitizeUrl } from "@/lib/safe-url";
import { fill, t } from "@/messages/pt";
import { IMPORT_FIELDS, type ImportField, type Mapping } from "./fields";

export type ImportRow = { row: number; name: string; name_key: string } & Partial<Record<Exclude<ImportField, "name">, string>>;
export type RowErrorCode = "empty" | "phone" | "email" | "website" | "too_long";
export type RowError = { row: number; error: RowErrorCode; data: Record<string, string> };

export const WEBMAIL_HOSTS: readonly string[] = [
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "aol.com",
  "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "comcast.net", "verizon.net", "att.net", "gmx.com",
];
export const IMPORT_CAPS = { name: 200, field: 300, note: 1000 };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trims ASCII and unicode spaces (NBSP, en/em spaces, zero-width space, ideographic space), as the server's [[:space:]] does. */
const trimU = (s: string) => s.replace(/^[\s\u200b]+|[\s\u200b]+$/g, "");

/**
 * null = blank row (skipped, not an error). Cell text is kept verbatim: a formula or markup is only ever text.
 * `row` is the DATA-row index, 1..5000 (the header is not counted); the server accepts only that range.
 * Empty values are omitted from the result (never JSON null): the server rejects a null where it expects a string.
 */
export function mapRow(cells: string[], mapping: Mapping, row: number): ImportRow | RowError | null {
  const v: Partial<Record<ImportField, string>> = {};
  const data: Record<string, string> = {};
  let any = false;
  mapping.forEach((f, i) => {
    const raw = trimU(cells[i] ?? "");
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
  // The server caps the final values: name 200, website 300 (the fallback name and the normalised URL can be longer than the cell).
  if (name.length > IMPORT_CAPS.name || (website && website.length > IMPORT_CAPS.field)) return fail("too_long");
  const out: ImportRow = { row, name, name_key: nameKey(name) };
  if (website) out.website = website;
  for (const f of ["phone", "email", "address", "city", "state", "zip", "contact_name", "contact_title", "note"] as const) if (v[f]) out[f] = v[f];
  return out;
}

/** "merged" when the database found a lead for the row (existing) OR an earlier row of the file is the same company. */
export function previewOutcomes(rows: ImportRow[], existing: Map<number, string | null>): { row: number; outcome: "new" | "merged" }[] {
  const pending = rows.filter((r) => !existing.get(r.row));
  const fresh = new Set(dedupe([], pending.map((r) => ({ name: r.name, website: r.website, phone: r.phone, row: r.row }))).fresh.map((r) => r.row));
  return rows.map((r) => ({ row: r.row, outcome: existing.get(r.row) || !fresh.has(r.row) ? "merged" : "new" }));
}

const ERROR_CODES: readonly RowErrorCode[] = ["empty", "phone", "email", "website", "too_long"];

/**
 * The server's verdict (R1): never trust a row the browser called valid. A RowError passes through with its data capped
 * and reduced to known text fields; an ImportRow is rebuilt from its known text fields and run through mapRow again
 * (unknown keys dropped, name_key recomputed, every rule re-applied). `row` is kept.
 */
export function revalidateRow(r: ImportRow | RowError): ImportRow | RowError {
  const raw = r as unknown as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  if ("error" in r) {
    const src = raw.data && typeof raw.data === "object" ? (raw.data as Record<string, unknown>) : {};
    const data: Record<string, string> = {};
    for (const f of IMPORT_FIELDS) {
      const v = text(src[f]);
      if (v) data[f] = v.length > IMPORT_CAPS.note ? v.slice(0, IMPORT_CAPS.note) : v;
    }
    const error = ERROR_CODES.includes(raw.error as RowErrorCode) ? (raw.error as RowErrorCode) : "empty";
    return { row: r.row, error, data };
  }
  const out = mapRow(IMPORT_FIELDS.map((f) => text(raw[f])), [...IMPORT_FIELDS], r.row);
  return out ?? { row: r.row, error: "empty", data: {} };
}

/** Header = first row; every later row gets its DATA-row index (1 = the first row under the header). Blank rows are skipped but keep their place. */
export function mapGrid(grid: string[][], mapping: Mapping): (ImportRow | RowError)[] {
  const out: (ImportRow | RowError)[] = [];
  for (let i = 1; i < grid.length; i++) {
    const r = mapRow(grid[i], mapping, i);
    if (r) out.push(r);
  }
  return out;
}

/** "linha 7: telefone inválido (formate a coluna como texto no Excel)". */
export function rowErrorText(row: number, code: RowErrorCode): string {
  const hint = (t.imports.rowErrorHints as Partial<Record<RowErrorCode, string>>)[code];
  const base = t.imports.rowErrors[code];
  return fill(t.imports.rowError, { row, error: hint ? `${base} (${hint})` : base });
}
