"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { IMPORT_FIELDS } from "@/lib/imports/fields";
import { IMPORT_LIMITS } from "@/lib/imports/parse";
import { revalidateRow, type ImportRow, type RowError } from "@/lib/imports/rows";
import { createImport, finishImport, importRows, previewRows, undoImport } from "@/lib/imports/store";
import { createClient } from "@/lib/supabase/server";
import { requireSender } from "@/lib/workspace";
import { getT } from "@/lib/i18n/server";

type Fail = { ok: false; error: string };
const uuid = z.string().uuid();
const generic = async (): Promise<Fail> => ({ ok: false, error: (await getT()).imports.errors.generic });

const metaSchema = z.object({
  fileName: z.string().trim().min(1).transform((s) => s.slice(0, 200)),
  sheetName: z.string().max(100).nullable(),
  listName: z.string().trim().min(1).max(80),
  mapping: z.array(z.enum(IMPORT_FIELDS).nullable()).max(500),
  useAsTraining: z.boolean(),
});
const rowsSchema = z.array(z.object({ row: z.number().int().min(1).max(IMPORT_LIMITS.maxRows) }).passthrough()).max(IMPORT_LIMITS.batch);

async function session() {
  const workspace = await requireSender();
  const db = await createClient();
  return db ? { workspace, db } : null;
}

export async function startImportAction(meta: unknown): Promise<{ ok: true; importId: string } | Fail> {
  const s = await session();
  const parsed = metaSchema.safeParse(meta);
  if (!s || !parsed.success) return generic();
  try {
    return { ok: true, importId: await createImport(s.db, s.workspace.id, parsed.data) };
  } catch {
    return generic();
  }
}

export async function previewBatchAction(importId: string, rows: unknown): Promise<{ ok: true; existing: [number, string | null][] } | Fail> {
  const s = await session();
  const parsed = rowsSchema.safeParse(rows);
  if (!s || !uuid.safeParse(importId).success || !parsed.success) return generic();
  // The server's verdict: rows that fail are simply not looked up.
  const valid = (parsed.data as unknown as ImportRow[]).map(revalidateRow).filter((r): r is ImportRow => !("error" in r));
  try {
    return { ok: true, existing: [...(await previewRows(s.db, importId, valid)).entries()] };
  } catch {
    return generic();
  }
}

export async function importBatchAction(importId: string, rows: unknown): Promise<{ ok: true; new: number; merged: number; errors: number } | Fail> {
  const s = await session();
  const parsed = rowsSchema.safeParse(rows);
  if (!s || !uuid.safeParse(importId).success || !parsed.success) return generic();
  const checked = (parsed.data as unknown as (ImportRow | RowError)[]).map(revalidateRow);
  try {
    const r = await importRows(s.db, importId, checked);
    revalidatePath("/leads", "layout");
    revalidatePath("/inicio");
    return { ok: true, ...r };
  } catch {
    return generic();
  }
}

export async function finishImportAction(importId: string): Promise<{ ok: true } | Fail> {
  const s = await session();
  if (!s || !uuid.safeParse(importId).success) return generic();
  try {
    await finishImport(s.db, importId);
    revalidatePath("/leads", "layout");
    revalidatePath("/inicio");
    return { ok: true };
  } catch {
    return generic();
  }
}

export async function undoImportAction(importId: string): Promise<{ ok: true; deleted: number; kept: number } | Fail> {
  const s = await session();
  if (!s || !uuid.safeParse(importId).success) return generic();
  try {
    const r = await undoImport(s.db, importId);
    revalidatePath("/leads", "layout");
    revalidatePath("/inicio");
    return { ok: true, ...r };
  } catch {
    return generic();
  }
}
