// Reading the uploaded file in the browser: CSV (`,` or `;`, BOM) and XLSX (read-excel-file). The raw file is never sent.
import { parseCsv } from "@/lib/leads/baseline";

export const IMPORT_LIMITS = { maxBytes: 5 * 1024 * 1024, maxRows: 5000, batch: 500 };

export class ImportFileError extends Error {
  constructor(public code: "tooBig" | "tooManyRows" | "unreadable") {
    super(code);
    this.name = "ImportFileError";
  }
}

/** `;` when the first line has more `;` than `,` outside quotes (Excel in pt-BR), else `,`. */
export function parseDelimited(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let commas = 0;
  let semis = 0;
  let quoted = false;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch === ",") commas++;
    else if (!quoted && ch === ";") semis++;
  }
  return parseCsv(s, semis > commas ? ";" : ",");
}

/** Spreadsheet cells to text. Numbers are not rewritten; dates become YYYY-MM-DD. */
export function sheetRows(raw: unknown[][]): string[][] {
  return raw.map((r) =>
    r.map((c) => {
      if (c === null || c === undefined) return "";
      if (c instanceof Date) return Number.isNaN(c.getTime()) ? "" : c.toISOString().slice(0, 10);
      if (typeof c === "number") return String(c);
      if (typeof c === "boolean") return c ? "true" : "false";
      return String(c).trim();
    }),
  );
}

const isBlank = (r: string[]) => r.every((c) => c.trim() === "");

/** Client only. Header = first non-blank row; more than `maxRows` data rows throws. */
export async function readFileGrid(file: File, sheet?: string): Promise<{ sheets: string[]; sheet: string | null; rows: string[][] }> {
  if (file.size > IMPORT_LIMITS.maxBytes) throw new ImportFileError("tooBig");
  const name = file.name.toLowerCase();
  let sheets: string[] = [];
  let chosen: string | null = null;
  let grid: string[][];
  try {
    if (name.endsWith(".csv") || file.type === "text/csv") {
      grid = parseDelimited(await file.text());
    } else if (name.endsWith(".xlsx")) {
      const { default: readXlsxFile } = await import("read-excel-file/browser");
      const all = await readXlsxFile(file);
      sheets = all.map((s) => s.sheet);
      const pick = all.find((s) => s.sheet === sheet) ?? all[0];
      if (!pick) throw new ImportFileError("unreadable");
      chosen = pick.sheet;
      grid = sheetRows(pick.data as unknown[][]);
    } else {
      throw new ImportFileError("unreadable");
    }
  } catch (e) {
    throw e instanceof ImportFileError ? e : new ImportFileError("unreadable");
  }
  const first = grid.findIndex((r) => !isBlank(r));
  const rows = first < 0 ? [] : grid.slice(first);
  if (rows.length - 1 > IMPORT_LIMITS.maxRows) throw new ImportFileError("tooManyRows");
  return { sheets, sheet: chosen, rows };
}
