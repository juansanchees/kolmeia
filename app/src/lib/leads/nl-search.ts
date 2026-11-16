// Natural-language search on LEADS (Fase 2, item 8), layer 1: local rules, no network. Client-safe.
// It fills the SAME filter object the facets and saved views use (LeadFilters); words it cannot place are returned
// as `unparsed`, and only then is the AI layer asked (lead-search route). Nothing is applied until the user clicks.
import type { CompanyType, Temperature } from "@/lib/research/types";
import type { EmailQuality } from "./email-quality";
import { fold, type ContactTab, type LeadFilters } from "./view";

export type NlFilters = Partial<Pick<LeadFilters, "cities" | "companyTypes" | "temperature" | "levels" | "minLevel" | "hasPhone" | "hasEmail" | "contact" | "emailQuality">>;
export type NlParse = { filters: NlFilters; unparsed: string[] };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// word edges that also work next to "-" and digits (\b is ASCII-only, which is fine after fold())
const word = (p: string) => new RegExp(`(?<![a-z0-9])(?:${p})(?![a-z0-9])`, "g");

const TYPES: [string, CompanyType][] = [
  ["construtoras?|builders?|general contractors?|empreiteiras?", "builder"],
  ["incorporadoras?|developers?", "developer"],
  ["administradoras?(?: de (?:imoveis|condominios|predios))?|property managers?|property management", "property_manager"],
];
const TEMPS: [string, Temperature][] = [
  ["muito quentes?|very hot", "very_hot"],
  ["quentes?|hot", "hot"],
  ["mornos?|mornas?|warm", "warm"],
  ["frios?|frias?|cold", "cold"],
];
const CONTACT: [string, ContactTab][] = [
  ["nunca contatad[oa]s?|sem contato|novos|novas|new", "new"],
  ["ja contatad[oa]s?|contatad[oa]s?|contacted", "contacted"],
];
const QUALITY: [string, EmailQuality][] = [
  ["e-?mails? (?:valido|verificado)s?|valid e-?mails?", "verified"],
  ["(?:com )?dominio ok", "domain_ok"],
];
const STOP = new Set(
  ("a o as os um uma uns umas de da do das dos em na no nas nos com sem e ou que para pra por me quero queria mostre mostrar mostra " +
    "ver veja busque buscar busca procure procurar achar lista leads lead empresas empresa todos todas so apenas tipo tipos cidade cidades " +
    "ma mass massachusetts estado the in with and of or all show me find companies company").split(" "),
);

/**
 * Layer 1. `cities` are the city names of the workspace's own leads (as the list shows them); a city is only picked
 * when it is one of them, so a chip never filters to nothing. Longer names are matched first ("New Bedford" before
 * "Bedford").
 */
export function parseLeadQuery(text: string, cities: string[]): NlParse {
  let rest = ` ${fold(text.slice(0, 200))} `;
  const filters: NlFilters = {};
  const take = (re: RegExp): RegExpMatchArray[] => {
    const hits = [...rest.matchAll(re)];
    if (hits.length) rest = rest.replace(re, " ");
    return hits;
  };

  const known = [...new Set(cities.map((c) => c.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const c of known) {
    if (take(word(escape(fold(c)))).length) filters.cities = [...(filters.cities ?? []), c];
  }
  for (const [p, v] of TYPES) if (take(word(p)).length && !filters.companyTypes?.includes(v)) filters.companyTypes = [...(filters.companyTypes ?? []), v];
  for (const [p, v] of QUALITY) if (take(word(p)).length) filters.emailQuality = [v];
  if (take(word("com (?:telefone|fone|tel)|with phone|tem telefone")).length) filters.hasPhone = true;
  if (take(word("com e-?mail|with e-?mail|tem e-?mail")).length) filters.hasEmail = true;
  for (const [p, v] of TEMPS) if (!filters.temperature && take(word(p)).length) filters.temperature = v;
  for (const [p, v] of CONTACT) if (!filters.contact && take(word(p)).length) filters.contact = v;
  for (const m of take(word("(?:nivel|level) ?([0-4]) ?(\\+|ou mais|ou acima|pra cima|para cima)?"))) {
    const n = Number(m[1]) as 0 | 1 | 2 | 3 | 4;
    if (m[2]) filters.minLevel = n;
    else if (!filters.levels?.includes(n)) filters.levels = [...(filters.levels ?? []), n];
  }

  const unparsed = rest.split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
  return { filters, unparsed };
}

export function isEmptyNl(f: NlFilters): boolean {
  return Object.keys(f).length === 0;
}
