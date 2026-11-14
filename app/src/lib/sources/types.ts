// Shared types for the connected sources (Apify, Apollo). Pure types, no runtime code.
import type { ImportRow } from "@/lib/imports/rows";

/** Apify run states (REST "data.status"). */
export type ApifyStatus = "READY" | "RUNNING" | "SUCCEEDED" | "FAILED" | "ABORTED" | "TIMED-OUT" | "ABORTING" | "TIMING-OUT";

export const APIFY_TERMINAL: readonly ApifyStatus[] = ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"];

/**
 * A row as it goes into the import path. F3c-1's `ImportRow` (row, name, name_key + text fields) plus the two extra
 * values a Maps place brings. Task 1's SQL (import_rows_core) decides which keys it accepts: adapt here if it differs.
 */
export type ImportRowIn = ImportRow & { place_id?: string; company_type?: string };
