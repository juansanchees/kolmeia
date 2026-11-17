import { describe, expect, it } from "vitest";
import { t } from "@/messages/pt";
import { readFileSync } from "node:fs";
import { detectMapping, hasIdColumn, type Mapping } from "@/lib/imports/fields";
import { ERROR_DATA_CAP, mapGrid, mapRow, previewOutcomes, revalidateRow, rowErrorText, type ImportRow, type RowError } from "@/lib/imports/rows";
import { IMPORT_LIMITS, ImportFileError, parseDelimited, readFileGrid, sheetRows } from "@/lib/imports/parse";

const m = (...f: (string | null)[]) => f as Mapping;
const asRow = (r: ReturnType<typeof mapRow>) => r as ImportRow;
const asErr = (r: ReturnType<typeof mapRow>) => r as RowError;

describe("detectMapping", () => {
  it("finds English and Portuguese headers and maps a field once", () => {
    expect(detectMapping(["Empresa", "Telefone", "E-mail", "Cidade", "Obs", "X", "Company"])).toEqual(["name", "phone", "email", "city", "note", null, null]);
    expect(detectMapping(["Website", "Contact Name", "Job Title", "ZIP Code"])).toEqual(["website", "contact_name", "contact_title", "zip"]);
    expect(hasIdColumn(detectMapping(["Cidade", "Obs"]))).toBe(false);
    expect(hasIdColumn(detectMapping(["Cidade", "Site"]))).toBe(true);
  });
});

describe("mapRow", () => {
  it("site from a business e-mail, never from webmail; name falls back to host", () => {
    const a = asRow(mapRow(["info@acme.example"], m("email"), 2));
    expect(a.website).toBe("https://acme.example");
    expect(a.name).toBe("acme.example");
    const b = asRow(mapRow(["joe@gmail.com", "508-555-0104"], m("email", "phone"), 3));
    expect(b.website).toBeUndefined();
    expect(b.name).toBe("joe@gmail.com");
  });

  it("errors per row", () => {
    expect(asErr(mapRow(["x"], m("city"), 2)).error).toBe("empty");
    expect(asErr(mapRow(["Acme", "555-0199"], m("name", "phone"), 2)).error).toBe("phone");
    expect(asErr(mapRow(["Acme", "javascript:alert(1)"], m("name", "website"), 2)).error).toBe("website");
    expect(asErr(mapRow(["Acme", "https://linkedin.com/company/x"], m("name", "website"), 2)).error).toBe("website");
    expect(asErr(mapRow(["A".repeat(201)], m("name"), 2)).error).toBe("too_long");
    expect(asErr(mapRow(["Acme", "x".repeat(301)], m("name", "city"), 2)).error).toBe("too_long");
    expect(asRow(mapRow(["Acme", "acme.example"], m("name", "website"), 2)).website).toBe("https://acme.example/");
  });

  it("never loses a row over its e-mail cell", () => {
    const r = (cell: string) => asRow(mapRow(["Acme", cell], m("name", "email"), 2));
    expect(r("a@b").email).toBeUndefined();
    expect(r("user@domain.com, jon@acme.example").email).toBe("jon@acme.example");
    expect(r("user@domain.com; info@acme.example other@acme.example").email).toBe("info@acme.example");
    expect(r(`${"0a".repeat(16)}@sentry-next.wixpress.com, ${"1b".repeat(16)}@sentry.io`).email).toBeUndefined();
    expect(r(`${"0a".repeat(16)}@acme.example, ok@acme.example`).email).toBe("ok@acme.example");
    expect(r("test@example.com, x@example.org").email).toBeUndefined();
    expect(asRow(mapRow(["user@domain.com, kts@acme.example"], m("email"), 3)).website).toBe("https://acme.example");
    expect(asErr(mapRow(["user@domain.com"], m("email"), 4)).error).toBe("empty");
    expect(r("x@gmail.com, y@acme.example").email).toBe("x@gmail.com");
  });

  it("refuses a phone in scientific notation, even one with enough digits", () => {
    expect(asErr(mapRow(["Acme", "5.09E+09"], m("name", "phone"), 2)).error).toBe("phone");
    expect(asErr(mapRow(["Acme", "5.085550103E+09"], m("name", "phone"), 2)).error).toBe("phone");
  });

  it("caps the final name and website, not only the raw cells", () => {
    const longEmail = `${"a".repeat(195)}@gmail.com`;
    expect(asErr(mapRow([longEmail], m("email"), 2)).error).toBe("too_long");
    const site = `http://${"b".repeat(285)}.com`; // 296 chars raw, 297 normalised with a trailing slash: stays ok
    expect(asRow(mapRow(["Acme", site], m("name", "website"), 2)).website!.length).toBeLessThanOrEqual(300);
    const edge = `http://${"b".repeat(289)}.com`; // 300 raw, 301 once normalised
    expect(asErr(mapRow(["Acme", edge], m("name", "website"), 2)).error).toBe("too_long");
  });

  it("produces no null-valued keys and uses the data-row index", () => {
    const r = asRow(mapRow(["Acme", "", "508-555-0105"], m("name", "website", "phone"), 5000));
    expect(r.row).toBe(5000);
    expect(Object.values(r).every((x) => x !== null && x !== undefined)).toBe(true);
    expect(Object.keys(r).sort()).toEqual(["name", "name_key", "phone", "row"]);
  });

  it("unicode spaces are trimmed before validation", () => {
    const r = asRow(mapRow(["Acme", "\u00a0a@acme.example\u3000", "\u00a0508-555-0105 "], m("name", "email", "phone"), 2));
    expect(r.email).toBe("a@acme.example");
    expect(r.phone).toBe("508-555-0105");
  });

  it("blank rows are skipped", () => {
    expect(mapRow(["", "  ", ""], m("name", "phone", null), 5)).toBeNull();
  });

  it("hostile cells: a formula and markup stay text", () => {
    const r = asRow(mapRow(["<script>x</script>", '=HYPERLINK("http://x","y")'], m("name", "note"), 2));
    expect(r.name).toBe("<script>x</script>");
    expect(r.note).toBe('=HYPERLINK("http://x","y")');
    // a huge cell is refused, not stored
    expect(asErr(mapRow(["Acme", "z".repeat(20000)], m("name", "note"), 3)).error).toBe("too_long");
    expect(asErr(mapRow(["Acme", "z".repeat(20000)], m("name", "note"), 3)).data.note.length).toBeLessThanOrEqual(1000);
  });
});

describe("file reading", () => {
  it("parseDelimited reads Excel's semicolon CSV with BOM, CRLF and quoted line breaks", () => {
    const text = '﻿Empresa;Telefone;Obs\r\n"Acme; Test";5085550103;"linha 1\nlinha 2"\r\n\r\nBay;;ok\r\n';
    expect(parseDelimited(text)).toEqual([
      ["Empresa", "Telefone", "Obs"],
      ["Acme; Test", "5085550103", "linha 1\nlinha 2"],
      ["Bay", "", "ok"],
    ]);
    expect(parseDelimited("a,b;c\n1,2;3")).toEqual([["a", "b;c"], ["1", "2;3"]]);
  });

  it("sheetRows turns numbers, dates, booleans and nulls into text", () => {
    expect(sheetRows([[5085550103, new Date("2026-11-14"), true, null, "  x "]])).toEqual([["5085550103", "2026-11-14", "true", "", "x"]]);
  });

  it("trailing blank rows do not count toward the 5,000-row cap", async () => {
    const body = (n: number, blanks: number) => "Company,Phone\n" + Array.from({ length: n }, (_, i) => `C${i},508`).join("\n") + "\n,".repeat(blanks) + "\n";
    const g = await readFileGrid(new File([body(IMPORT_LIMITS.maxRows, 300)], "a.csv", { type: "text/csv" }));
    expect(g.rows).toHaveLength(IMPORT_LIMITS.maxRows + 1);
    await expect(readFileGrid(new File([body(IMPORT_LIMITS.maxRows + 1, 0)], "b.csv", { type: "text/csv" }))).rejects.toBeInstanceOf(ImportFileError);
  });

  it("the XLSX fixture reads as text through read-excel-file", async () => {
    const { default: readXlsxFile } = await import("read-excel-file/node");
    const all = await readXlsxFile(readFileSync("tests/fixtures/import-sample.xlsx"));
    expect(all.map((s) => s.sheet)).toEqual(["Plan1", "Outra"]);
    const rows = sheetRows(all[0].data as unknown[][]);
    expect(rows[0]).toEqual(["Company", "Tel", "Mail", "City", "Obs"]);
    expect(rows[1][1]).toBe("5085550103");
    expect(rows[1][4]).not.toMatch(/^[1-9]/); // formula never evaluated: cached value, text or empty
    const mapping = detectMapping(rows[0]);
    expect(rows.slice(1).map((r, i) => asRow(mapRow(r, mapping, i + 2)).name)).toEqual(["Acme Test Builders", "Bay Test Developers", "Cape Test Homes", "Delta Test HVAC"]);
  });
});

describe("previewOutcomes", () => {
  it("marks in-file duplicates as merged", () => {
    const rows = [asRow(mapRow(["Acme Test Builders"], m("name"), 2)), asRow(mapRow(["ACME TEST BUILDERS, Inc.", "508-555-0102"], m("name", "phone"), 3)), asRow(mapRow(["Zeta"], m("name"), 4))];
    expect(previewOutcomes(rows, new Map())).toEqual([
      { row: 2, outcome: "new" },
      { row: 3, outcome: "merged" },
      { row: 4, outcome: "new" },
    ]);
    expect(previewOutcomes(rows, new Map([[4, "lead-1"]]))[2].outcome).toBe("merged");
  });
});

describe("Task 5 server re-validation and screen helpers", () => {
  it("server re-validation wins over what the browser sent", () => {
    const bad = revalidateRow({ row: 4, name: "Acme Test Builders", name_key: "x", phone: "555-0199" } as ImportRow) as RowError;
    expect(bad.error).toBe("phone");
    expect(bad.row).toBe(4);
    const ok = revalidateRow({ row: 5, name: "Acme Test Builders", name_key: "FORGED", phone: "508-555-0101", evil: "x", website: "https://acme.example" } as unknown as ImportRow) as ImportRow;
    expect(ok.name_key).not.toBe("FORGED");
    expect(ok.name_key).toBe(asRow(mapRow(["Acme Test Builders"], m("name"), 5)).name_key);
    expect(ok.phone).toBe("508-555-0101");
    expect(ok.website).toBe("https://acme.example/");
    expect(revalidateRow(ok)).toEqual(ok);
    expect(Object.keys(ok)).not.toContain("evil");
    expect(ok.row).toBe(5);
    const hostile = revalidateRow({ row: 6, name: "X", name_key: "x", website: "https://javascript:alert(1)" } as ImportRow) as RowError;
    expect(hostile.error).toBe("website");
    const nonText = revalidateRow({ row: 7, name: 5, name_key: null } as unknown as ImportRow) as RowError;
    expect(nonText.error).toBe("empty");
  });
  it("revalidateRow passes a RowError through with its data capped", () => {
    const e = revalidateRow({ row: 9, error: "phone", data: { phone: "x".repeat(5000), junk: "y" } }) as RowError;
    expect(e.error).toBe("phone");
    expect(e.data.phone.length).toBe(ERROR_DATA_CAP);
    expect(e.data.junk).toBeUndefined();
    expect((revalidateRow({ row: 9, error: "bogus", data: {} } as unknown as RowError) as RowError).error).toBe("empty");
  });
  it("mapGrid gives data-row indexes: the header is not counted and blank rows keep their place", () => {
    const grid = [["Empresa", "Telefone"], ["Acme Test Builders", "508-555-0101"], ["", ""], ["Beta Test Co", "5.08E+09"]];
    const out = mapGrid(grid, m("name", "phone"));
    expect(out.map((r) => r.row)).toEqual([1, 3]);
    expect(out[0]).toMatchObject({ row: 1, name: "Acme Test Builders" });
    expect((out[1] as RowError).error).toBe("phone");
  });
  it("the phone error tells the user to format the column as text; the others do not", () => {
    expect(rowErrorText(7, "phone", t)).toBe("linha 7: telefone inválido (formate a coluna como texto no Excel)");
    expect(rowErrorText(8, "email", t)).toBe("linha 8: e-mail inválido");
  });
  it("error rows carry short data, so a batch of 500 stays small", () => {
    const e = mapRow(["x".repeat(900), "123"], m("note", "phone"), 2) as RowError;
    expect(e.error).toBe("phone");
    expect(e.data.note.length).toBe(ERROR_DATA_CAP);
  });
});

describe("listImports", () => {
  it("hides drafts that never got rows: status importing and row_count 0", async () => {
    const calls: [string, unknown[]][] = [];
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "select", "eq", "or", "order"]) {
      chain[m] = (...args: unknown[]) => {
        calls.push([m, args]);
        return chain;
      };
    }
    chain.limit = async () => ({ data: [], error: null });
    const { listImports } = await import("@/lib/imports/store");
    await listImports(chain as unknown as Parameters<typeof listImports>[0], "ws-1");
    expect(calls.find(([m]) => m === "or")?.[1]).toEqual(["status.neq.importing,row_count.gt.0"]);
    expect(calls.findIndex(([m]) => m === "or")).toBeLessThan(calls.findIndex(([m]) => m === "order"));
  });
});
