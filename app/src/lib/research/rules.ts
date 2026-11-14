// Small pure rules the engine and the screens share. The UI shows the same thresholds (G5).
import { hostOf, sanitizeUrl } from "@/lib/safe-url";
import type { Approach, CheckResult, Rigor, Temperature } from "./types";

/** Temperature thresholds (one place; the UI reads them too). */
export const TEMPERATURE_RULE = {
  largeJobUsd: 500_000,
  veryRecentDays: 60,
  strongPresenceReviews: 5,
} as const;

export type TemperatureInput = {
  hasWork: CheckResult | null;
  existsActive: CheckResult | null;
  biggestJobValueUsd: number | null;
  lastPermitDate: string | null; // YYYY-MM-DD
  website: string | null;
  reviewCount: number | null;
  refuted?: boolean;
  now: Date;
};

function daysSince(date: string, now: Date): number | null {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

/**
 * very_hot = has work, with a large (>= US$ 500k) or very recent (<= 60 days) job;
 * hot = has work in the period; warm = solid company (active, or website + 5 reviews) without confirmed work;
 * cold = no signal and weak presence. A candidate the second pass refuted is cold.
 */
export function temperature(i: TemperatureInput): Temperature {
  if (i.refuted || i.existsActive === "no") return "cold";
  if (i.hasWork === "ok") {
    const large = (i.biggestJobValueUsd ?? 0) >= TEMPERATURE_RULE.largeJobUsd;
    const days = i.lastPermitDate ? daysSince(i.lastPermitDate, i.now) : null;
    const recent = days !== null && days >= 0 && days <= TEMPERATURE_RULE.veryRecentDays;
    return large || recent ? "very_hot" : "hot";
  }
  const strongPresence = Boolean(i.website) && (i.reviewCount ?? 0) >= TEMPERATURE_RULE.strongPresenceReviews;
  if (i.existsActive === "ok" || strongPresence) return "warm";
  return "cold";
}

export type ApproachInput = {
  isLargeContractor: boolean;
  supplierPortalUrl: string | null;
  phone: string | null;
  publicEmail: string | null;
};

/** Large builders with a supplier/subcontractor prequalification page -> sign up there; otherwise call. */
export function approach(i: ApproachInput): Approach {
  if (i.isLargeContractor && sanitizeUrl(i.supplierPortalUrl)) return "supplier_signup";
  if (!i.phone && i.publicEmail) return "email";
  return "call";
}

export type EvidenceIn = { url: string; title: string; excerpt: string; seenAt?: string };
export type CheckIn = { result: CheckResult; summary: string; evidence: EvidenceIn[] };

export const EVIDENCE_REASON = {
  none: "Sem fonte para confirmar.",
  singleHost: "Só uma fonte confirmou; a pesquisa rigorosa exige duas independentes.",
} as const;

/** Checks a cited URL against what the web tools actually returned in that call (finding 3). */
export type SeenFilter = {
  seen(url: string): boolean;
  seenAt?(url: string): string | undefined;
  dropped?: { count: number };
};

export const EVIDENCE_NOT_SEEN = "A fonte citada não veio das ferramentas de busca; foi descartada.";

/**
 * P1: an "ok" needs at least one (clean) source, otherwise it becomes "unknown" with the reason.
 * P9: in strict rigor an "ok" needs sources from two different hosts.
 * Also drops unsafe and blocked-host URLs and caps the text sizes (R11, R15), and, when a filter is given, every
 * URL no web tool returned in that call; seenAt then comes from the fetch's retrieval time when known.
 */
export function applyEvidenceRules(check: CheckIn, rigor: Rigor, filter?: SeenFilter): CheckIn {
  const seen = new Set<string>();
  const evidence: EvidenceIn[] = [];
  let droppedHere = 0;
  for (const e of check.evidence) {
    const url = sanitizeUrl(e.url);
    if (!url || seen.has(url)) continue;
    if (filter && !filter.seen(url)) {
      droppedHere++;
      if (filter.dropped) filter.dropped.count++;
      continue;
    }
    seen.add(url);
    const seenAt = filter?.seenAt?.(url) ?? e.seenAt;
    evidence.push({
      url,
      title: clip(e.title, 200),
      excerpt: clip(e.excerpt, 300),
      ...(seenAt ? { seenAt } : {}),
    });
    if (evidence.length >= 5) break;
  }
  let result = check.result;
  let summary = clip(check.summary, 500);
  if (result === "ok") {
    const hosts = new Set(evidence.map((e) => hostOf(e.url)));
    if (evidence.length === 0) {
      result = "unknown";
      summary = clip(`${droppedHere ? EVIDENCE_NOT_SEEN : EVIDENCE_REASON.none} ${summary}`, 500);
    } else if (rigor === "strict" && hosts.size < 2) {
      result = "unknown";
      summary = clip(`${EVIDENCE_REASON.singleHost} ${summary}`, 500);
    }
  }
  return { result, summary, evidence };
}

/**
 * A hook is kept only when there is a real job behind it: confirmed work, a job address, and the hook cites that
 * address (G3). Returns null otherwise.
 */
export function normalizeHook(hook: string, jobAddress: string | null, hasWork: CheckResult | null): string | null {
  const h = clip(hook.replace(/\s+/g, " "), 400);
  if (!h || hasWork !== "ok" || !jobAddress) return null;
  const street = jobAddress.split(",")[0].trim().toLowerCase();
  if (street.length < 4 || !h.toLowerCase().includes(street)) return null;
  return h;
}

export function clip(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}
