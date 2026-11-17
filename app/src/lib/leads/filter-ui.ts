// Client-safe presentation rules of the LEADS list: shortcut chips, panel categories and the plain-language summary.
// Every piece reads and writes the SAME LeadFilters object the panel, saved views and AI search use.
import { usd } from "@/components/research/format";
import { fill, type Messages } from "@/lib/i18n";
import { activeFilterKeys, clearPatch, originKeyLabel, type LeadFilters } from "./view";

export type ShortcutId = "hasPhone" | "hasEmail" | "hasContactName" | "never" | "week";
type ShortcutChip = { id: ShortcutId; key: keyof LeadFilters; on: (f: LeadFilters) => boolean; patch: (on: boolean) => Partial<LeadFilters> };

/** "Atalhos": each chip is one existing filter value; its state is read from the filters, so the panel and the chip agree. */
export const SHORTCUT_CHIPS: readonly ShortcutChip[] = [
  { id: "hasPhone", key: "hasPhone", on: (f) => f.hasPhone, patch: (on) => ({ hasPhone: on }) },
  { id: "hasEmail", key: "hasEmail", on: (f) => f.hasEmail, patch: (on) => ({ hasEmail: on }) },
  { id: "hasContactName", key: "hasContactName", on: (f) => f.hasContactName, patch: (on) => ({ hasContactName: on }) },
  { id: "never", key: "lastTouch", on: (f) => f.lastTouch === "never", patch: (on) => ({ lastTouch: on ? "never" : "all" }) },
  { id: "week", key: "entered", on: (f) => f.entered === "7", patch: (on) => ({ entered: on ? "7" : "all" }) },
];

/** The "Mais filtros" categories, in panel order, and the filter keys each one sets. */
export const PANEL_CATEGORIES = {
  city: ["cities"],
  origin: ["lists"],
  entered: ["entered"],
  lastTouch: ["lastTouch"],
  name: ["nameQ"],
  role: ["role", "hasContactName"],
  contact: ["hasEmail", "siteNoEmail", "hasPhone"],
  emailQuality: ["emailQuality"],
  level: ["levels"],
  temperature: ["temperature"],
  agent: ["agent"],
} as const satisfies Record<string, readonly (keyof LeadFilters)[]>;
export type PanelCategory = keyof typeof PANEL_CATEGORIES;

/** How many options are picked in a category (the badge on its row). */
export function pickedIn(cat: PanelCategory, f: LeadFilters): number {
  const active = new Set(activeFilterKeys(f));
  return PANEL_CATEGORIES[cat].reduce((n, k) => {
    if (!active.has(k)) return n;
    const v = f[k];
    return n + (Array.isArray(v) ? v.length : 1);
  }, 0);
}

const PANEL_KEYS = new Set<keyof LeadFilters>(Object.values(PANEL_CATEGORIES).flat());

/** Active filters the panel controls ("Limpar todos os filtros" inside it). */
export const panelFilterKeys = (f: LeadFilters) => activeFilterKeys(f).filter((k) => PANEL_KEYS.has(k));

/** Every active filter gets a removable chip, except one whose shortcut chip is already on (that chip turns it off). */
export const removableChipKeys = (f: LeadFilters) => activeFilterKeys(f).filter((k) => !SHORTCUT_CHIPS.some((c) => c.key === k && c.on(f)));

/** "Limpar tudo": every filter, the search, size and stage; the AI column the person picked stays. */
export const clearAllPatch = (f: LeadFilters): Partial<LeadFilters> => clearPatch([...activeFilterKeys(f), "q", "segment", "stage", "nameNot"]);

/** The value part of an active-filter chip ("" = the label says it all). */
export function chipValue(k: keyof LeadFilters, f: LeadFilters, agents: [string, string][], t: Messages): string {
  const L = t.leads;
  const TB = t.leads.toolbar;
  switch (k) {
    case "contact": return L.contactTabs[f.contact];
    case "cities": return f.cities.join(", ");
    case "lists": return f.lists.map((l) => originKeyLabel(l, t)).join(", ");
    case "entered": return L.facets.enteredOpts[f.entered];
    case "nameQ": return `${f.nameNot ? L.facets.nameNotContains : L.facets.nameContains} "${f.nameQ}"`;
    case "role": return L.facets.roleOpts[f.role];
    case "lastTouch": return L.facets.lastTouchOpts[f.lastTouch];
    case "levels": return f.levels.map((l) => L.facets.levelName[l as 0 | 1 | 2 | 3 | 4]).join(", ");
    case "origins": return f.origins.map((o) => L.facets.origins[o]).join(", ");
    case "emailQuality": return f.emailQuality.map((q) => L.emailQuality.labels[q]).join(", ");
    case "temperature": return f.temperature === "none" ? TB.noResearch : f.temperature === "all" ? "" : t.research.labels.temperature[f.temperature];
    case "agent": return f.agent === "one_off" ? L.oneOff : (agents.find(([id]) => id === f.agent)?.[1] ?? f.agent);
    case "status": return f.status === "all" ? "" : L.statuses[f.status];
    case "tab": return t.research.list.tabs[f.tab];
    case "minLevel": return String(f.minLevel);
    case "companyTypes": return f.companyTypes.map((c) => L.nlSearch.types[c]).join(", ");
    case "minPermitUsd": return usd(f.minPermitUsd, t.intl);
    case "aiAnswer": return (L.aiQuestion.answers as Record<string, string>)[f.aiAnswer] ?? f.aiAnswer;
    default: return "";
  }
}

/** One phrase per active filter. */
function phraseOf(k: keyof LeadFilters, f: LeadFilters, agents: [string, string][], t: Messages): string {
  const S = t.leads.summary;
  const v = chipValue(k, f, agents, t);
  switch (k) {
    case "hasPhone": case "hasEmail": case "hasContactName": case "siteNoEmail": return S[k];
    case "cities": return fill(S.cities, { v });
    case "lists": return fill(S.lists, { v });
    case "entered": return S.entered[f.entered as Exclude<LeadFilters["entered"], "all">];
    case "lastTouch": return S.lastTouch[f.lastTouch as Exclude<LeadFilters["lastTouch"], "all">];
    case "nameQ": return fill(f.nameNot ? S.nameNot : S.nameYes, { v: f.nameQ.trim() });
    case "temperature": return f.temperature === "none" ? S.noResearch : fill(S.generic, { label: t.leads.filters.temperature, v });
    default: return fill(S.generic, { label: t.leads.chips[k as keyof Messages["leads"]["chips"]], v });
  }
}

/** "93 empresas" / "1 empresa". */
export const countOf = (n: number, t: Messages) => (n === 1 ? t.leads.summary.one : fill(t.leads.summary.many, { n: n.toLocaleString(t.intl) }));

/** "93 empresas de tamanho Grande · na etapa Novo · com telefone · em Cambridge": every active filter, in words. */
export function summaryOf(f: LeadFilters, n: number, agents: [string, string][], t: Messages): string {
  const S = t.leads.summary;
  const count = countOf(n, t);
  const size = f.segment === "all" ? S.sizeAll : f.segment === "none" ? S.sizeNone : fill(S.size, { v: t.leads.segments[f.segment] });
  const parts = [`${count} ${size}`, f.stage === "all" ? S.stageAll : fill(S.stage, { v: t.leads.stages[f.stage] })];
  if (f.q.trim()) parts.push(fill(S.q, { v: f.q.trim() }));
  // the shortcut chips first (as they sit on screen), then the rest in filter order
  const first: (keyof LeadFilters)[] = ["hasPhone", "hasEmail", "hasContactName", "lastTouch", "entered"];
  const keys = activeFilterKeys(f).sort((a, b) => (first.includes(a) ? first.indexOf(a) : 99) - (first.includes(b) ? first.indexOf(b) : 99));
  for (const k of keys) parts.push(phraseOf(k, f, agents, t));
  return parts.join(" · ");
}
