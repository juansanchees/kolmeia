// Column detection for "Subir lista" (no AI): a header equal, once folded, to a known alias maps to a field.
export const IMPORT_FIELDS = ["name", "website", "phone", "email", "address", "city", "state", "zip", "contact_name", "contact_title", "note"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
/** One entry per column of the file; null = ignored. */
export type Mapping = (ImportField | null)[];

const ALIASES: Record<ImportField, string[]> = {
  name: ["company", "empresa", "name", "nome", "company name", "business", "business name"],
  website: ["website", "site", "url", "web", "homepage"],
  phone: ["phone", "tel", "telefone", "telephone", "phone number", "celular"],
  email: ["email", "e mail", "mail"],
  address: ["address", "endereco", "street"],
  city: ["city", "cidade", "town"],
  state: ["state", "estado", "st"],
  zip: ["zip", "cep", "zip code", "postal code"],
  contact_name: ["contact", "contato", "contact name", "owner", "decision maker"],
  contact_title: ["title", "cargo", "job title", "role"],
  note: ["notes", "note", "obs", "observacao", "observacoes", "nota", "comments"],
};

/** Lower case, accents removed, non-alphanumerics become one space, trimmed. */
export function foldHeader(h: string): string {
  return h
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const BY_ALIAS = new Map<string, ImportField>();
for (const f of IMPORT_FIELDS) for (const a of ALIASES[f]) BY_ALIAS.set(a, f);

/** First column wins; a field is never mapped twice. */
export function detectMapping(headers: string[]): Mapping {
  const used = new Set<ImportField>();
  return headers.map((h) => {
    const f = BY_ALIAS.get(foldHeader(h)) ?? null;
    if (!f || used.has(f)) return null;
    used.add(f);
    return f;
  });
}

export function hasIdColumn(m: Mapping): boolean {
  return m.some((f) => f === "name" || f === "website" || f === "phone" || f === "email");
}
