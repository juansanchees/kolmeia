// Client-safe rules of the LEADS list: filters, origin label, stale proof, proof count, CSV.
import { byTemperature, inTab, SHEET_COLUMNS, toCsv, type Column, type Tab } from "@/lib/research/sheet";
import type { CheckWithEvidence } from "@/lib/research/store";
import type { Temperature } from "@/lib/research/types";
import { t } from "@/messages/pt";
import type { LeadListItem, LeadStatus } from "./types";

export const STALE_PROOF_DAYS = 90;
const DAY_MS = 86_400_000;

/** C4: proof seen more than 90 days before `now` is "prova velha". A missing or unreadable date is not stale. */
export function isStaleProof(seenAt: string | null | undefined, now: Date): boolean {
  if (!seenAt) return false;
  const ms = Date.parse(seenAt);
  if (Number.isNaN(ms)) return false;
  return now.getTime() - ms > STALE_PROOF_DAYS * DAY_MS;
}

/** Checks that passed and carry at least one piece of evidence. */
export function proofCount(checks: Pick<CheckWithEvidence, "result" | "evidence">[]): number {
  return checks.filter((c) => c.result === "ok" && c.evidence.length > 0).length;
}

export type LeadTab = Exclude<Tab, "jobs">;

export type LeadFilters = {
  q: string;
  temperature: Temperature | "all";
  agent: "all" | "one_off" | string;
  status: LeadStatus | "all";
  tab: LeadTab;
};

export const DEFAULT_LEAD_FILTERS: LeadFilters = { q: "", temperature: "all", agent: "all", status: "all", tab: "all" };

function fold(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

export function filterLeads(items: LeadListItem[], f: LeadFilters): LeadListItem[] {
  const q = fold(f.q.trim());
  const qDigits = f.q.replace(/\D/g, "");
  return items
    .filter(({ lead, best }) => {
      if (!inTab(best, f.tab)) return false;
      if (f.temperature !== "all" && best.temperature !== f.temperature) return false;
      if (f.status !== "all" && lead.status !== f.status) return false;
      if (f.agent === "one_off" ? lead.origin_kind !== "one_off" : f.agent !== "all" && lead.origin_agent_id !== f.agent) return false;
      if (q) {
        const phone = (best.phone ?? "").replace(/\D/g, "");
        const hit = fold(best.name).includes(q) || fold(best.city ?? "").includes(q) || (qDigits.length > 0 && phone.includes(qDigits));
        if (!hit) return false;
      }
      return true;
    })
    .sort((a, b) => byTemperature(a.best, b.best));
}

export function originLabel(i: Pick<LeadListItem, "lead" | "agentName">): string {
  return i.agentName ?? t.leads.oneOff;
}

export function leadsCsv(items: LeadListItem[]): string {
  // toCsv reads one candidate per row, so status and agent are looked up by candidate id.
  const byId = new Map(items.map((i) => [i.best.id, i]));
  const extra: Column[] = [
    { id: "leadStatus", header: "Status", kind: "text", compact: false, get: (c) => { const i = byId.get(c.id); return i ? t.leads.statuses[i.lead.status] : null; } },
    { id: "leadAgent", header: "Agente", kind: "text", compact: false, get: (c) => { const i = byId.get(c.id); return i ? originLabel(i) : null; } },
  ];
  return toCsv(items.map((i) => i.best), [...SHEET_COLUMNS, ...extra]);
}
