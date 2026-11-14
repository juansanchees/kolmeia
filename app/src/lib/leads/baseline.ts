// Baseline report (J3): how a Caçador run compares with the gold lists. Pure and client-safe; the script
// scripts/baseline.smoke.ts does the file I/O. Matching reuses the dedupe key rule (name, site domain or phone).
import type { Schedule } from "@/lib/agents/types";
import { domainKey, nameKey, phoneKey, type Dedupable } from "@/lib/research/dedupe";

/** RFC 4180: quotes, `,` separator, CRLF or LF; a leading BOM is dropped. */
export function parseCsv(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let any = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      any = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
      any = true;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      if (any || cell !== "") {
        row.push(cell);
        rows.push(row);
      }
      row = [];
      cell = "";
      any = false;
    } else {
      cell += ch;
      any = true;
    }
  }
  if (any || cell !== "") {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Companies from a CSV with the headers Empresa / Telefone / Site; rows without a company are skipped. */
export function rowsFromCsv(text: string): Dedupable[] {
  const [head, ...body] = parseCsv(text);
  if (!head) return [];
  const col = (h: string) => head.findIndex((x) => x.trim().toLowerCase() === h.toLowerCase());
  const [n, p, w] = [col("Empresa"), col("Telefone"), col("Site")];
  if (n < 0) return [];
  const out: Dedupable[] = [];
  for (const r of body) {
    const name = (r[n] ?? "").trim();
    if (!name) continue;
    out.push({ name, phone: p >= 0 ? (r[p] ?? "").trim() || null : null, website: w >= 0 ? (r[w] ?? "").trim() || null : null });
  }
  return out;
}

export type Score = { gold: number; matched: number; precision: number; coverage: number };
export type Match = { found: string; gold: string; by: "name" | "domain" | "phone" };
export type BaselineReport = { found: number; all: Score; hot: Score; matches: Match[]; weeklyGoal: number };

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const RUNS_PER_WEEK: Record<Schedule, number> = { once: 1, weekly: 1, daily: 7 };

function matchSets(found: Dedupable[], gold: Dedupable[]): { score: Score; matches: Match[] } {
  const matches: Match[] = [];
  const goldUsed = new Set<number>();
  const foundHit = new Set<number>();
  const goldKey = (g: Dedupable, by: Match["by"]) => (by === "name" ? nameKey(g.name) : by === "domain" ? domainKey(g.website) : phoneKey(g.phone));
  found.forEach((f, fi) => {
    const keys: Record<Match["by"], string | null> = { name: nameKey(f.name), domain: domainKey(f.website), phone: phoneKey(f.phone) };
    for (const by of ["name", "domain", "phone"] as const) {
      const k = keys[by];
      if (!k) continue;
      const gi = gold.findIndex((g, i) => !goldUsed.has(i) && goldKey(g, by) === k);
      if (gi >= 0) {
        goldUsed.add(gi);
        foundHit.add(fi);
        matches.push({ found: f.name, gold: gold[gi].name, by });
        return;
      }
    }
  });
  return {
    score: {
      gold: gold.length,
      matched: goldUsed.size,
      precision: found.length ? round3(foundHit.size / found.length) : 0,
      coverage: gold.length ? round3(goldUsed.size / gold.length) : 0,
    },
    matches,
  };
}

export function baselineReport(input: { found: Dedupable[]; all: Dedupable[]; hot: Dedupable[]; schedule: Schedule }): BaselineReport {
  const a = matchSets(input.found, input.all);
  const h = matchSets(input.found, input.hot);
  const seen = new Set(a.matches.map((m) => m.found));
  const matches = [...a.matches, ...h.matches.filter((m) => !seen.has(m.found))];
  return { found: input.found.length, all: a.score, hot: h.score, matches, weeklyGoal: input.found.length * RUNS_PER_WEEK[input.schedule] };
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");

export function reportMarkdown(r: BaselineReport, meta: { agentName: string; runDate: string; alreadyKnown: number }): string {
  const row = (label: string, s: Score) => `| ${label} | ${s.gold} | ${s.matched} | ${pct(s.precision)} | ${pct(s.coverage)} |`;
  return [
    `# Relatório de baseline do Caçador`,
    ``,
    `Agente: ${meta.agentName} · Execução de ${meta.runDate} · Empresas achadas: ${r.found}`,
    ``,
    `| Lista de referência | Na lista | Em comum | Precisão | Cobertura |`,
    `|---|---|---|---|---|`,
    row("Todos", r.all),
    row("Quentes", r.hot),
    ``,
    `Precisão = achadas que estão na lista / achadas. Cobertura = empresas da lista que foram achadas / empresas da lista.`,
    ``,
    `## Empresas em comum`,
    ``,
    ...(r.matches.length
      ? [`| Achada | Na lista | Por |`, `|---|---|---|`, ...r.matches.map((m) => `| ${cell(m.found)} | ${cell(m.gold)} | ${m.by} |`)]
      : [`Nenhuma.`]),
    ``,
    `Obs.: ${meta.alreadyKnown} empresa(s) que já estavam em LEADS foram puladas nesta execução, o que reduz a cobertura.`,
    ``,
    `Proposta de meta semanal: ${r.weeklyGoal} leads novos com prova (o Juan decide).`,
    ``,
  ].join("\n");
}
