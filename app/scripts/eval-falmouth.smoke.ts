// Falmouth evaluation: the current flow (Maps + public projects ranked by priorityOf, no AI, no permit linkage) against the
// new flow (the pilot round queue), both scored on the same gold rows. Run: npm run pilot:eval
// Env: EVAL_RUN=1, PILOT_OUT_DIR (round files pilot-round-<n>.json, optional ai-baseline.json), PILOT_DATA_DIR (gold/falmouth_gold.csv).
// Writes PILOT_OUT_DIR/eval-falmouth.md (outside the repo). Prints counts only. Needs no database and no key.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { goldFromCsv } from "@/lib/evals/gold";
import { anonymize, compareRounds, dedupeCompanies, missingWhy, scoreQueue, type QueueItem, type QueueScore } from "@/lib/evals/score";
import { mapsItems, massbuildsProjectItems } from "@/lib/kb/load";
import type { KbItem } from "@/lib/kb/types";
import { priorityOf } from "@/lib/leads/classify";
import { domainKey, nameKey, phoneKey } from "@/lib/research/dedupe";
import { filterCsv, pilotDataDir, pilotOutDir } from "./pilot-env";

const TOWN = "Falmouth";
type RoundFile = { round: number; unlinked?: { signal_ref: string; link_status: string }[]; queue: { company: { name: string; phone?: string; website?: string }; signal: { ref: string; source_url?: string }; priority: number; codes: string[]; contact_path: string; fit: string }[] };
// `queue` = one item per company (the best one); `rawSize`/`duplicates` describe the queue as the flow produces it
type Flow = { label: string; queue: QueueItem[]; score: QueueScore; rawSize: number; duplicates: QueueScore["duplicates"]; multiWork: number; mapsOnly?: number };

// what the round file can show about a current-flow company missing from the new queue
const REJ_WHY = {
  no_work_signal: "não há alvará nem projeto ligado a ela (só o cadastro do Maps), e o fluxo novo só entra com uma obra",
  work_unlinked: "a obra dela ficou sem construtora confirmada (fora da fila, no arquivo da rodada)",
  work_not_in_queue: "a obra dela não está na fila nova (não passou na regra da oferta ou não foi ligada à empresa)",
} as const;
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 1000) / 10}%` : "n/a");
const tiers = (t: Record<string, number>) => Object.entries(t).map(([k, v]) => `${k}: ${v}`).join(", ") || "-";

/** Current flow: the Maps and project rows of the town, best first by the existing priorityOf (phone, temperature, e-mail...). */
function currentFlow(data: string): { queue: QueueItem[]; mapsOnly: number } {
  const read = (rel: string) => (existsSync(path.join(data, rel)) ? readFileSync(path.join(data, rel), "utf8") : "");
  const maps = mapsItems(filterCsv(read("ma_sweep/maps/universe.csv"), (r) => (r.city ?? "").toLowerCase() === TOWN.toLowerCase()), new Date().toISOString());
  const projects = massbuildsProjectItems(read("ma_sweep/projects/projects_massbuilds.csv"), TOWN);
  const rows = [...maps.items, ...projects.items].filter((it): it is KbItem & { company: NonNullable<KbItem["company"]> } => !!it.company).map((it) => ({
    company: it.company.name, phone: it.company.phone ?? null, website: it.company.website ?? null,
    signalRef: it.signals?.[0] ? `${it.signals[0].source}:${it.signals[0].source_ref}` : null,
    // proof = an evidence URL tied to a work signal (permit/project); a Maps place page is not proof of an opportunity
    sourceUrl: it.signals?.[0]?.source_url ?? null,
    contactPath: it.company.phone ? "phone" : "none",
  }));
  const rank = (q: QueueItem) => priorityOf({ lead: { status: "new", level: 0, first_contacted_at: null }, best: null, display: { phone: q.phone ?? null, email: null } });
  const mapsOnly = [...maps.items].filter((it) => it.values?.some((v) => v.source_url)).length;
  return { queue: rows.map((q, i) => ({ q, i })).sort((a, b) => rank(b.q) - rank(a.q) || a.i - b.i).map((x) => x.q), mapsOnly };
}

const roundQueue = (f: RoundFile): QueueItem[] =>
  [...f.queue].filter((q) => q.fit !== "no").sort((a, b) => b.priority - a.priority).map((q) => ({ company: q.company.name, phone: q.company.phone, website: q.company.website, signalRef: q.signal.ref, sourceUrl: q.signal.source_url, contactPath: q.contact_path }));

function section(f: Flow): string[] {
  const s = f.score;
  const d = s.denominators;
  return [
    `### ${f.label}`,
    `- Na fila: ${f.rawSize} itens, ${d.queue} empresas únicas (as métricas abaixo contam cada empresa uma vez, pelo melhor item). Referência: ${d.gold} (${tiers(d.goldByTier)}), com alvará em Falmouth: ${d.goldWithPermit}.`,
    `- Recuperadas: ${s.recovered.count} de ${d.gold} (${pct(s.recovered.count, d.gold)}); por nível: ${tiers(s.recovered.byTier)}; com alvará: ${s.recovered.withPermit}.`,
    `- Perdidas: ${s.missed.count}; por nível: ${tiers(s.missed.byTier)}; com alvará: ${s.missed.withPermit}.`,
    `- Precisão nas 25 primeiras: ${Math.round(s.precisionAt[25] * 1000) / 10}%; nas 50 primeiras: ${Math.round(s.precisionAt[50] * 1000) / 10}%.`,
    `- Fora da referência: ${s.notInGold} (sem prova, tratados como falsos positivos: ${s.falsePositives}; com prova, para revisão manual: ${s.newNotInGold.length}).`,
    `- Duplicatas na fila bruta: mesma empresa repetida ${f.duplicates.company}, mesmo alvará/projeto repetido ${f.duplicates.signal}.`,
    `- Empresas com várias obras: ${f.multiWork} (não contam como duplicatas).`,
    `- Com prova (URL de evidência de um alvará/projeto): ${s.withProof} de ${d.queue} (${pct(s.withProof, d.queue)})${f.mapsOnly !== undefined ? `; linhas só com link do Maps (não contam como prova): ${f.mapsOnly}` : ""}. Com caminho de contato: ${s.withContactPath} (${pct(s.withContactPath, d.queue)}).`,
    "",
  ];
}

test.skipIf(process.env.EVAL_RUN !== "1")("falmouth evaluation", () => {
  const data = pilotDataDir();
  const out = pilotOutDir();
  const goldFile = path.join(data, "gold", "falmouth_gold.csv");
  if (!existsSync(goldFile)) throw new Error("gold/falmouth_gold.csv not found in PILOT_DATA_DIR");
  // the file is already Falmouth-scoped (`city` may be the company's HQ): every row counts
  const gold = goldFromCsv(readFileSync(goldFile, "utf8"));
  const rounds = readdirSync(out).map((f) => /^pilot-round-(\d+)\.json$/.exec(f)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1])).sort((a, b) => a - b);
  if (!rounds.length) throw new Error("no pilot-round-<n>.json in PILOT_OUT_DIR (run pilot:round first)");
  const file = (n: number) => JSON.parse(readFileSync(path.join(out, `pilot-round-${n}.json`), "utf8")) as RoundFile;
  const first = file(rounds[0]);
  const last = file(rounds[rounds.length - 1]);

  const cur = currentFlow(data);
  const mk = (label: string, raw: QueueItem[], mapsOnly?: number): Flow => {
    const queue = dedupeCompanies(raw);
    return { label, queue, score: scoreQueue(queue, gold), rawSize: raw.length, duplicates: scoreQueue(raw, gold).duplicates, multiWork: scoreQueue(raw, gold).multiWork, mapsOnly };
  };
  const flows: Flow[] = [mk("Fluxo atual (Maps + projetos, priorityOf, sem IA)", cur.queue, cur.mapsOnly), mk(`Fluxo novo (fila da rodada ${last.round})`, roundQueue(last))];
  const ai = path.join(out, "ai-baseline.json");
  let aiCost: number | null = null;
  if (existsSync(ai)) {
    const j = JSON.parse(readFileSync(ai, "utf8")) as QueueItem[] | { items: QueueItem[]; cost_usd?: number };
    const items = Array.isArray(j) ? j : j.items;
    aiCost = Array.isArray(j) ? null : (j.cost_usd ?? null);
    flows.push(mk("Baseline com IA (arquivo ai-baseline.json)", items));
  }

  const nw = flows[1];
  const hitIdx = nw.score.inGoldIdx[0];
  const gapG = gold[nw.score.missed.goldIdx[0]];
  const newKeys = new Set(nw.queue.flatMap((q) => [nameKey(q.company), domainKey(q.website), phoneKey(q.phone)]).filter(Boolean));
  const rej = cur.queue.find((q) => ![nameKey(q.company), domainKey(q.website), phoneKey(q.phone)].filter(Boolean).some((k) => newKeys.has(k)));
  const delta = rounds.length > 1 ? compareRounds(first.queue.map((q) => ({ key: q.signal.ref, priority: q.priority })), last.queue.map((q) => ({ key: q.signal.ref, priority: q.priority }))) : null;

  const md = [
    `# Avaliação do piloto de Falmouth`,
    ``,
    `> Atenção: a lista de referência foi montada a partir das mesmas fontes públicas de Falmouth (alvarás e varredura do Maps) que o piloto lê. Por isso a recuperação aqui pode parecer melhor do que seria numa cidade sem lista de referência: ela mede "o fluxo acha o que já tínhamos achado", não descoberta nova.`,
    ``,
    `Mesmo recorte para os fluxos: ${TOWN}, oferta de HVAC em obra nova, mesma lista de referência. Referência lida só aqui; nunca entra na rodada.`,
    ``,
    ...flows.flatMap(section),
    `## Obras sem construtora identificada`,
    `- Obras relevantes sem construtora identificada: ${last.unlinked?.length ?? 0} (pendentes: ${(last.unlinked ?? []).filter((u) => u.link_status === "pending").length}). Pergunta da ligação: quem é o GC? Ficam fora da fila (um lead precisa de empresa) e no arquivo da rodada.`,
    ``,
    `## Rodada ${rounds[0]} contra rodada ${rounds[rounds.length - 1]}`,
    delta ? `- Subiram: ${delta.up}. Desceram: ${delta.down}. Iguais: ${delta.same}. Novas: ${delta.new}. Saíram da fila (rebaixadas): ${delta.dropped}.` : `- Só existe uma rodada (${rounds[0]}): sem comparação ainda.`,
    ``,
    `## Exemplos anonimizados`,
    hitIdx !== undefined ? `- Acerto: ${anonymize(nw.queue[hitIdx].company, TOWN)}, posição ${hitIdx + 1} na fila nova.` : `- Acerto: nenhum.`,
    gapG ? `- Lacuna: ${anonymize(gapG.company, TOWN)}, nível ${gapG.tier || "?"}, está na referência e não na fila nova.` : `- Lacuna: nenhuma.`,
    rej ? `- Fora da fila nova: ${anonymize(rej.company, TOWN)} está no fluxo atual; ${REJ_WHY[missingWhy(rej, new Set((last.unlinked ?? []).map((u) => u.signal_ref)))]}.` : `- Fora da fila nova: nenhuma.`,
    ``,
    `## Custo`,
    `- Caminho determinístico (regra, cruzamento, gancho): US$ 0 (observado).`,
    aiCost !== null ? `- Baseline com IA: US$ ${aiCost} (observado, do arquivo).` : `- Baseline com IA: sem custo informado.`,
    `- Projeções: nenhuma (estimado = não calculado).`,
    ``,
    `Notas: "falso positivo" = fora da referência e sem fonte; fora da referência com fonte vai para revisão manual (pode ser achado novo). Duplicata de empresa no fluxo novo pode ser legítima (várias obras da mesma empresa).`,
    ``,
  ].join("\n");
  writeFileSync(path.join(out, "eval-falmouth.md"), md);
  console.log(JSON.stringify({ gold: gold.length, flows: flows.map((f) => ({ queue: f.score.denominators.queue, recovered: f.score.recovered.count, notInGold: f.score.notInGold, dup: f.score.duplicates })), rounds }));
  expect(flows[0].score.denominators.gold).toBe(gold.length);
});
