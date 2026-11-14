import { describe, expect, test } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import nextConfig from "../../next.config";

const root = path.resolve(import.meta.dirname, "../..");
// Grows task by task until it equals the plan's redirect table.
const EXPECTED = [
  { source: "/pesquisa", destination: "/agentes" },
  { source: "/pesquisa/:id", destination: "/agentes/pesquisa/:id" },
  { source: "/empresa", destination: "/configuracoes/empresa" },
  { source: "/email/caixa", destination: "/configuracoes/caixas" },
  { source: "/email/bloqueados", destination: "/configuracoes/bloqueados" },
  { source: "/email/closer", destination: "/leads/closer" },
  { source: "/email", destination: "/campanhas" },
  { source: "/email/campanhas/:id", destination: "/campanhas/:id" },
  { source: "/email/campanhas/:id/revisar", destination: "/campanhas/:id/revisar" },
  { source: "/email/respostas", destination: "/campanhas/respostas" },
];
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : [path.join(d, f)]));
/** "/agentes/pesquisa/:id?x=1" -> src/app/(app)/agentes/pesquisa/[id]/page.tsx */
const pageFileFor = (url: string) => path.join(root, "src/app/(app)", url.split("?")[0].replace(/:(\w+)/g, "[$1]"), "page.tsx");
/** Quoted forms of a moved route that must not appear in src: exact static path (optionally with ?query), or any path under a dynamic one. */
function forbiddenLiterals(source: string): string[] {
  const q = ['"', "'", "`"];
  if (source.includes(":")) return q.map((c) => c + source.slice(0, source.indexOf(":")));
  return q.flatMap((c) => [c + source + c, c + source + "?"]);
}
const redirects = async () => (await nextConfig.redirects!()) as { source: string; destination: string; permanent: boolean }[];
const sortBySource = <T extends { source: string }>(rows: T[]) => [...rows].sort((a, b) => a.source.localeCompare(b.source));

describe("F1 routes", () => {
  test("every old page route redirects permanently to its new home", async () => {
    expect(sortBySource(await redirects())).toEqual(sortBySource(EXPECTED.map((r) => ({ ...r, permanent: true }))));
  });
  test("every redirect destination is a page", () => {
    for (const r of EXPECTED) expect(existsSync(pageFileFor(r.destination)), r.destination).toBe(true);
  });
  test("no page is left at a redirect source", () => {
    for (const r of EXPECTED) expect(existsSync(pageFileFor(r.source)), r.source).toBe(false);
  });
  test("no link, redirect or revalidation in src points at a moved route", () => {
    const files = walk(path.join(root, "src")).filter((f) => /\.tsx?$/.test(f));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const r of EXPECTED) for (const lit of forbiddenLiterals(r.source)) expect(text, `${file} ${lit}`).not.toContain(lit);
    }
  });
  test("C10 /email/bloqueados redirects permanently to Configurações", async () => {
    expect(await redirects()).toContainEqual({ source: "/email/bloqueados", destination: "/configuracoes/bloqueados", permanent: true });
  });
  test("C10 /email/closer redirects permanently to LEADS, com a closer", async () => {
    expect(await redirects()).toContainEqual({ source: "/email/closer", destination: "/leads/closer", permanent: true });
  });
  test("onboarding sends a new workspace to the company profile at its new home", () => {
    expect(readFileSync(path.join(root, "src/app/onboarding/actions.ts"), "utf8")).toContain('redirect("/configuracoes/empresa")');
  });
  test("/configuracoes opens Sua empresa", () => {
    const file = path.join(root, "src/app/(app)/configuracoes/page.tsx");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain('redirect("/configuracoes/empresa")');
  });
});
