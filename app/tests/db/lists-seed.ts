import { nameKey } from "@/lib/research/dedupe";
import { as, type TestDb } from "./helpers";

// Seeds for the list-import tests (0011): everything goes through the real RPCs as the logged-in user. Fictional data only.

export type ImportRowIn =
  | {
      row: number;
      name: string;
      name_key: string;
      website?: string;
      phone?: string;
      email?: string;
      address?: string;
      city?: string;
      state?: string;
      zip?: string;
      contact_name?: string;
      contact_title?: string;
      note?: string;
    }
  | { row: number; error: string; data: Record<string, unknown> };

/** A row to import; `name_key` is filled with the app's nameKey. */
export function row(n: number, name: string, extra: Partial<Extract<ImportRowIn, { name: string }>> = {}): ImportRowIn {
  return { row: n, name, name_key: nameKey(name), ...extra };
}

export type ImportResult = { new: number; merged: number; errors: number };

/** Create + import in batches of 500 + finish, as the user. */
export async function seedImport(
  db: TestDb,
  user: string,
  ws: string,
  rows: ImportRowIn[],
  opts: { listName?: string } = {},
): Promise<{ importId: string; result: ImportResult }> {
  const importId = (
    await db.query<{ id: string }>(as(user), "select public.create_lead_import($1,$2,null,$3,'{}'::jsonb,false) as id", [ws, "lista.csv", opts.listName ?? "Lista teste"])
  )[0].id;
  const result: ImportResult = { new: 0, merged: 0, errors: 0 };
  for (let i = 0; i < rows.length; i += 500) {
    const r = (await db.query<{ r: ImportResult }>(as(user), "select public.import_lead_rows($1,$2::jsonb) as r", [importId, JSON.stringify(rows.slice(i, i + 500))]))[0].r;
    result.new += r.new;
    result.merged += r.merged;
    result.errors += r.errors;
  }
  await db.query(as(user), "select public.finish_lead_import($1)", [importId]);
  return { importId, result };
}
