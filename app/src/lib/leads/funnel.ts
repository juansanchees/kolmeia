// Funnel counts by origin (F5). Client-safe: no server imports.
import type { LeadListItem, LeadStatus } from "./types";
import type { Messages } from "@/lib/i18n";
import { originLabel } from "./view";

export const FUNNEL_STATUSES = ["new", "call_list", "in_campaign", "replied", "with_closer", "meeting", "won", "lost"] as const;
export type FunnelKey = (typeof FUNNEL_STATUSES)[number] | "discarded";
export type FunnelRow = { origin: string; counts: Record<FunnelKey, number>; total: number };

const empty = (): Record<FunnelKey, number> => ({ new: 0, call_list: 0, in_campaign: 0, replied: 0, with_closer: 0, meeting: 0, won: 0, lost: 0, discarded: 0 });

export function funnelByOrigin(items: Pick<LeadListItem, "lead" | "agentName" | "importName">[], t: Messages): FunnelRow[] {
  const by = new Map<string, FunnelRow>();
  for (const i of items) {
    const origin = originLabel(i, t);
    const row = by.get(origin) ?? { origin, counts: empty(), total: 0 };
    row.counts[i.lead.status as LeadStatus]++;
    row.total++;
    by.set(origin, row);
  }
  return [...by.values()].sort((a, b) => b.total - a.total || a.origin.localeCompare(b.origin));
}
