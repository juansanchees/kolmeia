import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Mapping } from "./fields";
import type { ImportRow, RowError } from "./rows";

export type ImportListItem = {
  id: string;
  list_name: string;
  file_name: string;
  status: "importing" | "done" | "undone";
  row_count: number;
  new_count: number;
  merged_count: number;
  error_count: number;
  created_at: string;
};

export type ImportMeta = { fileName: string; sheetName: string | null; listName: string; mapping: Mapping; useAsTraining: boolean };

/** Database errors are rethrown with their message only, never with row data. */
function fail(label: string, error: { message: string }): never {
  throw new Error(`${label}: ${error.message}`);
}

export async function createImport(db: SupabaseClient, ws: string, meta: ImportMeta): Promise<string> {
  const { data, error } = await db.rpc("create_lead_import", {
    p_ws: ws,
    p_file_name: meta.fileName,
    p_sheet_name: meta.sheetName,
    p_list_name: meta.listName,
    p_mapping: { columns: meta.mapping },
    p_use_as_training: meta.useAsTraining,
  });
  if (error) fail("createImport", error);
  return String(data);
}

/** row number -> the lead the row would join (null = new). */
export async function previewRows(db: SupabaseClient, importId: string, rows: ImportRow[]): Promise<Map<number, string | null>> {
  const { data, error } = await db.rpc("preview_import_rows", { p_import: importId, p_rows: rows });
  if (error) fail("previewRows", error);
  return new Map(((data ?? []) as { row: number; lead_id: string | null }[]).map((r) => [r.row, r.lead_id]));
}

export async function importRows(db: SupabaseClient, importId: string, rows: (ImportRow | RowError)[]): Promise<{ new: number; merged: number; errors: number }> {
  const { data, error } = await db.rpc("import_lead_rows", { p_import: importId, p_rows: rows });
  if (error) fail("importRows", error);
  const r = (data ?? {}) as { new?: number; merged?: number; errors?: number };
  return { new: r.new ?? 0, merged: r.merged ?? 0, errors: r.errors ?? 0 };
}

export async function finishImport(db: SupabaseClient, importId: string): Promise<void> {
  const { error } = await db.rpc("finish_lead_import", { p_import: importId });
  if (error) fail("finishImport", error);
}

export async function undoImport(db: SupabaseClient, importId: string): Promise<{ deleted: number; kept: number }> {
  const { data, error } = await db.rpc("undo_lead_import", { p_import: importId });
  if (error) fail("undoImport", error);
  const r = (data ?? {}) as { deleted?: number; kept?: number };
  return { deleted: r.deleted ?? 0, kept: r.kept ?? 0 };
}

export async function listImports(db: SupabaseClient, ws: string): Promise<ImportListItem[]> {
  const { data, error } = await db
    .from("lead_imports")
    .select("id, list_name, file_name, status, row_count, new_count, merged_count, error_count, created_at")
    .eq("workspace_id", ws)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) fail("listImports", error);
  return (data ?? []) as ImportListItem[];
}
