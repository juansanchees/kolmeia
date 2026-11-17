// Client-safe: turns a full list item into the slim row the leads table receives (no hook, notes, closer brief...).
import type { Messages } from "@/lib/i18n";
import { segmentOf, segmentInputOf } from "./classify";
import { originLabel } from "./view";
import { TABLE_BEST_COLUMNS, type LeadListItem, type LeadTableRow, type OriginList, type TableBest, type TableLead } from "./types";

const LEAD_KEYS = ["id", "status", "level", "origin_kind", "origin_agent_id", "first_contacted_at", "last_touch_at", "segment", "first_seen_at", "owner_id"] as const;

const pick = <T extends object, K extends keyof T>(o: T, keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, o[k]])) as Pick<T, K>;

export function toTableRow(i: LeadListItem, origins: OriginList[]): LeadTableRow {
  return {
    lead: pick(i.lead, LEAD_KEYS) as TableLead,
    best: i.best ? (pick(i.best, TABLE_BEST_COLUMNS) as TableBest) : null,
    display: i.display,
    agentName: i.agentName,
    importName: i.importName,
    emailQuality: i.emailQuality,
    ai: i.ai,
    origins,
    segment: segmentOf(segmentInputOf(i.lead, i.best, i.display.companyType ?? null, origins)),
    profileMatch: i.profileMatch,
  };
}

/** The origin shown in the table and CSV: the first list the lead came from, else the old origin label. */
export function originText(r: Pick<LeadTableRow, "origins" | "lead" | "agentName" | "importName">, t: Messages): string {
  return r.origins[0]?.name ?? originLabel(r, t);
}
