import type { KbSource } from "./sources";
export { KB_SOURCES, type KbSource } from "./sources";

/** One item for `public.kb_ingest(p_items jsonb)` (0040). Keys outside these lists are rejected by the function. */
export type KbValueInput = { field: string; value: string; source: KbSource; source_url?: string; seen_at: string; confidence?: "high" | "medium" | "low" };
export type KbPersonInput = { name: string; name_key: string; title?: string; license?: string; source: KbSource; source_url?: string; seen_at: string };
export type KbSignalInput = {
  kind: "permit" | "project";
  source: KbSource;
  source_ref: string;
  address?: string;
  town?: string;
  value_usd?: number;
  work_class?: string;
  use?: string;
  issued_on?: string;
  description?: string;
  source_url?: string;
  applicant_name?: string;
  permit_no?: string;
};
export type KbCompanyInput = { name: string; name_key: string; website?: string; phone?: string; address?: string; city?: string; state?: string; zip?: string; company_type?: string };
export type KbItem = {
  company_id?: string;
  match_only?: boolean;
  /** Only a `match_only` item that carries signals may omit it (a permit with no identifiable company). */
  company?: KbCompanyInput;
  values?: KbValueInput[];
  people?: KbPersonInput[];
  signals?: KbSignalInput[];
  site_read?: { outcome: string };
};

export type Mapped = { items: KbItem[]; skipped: Record<string, number> };
