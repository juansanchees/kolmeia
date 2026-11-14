import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { detectMapping, hasIdColumn, type Mapping } from "@/lib/imports/fields";
import { mapRow, previewOutcomes, type ImportRow, type RowError } from "@/lib/imports/rows";
import { parseDelimited, sheetRows } from "@/lib/imports/parse";

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
    expect(b.website).toBeNull();
    expect(b.name).toBe("joe@gmail.com");
  });

  it("errors per row", () => {
    expect(asErr(mapRow(["x"], m("city"), 2)).error).toBe("empty");
    expect(asErr(mapRow(["Acme", "555-0199"], m("name", "phone"), 2)).error).toBe("phone");
    expect(asErr(mapRow(["Acme", "a@b"], m("name", "email"), 2)).error).toBe("email");
    expect(asErr(mapRow(["Acme", "javascript:alert(1)"], m("name", "website"), 2)).error).toBe("website");
    expect(asErr(mapRow(["Acme", "https://linkedin.com/company/x"], m("name", "website"), 2)).error).toBe("website");
    expect(asErr(mapRow(["A".repeat(201)], m("name"), 2)).error).toBe("too_long");
    expect(asErr(mapRow(["Acme", "x".repeat(301)], m("name", "city"), 2)).error).toBe("too_long");
    expect(asRow(mapRow(["Acme", "acme.example"], m("name", "website"), 2)).website).toBe("https://acme.example/");
  });

  it("refuses a phone in scientific notation, even one with enough digits", () => {
    expect(asErr(mapRow(["Acme", "5.09E+09"], m("name", "phone"), 2)).error).toBe("phone");
    expect(asErr(mapRow(["Acme", "5.085550103E+09"], m("name", "phone"), 2)).error).toBe("phone");
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
