// Turns a person's instruction for a campaign ("essas casas são pequenas demais...") into CampaignParams. Deterministic
// phrase map, pt + en. Anything not mapped comes back in `unknown`, so the agent asks a simple question instead of guessing.
// Behind `Interpreter` so an AI interpreter can replace it later (paid AI needs Juan's ok; not built).
import type { BuildingKind, CampaignParams } from "@/lib/offers/types";

export type Interpretation = { params: Partial<CampaignParams>; understoodCodes: string[]; unknown: string[] };
export interface Interpreter {
  interpret(text: string, lang: "pt" | "en"): Interpretation;
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Every pattern runs on the normalized clause (no accents, lower case). Both languages always run: people mix them.
const NEG = /\b(evit\w*|sem|nao|menos|ignor\w*|tir\w*|exclu\w*|avoid|not|skip|ignore|less|fewer|exclude|without|dont|don't)\b/;
// Bare "no" is negation only in English ("no condos"); in Portuguese it means "in the" ("no centro").
const NEG_EN = /\bno\b/;
const POS = /\b(prioriz\w*|prefir\w*|prefer\w*|foc\w*|quero|mais|busque|procure|prioritize|focus|want|more|look for|only|so|apenas)\b/;
const SMALL_HOUSES = /\b(casas?|casinhas?|residencias?|houses?|homes?)\b.*\b(pequen\w*|small|tiny)\b|\b(pequen\w*|small|tiny)\b.*\b(casas?|residencias?|houses?|homes?)\b|\bcasinhas?\b|\btoo small\b|\bpequen\w* demais\b/;
const LARGE_HOUSES = /\b(casas?|residencias?|houses?|homes?)\b.*\b(grandes?|alto padrao|large|big|luxury)\b|\b(grandes?|large|big|luxury)\b.*\b(casas?|residencias?|houses?|homes?)\b|\bmansoes\b|\bmansions?\b/;
const KINDS: [BuildingKind, RegExp][] = [
  // "20 unidades" / "20+ units": a count of units means a multifamily building.
  ["multifamily", /\b(multi-?familiar\w*|multifamily|multi-family|apartamentos?|predios?|condominios?|apartments?|condos?|condominiums?|\d+\s*\+?\s*(?:unidades|units))\b/],
  ["commercial", /\b(comercia(l|is)|lojas?|escritorios?|commercial|retail|offices?)\b/],
  ["single_family", /\b(unifamiliar\w*|casas?|residencias?|single[- ]family|houses?|homes?)\b/],
];
const BID_PATH = /\b(por onde|como|onde)\b.*\b(apresentar|mandar|enviar|submeter)\b.*\b(orcamentos?|propostas?)\b|\b(portal|cadastro) de fornecedor\w*|\blicitac\w*|\bconcorrencias?\b|\b(how|where)\b.*\b(submit|send)\b.*\b(bids?|quotes?|proposals?)\b|\bbid (path|page|portal|list)\b|\bvendor (portal|registration)\b|\bbidding\b/;
// Money needs a marker: $ / US$, a dollar word, or a magnitude (mil, k, milhão, million, M). "mais de 20 unidades" is not money.
const MIN_VALUE = /\b(?:acima de|minimo(?: de)?|pelo menos|mais de|a partir de|over|above|at least|minimum(?: of)?|more than)\s*((?:us)?\$)?\s*(\d[\d.,]*)\s*(mil|k|thousand|milh(?:ao|oes)|million|mi|m)?\b\s*(dolares|dollars|usd)?/;
const NOT_MONEY_AFTER = /^\s*(unidades?|units?|apartamentos?|apartments?|casas?|houses?|homes?|dias?|days?|semanas?|weeks?|mes(es)?|months?|anos?|years?)\b/;
const RECENT_N = /\b(ultim[oa]s?|last|past)\s+(\d{1,3})\s*(dias?|semanas?|mes(es)?|days?|weeks?|months?)\b/;
// "new" / "novas" is about the building (the offer), never about how recent the permit is.
const RECENT = /\b(recentes?|recent)\b/;
const NEW_BUILD = /\b(obras? novas?|novas? obras?|construc\w* novas?|new (construction|builds?|buildings?))\b/;
const FILLER = /^(nesta busca|nessa busca|por favor|please|in this search|for this search|ok|obrigad[oa]|thanks?)$/;

/** "500.000" / "500,000" / "1,5" + mil|k|milhão|million → dollars. */
function money(num: string, unit: string | undefined): number | null {
  const n = /^\d{1,3}([.,]\d{3})+$/.test(num) ? Number(num.replace(/[.,]/g, "")) : Number(num.replace(",", "."));
  if (!Number.isFinite(n)) return null;
  const mult = !unit ? 1 : /^(mil|k|thousand)$/.test(unit) ? 1_000 : 1_000_000;
  return Math.round(n * mult);
}
function days(n: number, unit: string): number {
  return /^(semana|week)/.test(unit) ? n * 7 : /^(mes|month)/.test(unit) ? n * 30 : n;
}

export function interpretInstruction(text: string, lang: "pt" | "en"): Interpretation {
  const prefer = new Set<BuildingKind>();
  const deprio = new Set<BuildingKind>();
  const codes: string[] = [];
  const unknown: string[] = [];
  const params: Partial<CampaignParams> = {};
  const up = (k: BuildingKind) => { prefer.add(k); deprio.delete(k); };
  const down = (k: BuildingKind) => { deprio.add(k); prefer.delete(k); };
  const code = (c: string) => { if (!codes.includes(c)) codes.push(c); };
  let lastNeg: boolean | null = null;

  const clauses = text.split(/[;!?\n]+|\.(?!\d)|,\s+|\s+(?:e|and|mas|but|then|depois)\s+/i).map((c) => c.trim()).filter(Boolean);
  for (const raw of clauses) {
    const c = norm(raw);
    let hit = false;
    const neg = NEG.test(c) || (lang === "en" && NEG_EN.test(c)) ? true : POS.test(c) ? false : null;
    // A clause like "e comerciais" with no verb takes the polarity of the clause before it.
    const isNeg: boolean = neg ?? lastNeg ?? false;

    if (SMALL_HOUSES.test(c)) { down("single_family"); down("adu"); code("deprioritize_small_houses"); hit = true; }
    else if (LARGE_HOUSES.test(c)) { up("single_family"); code("prefer_large_houses"); hit = true; }
    else {
      for (const [k, re] of KINDS) {
        if (!re.test(c)) continue;
        if (isNeg) { down(k); code(`deprioritize_${k}`); } else { up(k); code(`prefer_${k}`); }
        hit = true;
      }
    }
    if (BID_PATH.test(c)) { params.wantBidPath = true; code("want_bid_path"); hit = true; }
    const mv = MIN_VALUE.exec(c);
    if (mv) {
      const v = money(mv[2], mv[3]);
      const marked = !!(mv[1] || mv[3] || mv[4]);
      if (marked && v != null && v > 0 && !NOT_MONEY_AFTER.test(c.slice(mv.index + mv[0].length))) { params.minValueUsd = v; code("min_value"); hit = true; }
    }
    const rn = RECENT_N.exec(c);
    if (rn) { params.maxAgeDays = days(Number(rn[2]), rn[3]); code("only_recent"); hit = true; }
    else if (RECENT.test(c)) { params.maxAgeDays = 90; code("only_recent"); hit = true; } // (?) 90 days until Juan says otherwise
    if (NEW_BUILD.test(c)) { code("new_construction_scope"); hit = true; } // already what the offer looks for: no param

    if (hit) lastNeg = isNeg;
    else if (!FILLER.test(c)) unknown.push(raw.slice(0, 200));
  }
  if (prefer.size) params.preferKinds = [...prefer];
  if (deprio.size) params.deprioritizeKinds = [...deprio];
  return { params, understoodCodes: codes, unknown };
}

export const phraseInterpreter: Interpreter = { interpret: interpretInstruction };
