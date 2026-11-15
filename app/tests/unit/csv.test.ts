import { describe, expect, test } from "vitest";
import type { CandidateRow } from "@/lib/research/rows";
import { coverage, csvCell, inTab, SHEET_COLUMNS, toCsv } from "@/lib/research/sheet";

export function candidate(over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: "c1",
    run_id: "r1",
    name: "Harbor Test Construction, Inc.",
    name_key: "harbor test construction",
    city: "Falmouth",
    state: "MA",
    region: "Cape & Islands",
    website: "https://www.harbortestconstruction.example/",
    phone: "+1 508-555-0199",
    public_email: "ana@harbortest.example",
    email_type: "named",
    company_type: "builder",
    size_note: null,
    temperature: "very_hot",
    approach: "call",
    ask_for_name: "Greg Tester",
    ask_for_title: "Owner",
    name_confidence: "high",
    name_source_url: "https://www.harbortestconstruction.example/about",
    name_note: "Requerente do alvará, mesmo tel.",
    permit_count: 38,
    total_value_usd: 7330624,
    last_permit_date: "2026-11-03",
    biggest_job_address: "12 Example Rd, Falmouth MA",
    biggest_job_value_usd: 1824500,
    biggest_job_type: "RESI.",
    biggest_job_description: "Construct a new 2-story dwelling",
    signal_match: "Falmouth permits (match: name)",
    google_rating: 4.5,
    review_count: 15,
    hook: "Saw your Falmouth permit at 12 Example Rd (~$1.8M) - who's doing the HVAC?",
    supplier_portal_url: null,
    notes: null,
    user_decision: "keep",
    second_pass: "stands",
    is_partial: false,
    verified_at: "2026-11-10T00:00:00Z",
    entry_path: "signal",
    found_at_url: "https://permits.falmouth.example/report",
    found_at_title: "Falmouth permits",
    found_at_excerpt: "Harbor Test Construction, applicant",
    found_at_seen_at: "2026-11-10T00:00:00.000Z",
    phone_source_url: "https://www.harbortestconstruction.example/contact",
    email_source_url: "https://www.harbortestconstruction.example/contact",
    rating_source_url: null,
    ...over,
  };
}

describe("CSV export", () => {
  test("starts with a UTF-8 BOM, CRLF lines, header in column order", () => {
    const csv = toCsv([candidate()]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0].split(",").slice(0, 5)).toEqual(["Empresa", "Perguntar por", "Cargo", "Confiança do nome", "Temperatura"]);
    expect(lines).toHaveLength(3); // header, row, trailing empty
    expect(lines[0].split(",")).toHaveLength(SHEET_COLUMNS.length);
  });

  test("the 24 gold 'Ligar direto' columns come first, in order [G6]", () => {
    expect(SHEET_COLUMNS.slice(0, 24).map((c) => c.header)).toEqual([
      "Empresa", "Perguntar por", "Cargo", "Confiança do nome", "Temperatura", "Telefone", "E-mail", "Tipo de e-mail", "Site",
      "Cidade", "Região", "Nº alvarás", "Valor total (US$)", "Último alvará", "Maior obra – endereço", "Maior obra – valor (US$)",
      "Maior obra – tipo", "Maior obra – descrição", "Gancho (ligação)", "Nota Google", "Avaliações", "Fonte do match",
      "Fonte do nome", "Obs. do nome",
    ]);
  });

  test("escapes quotes, commas, newlines and leading/trailing spaces", () => {
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell(" pad")).toBe('" pad"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(42)).toBe("42");
  });

  test("cells that a spreadsheet would run as a formula are neutralised", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvCell("+1 508-555-0199")).toBe("'+1 508-555-0199");
    expect(csvCell("@cmd")).toBe("'@cmd");
  });

  test("row values: labels in Portuguese, raw numbers, unknown is empty", () => {
    const row = toCsv([candidate({ permit_count: null })]).slice(1).split("\r\n")[1];
    expect(row.startsWith('"Harbor Test Construction, Inc.",Greg Tester,Owner,alta,Muito quente,')).toBe(true);
    expect(row).toContain(",7330624,2026-11-03,");
    expect(row).toContain("Falmouth,Cape & Islands,,7330624");
  });
});

describe("tabs and coverage [G1] [G7]", () => {
  test("tabs by approach", () => {
    const call = candidate();
    const big = candidate({ id: "c2", approach: "supplier_signup" });
    const refuted = candidate({ id: "c3", second_pass: "refuted" });
    const noSignal = candidate({ id: "c4", permit_count: null, biggest_job_address: null });
    expect(inTab(call, "call")).toBe(true);
    expect(inTab(big, "call")).toBe(false);
    expect(inTab(big, "supplier")).toBe(true);
    expect(inTab(refuted, "call")).toBe(false);
    expect(inTab(noSignal, "signal")).toBe(false);
    expect([call, big, refuted, noSignal].every((c) => inTab(c, "all"))).toBe(true);
  });
  test("coverage counts", () => {
    expect(coverage([candidate(), candidate({ id: "x", phone: null, public_email: null, ask_for_name: null })])).toEqual({
      total: 2,
      name: 1,
      phone: 1,
      site: 2,
      email: 1,
    });
  });
});

describe("review of 10/11/2026: phone cells, new tabs, jobs export", () => {
  test("[finding 16] a plain international phone is not prefixed in the phone column; formulas still are", () => {
    expect(csvCell("+1 508-555-0199", true)).toBe("+1 508-555-0199");
    expect(csvCell("+1 (508) 555.0199", true)).toBe("+1 (508) 555.0199");
    expect(csvCell("+1+cmd|' /C calc'!A0", true)).toBe("'+1+cmd|' /C calc'!A0");
    expect(csvCell("=1+1", true)).toBe("'=1+1");
    expect(csvCell("+1 508-555-0199")).toBe("'+1 508-555-0199"); // any other column
    const row = toCsv([candidate()]).slice(1).split("\r\n")[1];
    expect(row).toContain(",+1 508-555-0199,");
  });

  test("[G1] [finding 11] tab order and membership; refuted only in Todos", async () => {
    const { TABS } = await import("@/lib/research/sheet");
    expect(TABS).toEqual(["call", "supplier", "new", "signal", "all", "jobs"]);
    const fresh = candidate({ entry_path: "signal" });
    const listed = candidate({ id: "c5", entry_path: "directory" });
    const refutedBig = candidate({ id: "c6", approach: "supplier_signup", second_pass: "refuted" });
    expect(inTab(fresh, "new")).toBe(true);
    expect(inTab(listed, "new")).toBe(false);
    for (const tab of ["call", "supplier", "new", "signal", "jobs"] as const) expect(inTab(refutedBig, tab)).toBe(false);
    expect(inTab(refutedBig, "all")).toBe(true);
  });

  test("[G10] jobs export: header, values, empty list gives only the header", async () => {
    const { toJobsCsv } = await import("@/lib/research/sheet");
    const csv = toJobsCsv([
      { id: "j1", run_id: "r1", address: "40 Elm St", project_name: null, job_type: "3-family", declared_value_usd: 650000, job_date: "2026-10-02", source_url: "https://permits.example/1", excerpt: "contractor: blank", seen_at: "2026-11-10T00:00:00.000Z" },
    ]);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe("Endereço,Projeto,Tipo,Valor declarado (US$),Data,Fonte,Trecho,Visto em");
    expect(lines[1]).toBe("40 Elm St,,3-family,650000,2026-10-02,https://permits.example/1,contractor: blank,2026-11-10");
    expect(toJobsCsv([]).slice(1).split("\r\n")).toEqual(["Endereço,Projeto,Tipo,Valor declarado (US$),Data,Fonte,Trecho,Visto em", ""]);
  });
});
