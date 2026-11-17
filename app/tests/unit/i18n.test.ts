import { describe, expect, it } from "vitest";
import { pt } from "@/messages/pt";
import { en } from "@/messages/en";
import { fill, htmlLang, messagesFor, parseLocale } from "@/lib/i18n";

/** Every leaf path with its value: "leads.facets.levelName.0" -> "0 · sem dados". */
function leaves(obj: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (obj !== null && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) for (const [p, x] of leaves(v, prefix ? `${prefix}.${k}` : k)) out.set(p, x);
  } else out.set(prefix, obj);
  return out;
}
const tokens = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("pt/en message parity", () => {
  const p = leaves(pt);
  const e = leaves(en);

  it("has the same keys in both languages", () => {
    expect([...e.keys()].sort()).toEqual([...p.keys()].sort());
  });

  it("keeps the same {placeholders} in every string", () => {
    const bad = [...p].filter(([k, v]) => typeof v === "string" && JSON.stringify(tokens(v)) !== JSON.stringify(tokens(String(e.get(k)))));
    expect(bad.map(([k]) => k)).toEqual([]);
  });

  it("only uses strings as leaves and leaves no English string empty where Portuguese has text", () => {
    for (const [k, v] of e) {
      expect(typeof v, k).toBe("string");
      if (p.get(k) !== "") expect(v, k).not.toBe("");
    }
  });

  it("never mentions LinkedIn in the copy", () => {
    for (const [k, v] of e) expect(String(v), k).not.toMatch(/linkedin/i);
  });
});

describe("locale", () => {
  it("parses the cookie: only 'en' switches, missing or invalid is Portuguese", () => {
    expect(parseLocale("en")).toBe("en");
    expect(parseLocale("pt")).toBe("pt");
    expect(parseLocale(undefined)).toBe("pt");
    expect(parseLocale(null)).toBe("pt");
    expect(parseLocale("")).toBe("pt");
    expect(parseLocale("EN")).toBe("pt");
    expect(parseLocale("fr")).toBe("pt");
  });

  it("maps a locale to its messages and html lang", () => {
    expect(messagesFor("pt")).toBe(pt);
    expect(messagesFor("en")).toBe(en);
    expect(messagesFor("en").intl).toBe("en-US");
    expect(messagesFor("pt").intl).toBe("pt-BR");
    expect(htmlLang("pt")).toBe("pt-BR");
    expect(htmlLang("en")).toBe("en");
  });

  it("fills placeholders the same way in both languages", () => {
    expect(fill(en.paging.page, { page: 2, pages: 5 })).toBe("Page 2 of 5");
    expect(fill(pt.paging.page, { page: 2, pages: 5 })).toBe("Página 2 de 5");
  });
});

describe("origin filter keys", () => {
  it("stay Portuguese as keys but read in the UI language", async () => {
    const { originKeyLabel } = await import("@/lib/leads/view");
    expect(originKeyLabel("Sem origem", en)).toBe("No source");
    expect(originKeyLabel("Pesquisa avulsa", en)).toBe("One-off research");
    expect(originKeyLabel("Importado", en)).toBe("Imported");
    expect(originKeyLabel("Importado · Planilha Y", en)).toBe("Imported · Planilha Y");
    expect(originKeyLabel("Lista 1", en)).toBe("Lista 1");
    expect(originKeyLabel("Sem origem", pt)).toBe("Sem origem");
  });
});
