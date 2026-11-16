// Copiloto shortcuts on LEADS (Fase 3, item 13): ready HVAC searches that map onto the SAME filter object the facets,
// saved views and the text search use. No AI call, no new agent. Client-safe.
import { BIG_PERMIT_USD } from "./classify";
import { DEFAULT_LEAD_FILTERS, type LeadFilters } from "./view";

export { BIG_PERMIT_USD };

export type Shortcut = { id: "bigPermitBuilders" | "propertyManagers" | "hotNoContact" | "builderSequence"; filters: LeadFilters; href?: string };

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "bigPermitBuilders", filters: { ...DEFAULT_LEAD_FILTERS, companyTypes: ["builder"], tab: "signal", minPermitUsd: BIG_PERMIT_USD } },
  { id: "propertyManagers", filters: { ...DEFAULT_LEAD_FILTERS, companyTypes: ["property_manager"] } },
  { id: "hotNoContact", filters: { ...DEFAULT_LEAD_FILTERS, temperature: "hot", contact: "new" } },
  // builders that can get an e-mail and were never contacted; the screen then points to the campaign tools
  { id: "builderSequence", filters: { ...DEFAULT_LEAD_FILTERS, companyTypes: ["builder"], hasEmail: true, contact: "new" }, href: "/agentes/novo/email" },
];

/** The filters a shortcut applies, keeping the AI column the person is looking at. */
export function applyShortcut(s: Shortcut, current: LeadFilters): LeadFilters {
  return { ...s.filters, aiQuestion: current.aiQuestion };
}
