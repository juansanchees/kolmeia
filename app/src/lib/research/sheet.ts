// The spreadsheet view and the CSV export share one column list: the 24 columns of the gold "Ligar direto" sheet
// (docs/pesquisa-padrao-ouro.md, G6) plus approach, supplier portal and the user's decision.
import { t } from "@/messages/pt";
import type { CandidateRow, JobRow } from "./rows";

const L = t.research.labels;
const H = t.research.sheet;

export type ColumnKind = "text" | "number" | "money" | "date" | "url" | "pill";
export type Column = { id: string; header: string; kind: ColumnKind; compact: boolean; get: (c: CandidateRow) => string | number | null };

export const SHEET_COLUMNS: Column[] = [
  { id: "name", header: H.name, kind: "text", compact: true, get: (c) => c.name },
  { id: "askFor", header: H.askFor, kind: "text", compact: true, get: (c) => c.ask_for_name },
  { id: "title", header: H.title, kind: "text", compact: true, get: (c) => c.ask_for_title },
  { id: "confidence", header: H.confidence, kind: "pill", compact: true, get: (c) => (c.name_confidence ? L.confidence[c.name_confidence] : null) },
  { id: "temperature", header: H.temperature, kind: "pill", compact: true, get: (c) => (c.temperature ? L.temperatureTitle[c.temperature] : null) },
  { id: "phone", header: H.phone, kind: "text", compact: true, get: (c) => c.phone },
  { id: "email", header: H.email, kind: "text", compact: false, get: (c) => c.public_email },
  { id: "emailType", header: H.emailType, kind: "text", compact: false, get: (c) => (c.email_type ? L.emailType[c.email_type] : null) },
  { id: "website", header: H.website, kind: "url", compact: false, get: (c) => c.website },
  { id: "city", header: H.city, kind: "text", compact: true, get: (c) => c.city },
  { id: "region", header: H.region, kind: "text", compact: false, get: (c) => c.region ?? c.state },
  { id: "permits", header: H.permits, kind: "number", compact: true, get: (c) => c.permit_count },
  { id: "totalValue", header: H.totalValue, kind: "money", compact: true, get: (c) => c.total_value_usd },
  { id: "lastPermit", header: H.lastPermit, kind: "date", compact: true, get: (c) => c.last_permit_date },
  { id: "jobAddress", header: H.jobAddress, kind: "text", compact: false, get: (c) => c.biggest_job_address },
  { id: "jobValue", header: H.jobValue, kind: "money", compact: true, get: (c) => c.biggest_job_value_usd },
  { id: "jobType", header: H.jobType, kind: "text", compact: false, get: (c) => c.biggest_job_type },
  { id: "jobDescription", header: H.jobDescription, kind: "text", compact: false, get: (c) => c.biggest_job_description },
  { id: "hook", header: H.hook, kind: "text", compact: true, get: (c) => c.hook },
  { id: "rating", header: H.rating, kind: "number", compact: false, get: (c) => c.google_rating },
  { id: "reviews", header: H.reviews, kind: "number", compact: false, get: (c) => c.review_count },
  { id: "signalMatch", header: H.signalMatch, kind: "text", compact: false, get: (c) => c.signal_match },
  { id: "nameSource", header: H.nameSource, kind: "url", compact: false, get: (c) => c.name_source_url },
  { id: "nameNote", header: H.nameNote, kind: "text", compact: false, get: (c) => c.name_note },
  { id: "approach", header: H.approach, kind: "text", compact: true, get: (c) => (c.approach ? L.approach[c.approach] : null) },
  { id: "portal", header: H.portal, kind: "url", compact: false, get: (c) => c.supplier_portal_url },
  { id: "decision", header: H.decision, kind: "text", compact: false, get: (c) => L.decision[c.user_decision] || null },
  // Finding 5: where the phone was seen; empty = the phone is shown as unverified.
  { id: "phoneSource", header: H.phoneSource, kind: "url", compact: false, get: (c) => (c.phone ? c.phone_source_url : null) },
  { id: "foundAt", header: H.foundAt, kind: "url", compact: false, get: (c) => c.found_at_url },
];

// ---------------------------------------------------------------- tabs (G1, G10)
// Order fixed by the brief: Ligar direto · Grandes · Empresas novas · Com sinal · Todos · Obras sem construtora.
export const TABS = ["call", "supplier", "new", "signal", "all", "jobs"] as const;
export type Tab = (typeof TABS)[number];

const TEMP_ORDER = { very_hot: 0, hot: 1, warm: 2, cold: 3 } as const;

export function hasSignal(c: CandidateRow): boolean {
  return (c.permit_count ?? 0) > 0 || Boolean(c.biggest_job_address);
}

/** A company the second pass refuted shows only in "Todos" (finding 11). The jobs tab holds jobs, not companies. */
export function inTab(c: CandidateRow, tab: Tab): boolean {
  const refuted = c.second_pass === "refuted";
  switch (tab) {
    case "call":
      return c.approach === "call" && !refuted;
    case "supplier":
      return c.approach === "supplier_signup" && !refuted;
    case "new":
      return c.entry_path === "signal" && !refuted;
    case "signal":
      return hasSignal(c) && !refuted;
    case "all":
      return true;
    case "jobs":
      return false;
  }
}

export function byTemperature(a: CandidateRow, b: CandidateRow): number {
  const ta = a.temperature ? TEMP_ORDER[a.temperature] : 4;
  const tb = b.temperature ? TEMP_ORDER[b.temperature] : 4;
  return ta - tb || (b.biggest_job_value_usd ?? 0) - (a.biggest_job_value_usd ?? 0) || a.name.localeCompare(b.name);
}

export function coverage(rows: CandidateRow[]) {
  return {
    total: rows.length,
    name: rows.filter((c) => c.ask_for_name).length,
    phone: rows.filter((c) => c.phone).length,
    site: rows.filter((c) => c.website).length,
    email: rows.filter((c) => c.public_email).length,
  };
}

// ---------------------------------------------------------------- CSV
const BOM = "﻿";

const PHONE = /^\+[\d\s().-]+$/;

/**
 * One CSV cell: quoted when needed; cells that a spreadsheet would run as a formula are prefixed with '. In the
 * phone column a plain international number ("+1 508-555-0199") is left as is (finding 16).
 */
export function csvCell(v: string | number | null | undefined, phone = false): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === "string" && !(phone && PHONE.test(s))) s = `'${s}`;
  return /[",\r\n;]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8 with BOM (Excel opens accents correctly), CRLF line endings, every column in SHEET_COLUMNS order. */
export function toCsv(rows: CandidateRow[], columns: Column[] = SHEET_COLUMNS): string {
  const lines = [columns.map((c) => csvCell(c.header)).join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvCell(c.get(r), c.id === "phone")).join(","));
  return BOM + lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------- jobs without a builder (G10)
const J = t.research.jobs;
export type JobColumn = { id: string; header: string; kind: ColumnKind; get: (j: JobRow) => string | number | null };

export const JOB_SHEET_COLUMNS: JobColumn[] = [
  { id: "address", header: J.address, kind: "text", get: (j) => j.address },
  { id: "project", header: J.project, kind: "text", get: (j) => j.project_name },
  { id: "type", header: J.type, kind: "text", get: (j) => j.job_type },
  { id: "value", header: J.value, kind: "money", get: (j) => j.declared_value_usd },
  { id: "date", header: J.date, kind: "date", get: (j) => j.job_date },
  { id: "source", header: J.source, kind: "url", get: (j) => j.source_url },
  { id: "excerpt", header: J.excerpt, kind: "text", get: (j) => j.excerpt || null },
  { id: "seen", header: J.seen, kind: "date", get: (j) => (j.seen_at ? j.seen_at.slice(0, 10) : null) },
];

export function toJobsCsv(rows: JobRow[]): string {
  const lines = [JOB_SHEET_COLUMNS.map((c) => csvCell(c.header)).join(",")];
  for (const r of rows) lines.push(JOB_SHEET_COLUMNS.map((c) => csvCell(c.get(r))).join(","));
  return BOM + lines.join("\r\n") + "\r\n";
}
