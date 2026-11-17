// Client-safe: the Home's "Ligar primeiro" rule. It is a subset of the Leads filters plus an order, so the matching is
// the Leads one (filterLeads); only what the filters cannot say (several types, a minimum temperature, the order) is here.
import { z } from "zod";
import { telHref } from "@/lib/calls/view";
import { effectiveTemperature, TEMP_SCORE } from "@/lib/leads/classify";
import { SEGMENTS } from "@/lib/leads/types";
import { DEFAULT_LEAD_FILTERS, filterLeads, originKeyLabel, ROLES, type FilterRow, type LeadFilters } from "@/lib/leads/view";
import { fill, type Messages } from "@/lib/i18n";

/** How many leads the list shows. Fixed. */
export const HOME_PICK = 5;
export const HOME_SEGMENTS = [...SEGMENTS, "none"] as const;
export const HOME_MIN_TEMPS = ["any", "warm", "hot", "very_hot"] as const;
export const HOME_ORDERS = ["recommended", "biggest", "hottest", "newest"] as const;
export type HomeOrder = (typeof HOME_ORDERS)[number];

export const homeRuleSchema = z.object({
  /** Empty = any type. "none" = no type. */
  segments: z.array(z.enum(HOME_SEGMENTS)).max(HOME_SEGMENTS.length),
  hasPhone: z.boolean(),
  hasEmail: z.boolean(),
  hasContactName: z.boolean(),
  /** "" = any. */
  city: z.string().max(120),
  origin: z.string().max(120),
  minTemperature: z.enum(HOME_MIN_TEMPS),
  role: z.enum(["all", ...ROLES]),
  order: z.enum(HOME_ORDERS),
});
export type HomeRule = z.infer<typeof homeRuleSchema>;

export const DEFAULT_HOME_RULE: HomeRule = { segments: ["large"], hasPhone: true, hasEmail: false, hasContactName: false, city: "", origin: "", minTemperature: "any", role: "all", order: "recommended" };

/** A stored rule over the default: a missing key takes the default; anything unreadable (or an old shape) is the default. Never throws. */
export function parseHomeRule(raw: unknown): HomeRule {
  const r = homeRuleSchema.partial().safeParse(raw);
  if (!r.success) return DEFAULT_HOME_RULE;
  return { ...DEFAULT_HOME_RULE, ...Object.fromEntries(Object.entries(r.data).filter(([, v]) => v !== undefined)) };
}

/** What the rule filters on; do_not_call is not in the slim table row, so the caller adds it. */
export type HomeRow = FilterRow & { lead: FilterRow["lead"] & { do_not_call?: boolean } };

const ruleFilters = (r: HomeRule): LeadFilters => ({
  ...DEFAULT_LEAD_FILTERS,
  // always: only never-contacted leads in stage Novo (closed, replied, called ones are out)
  stage: "new",
  hasPhone: r.hasPhone,
  hasEmail: r.hasEmail,
  hasContactName: r.hasContactName,
  cities: r.city ? [r.city] : [],
  lists: r.origin ? [r.origin] : [],
  role: r.role,
});

const tempScore = (i: HomeRow) => TEMP_SCORE[effectiveTemperature(i.lead.level, i.best?.temperature ?? null) ?? ""] ?? null;

/** Value of each order; null = no value, always last. */
const ORDER_KEY: Record<Exclude<HomeOrder, "recommended">, (i: HomeRow) => number | null> = {
  biggest: (i) => i.best?.biggest_job_value_usd ?? null,
  hottest: tempScore,
  newest: (i) => { const ms = Date.parse(i.lead.first_seen_at); return Number.isNaN(ms) ? null : ms; },
};

/** Every lead that passes the rule, in the rule's order. The first HOME_PICK are the list; the length is the preview. */
export function homeMatches<T extends HomeRow>(rows: T[], rule: HomeRule): T[] {
  const min = rule.minTemperature === "any" ? 0 : TEMP_SCORE[rule.minTemperature];
  // filterLeads already sorts by the recommended order (priorityOf, then name); the sort below is stable, so it breaks ties that way
  const out = filterLeads(rows.filter((i) => !i.lead.do_not_call), ruleFilters(rule)).filter(
    // "has phone" means a number a call can use (the same test as "Prontas para ligar"), not just any text
    (i) => (!rule.hasPhone || telHref(i.display.phone ?? "") !== null) && (rule.segments.length === 0 || rule.segments.includes(i.segment ?? "none")) && (min === 0 || (tempScore(i) ?? 0) >= min),
  );
  if (rule.order === "recommended") return out;
  const key = ORDER_KEY[rule.order];
  return out.sort((a, b) => {
    const x = key(a), y = key(b);
    return x === null || y === null ? (x === y ? 0 : x === null ? 1 : -1) : y - x;
  });
}

export const pickFirst = <T extends HomeRow>(rows: T[], rule: HomeRule): T[] => homeMatches(rows, rule).slice(0, HOME_PICK);

/** "Grande · tem telefone · nunca contatado · ordem recomendada" (the parts of the rule in words). */
export function ruleParts(r: HomeRule, t: Messages): string[] {
  const P = t.home.rule.parts;
  const types = r.segments.map((s) => t.leads.segments[s]).join("/");
  return [
    ...(types ? [fill(P.type, { v: types })] : []),
    ...(r.hasPhone ? [P.phone] : []),
    ...(r.hasEmail ? [P.email] : []),
    ...(r.hasContactName ? [P.contactName] : []),
    ...(r.city ? [fill(P.city, { v: r.city })] : []),
    ...(r.origin ? [fill(P.origin, { v: originKeyLabel(r.origin, t) })] : []),
    ...(r.minTemperature !== "any" ? [t.home.rule.tempWords[r.minTemperature]] : []),
    ...(r.role !== "all" ? [fill(P.role, { v: t.leads.facets.roleOpts[r.role].toLowerCase() })] : []),
    P.never,
    fill(P.order, { v: t.home.rule.orders[r.order] }),
  ];
}
export const ruleInWords = (r: HomeRule, t: Messages) => fill(t.home.first.rulePrefix, { parts: ruleParts(r, t).join(" · ") });
