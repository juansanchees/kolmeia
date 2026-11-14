import type { AiLedger } from "@/lib/ai/gateway";
import type { RawHttp, RawResponse } from "@/lib/qualifier/site/net";
import type { QualifierTickStore } from "@/lib/qualifier/store";
import type { FieldRow, LeadSnapshot } from "@/lib/qualifier/types";

/** Fake network keyed by exact URL; no match = robots.txt 404 (allow all) or a 404 page. Records every URL asked. */
export function fakeHttp(pages: Record<string, Partial<RawResponse>>): RawHttp & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(url) {
      calls.push(url);
      const p = pages[url];
      if (!p) return { status: 404, headers: { "content-type": url.endsWith("/robots.txt") ? "text/plain" : "text/html" }, body: "", truncated: false };
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: "", truncated: false, ...p };
    },
  };
}

export const htmlPage = (body: string): Partial<RawResponse> => ({ body: `<html><body>${body}</body></html>` });

let n = 0;
export function field(f: Partial<FieldRow> & { field: string; value: string }): FieldRow {
  return { id: `f${++n}`, leadId: "lead-1", source: "import", sourceRef: null, status: "unverified", excerpt: null, seenAt: null, ...f };
}

export function snapshot(p: Partial<LeadSnapshot> = {}): LeadSnapshot {
  return {
    leadId: "lead-1",
    workspaceId: "ws-1",
    nextStep: "p1",
    level: 0,
    spentUsd: 0,
    failStep: null,
    failStreak: 0,
    deepRequested: false,
    manual: false,
    profileMatch: false,
    notes: {},
    fields: [],
    best: null,
    settings: { dailyCapUsd: 5, leadCapUsd: 0.5, autoDeep: true, spentToday: 0 },
    companyProfile: null,
    ...p,
  };
}

const NO = () => Promise.reject(new Error("fake ledger"));

/** Hands out the snapshots in order, then null. Every call is logged as [name, ...args] after the tick id. */
export function fakeQualifierStore(
  snapshots: LeadSnapshot[],
  o: {
    busy?: boolean;
    merge?: number | ((lead: string) => number);
    failOn?: Partial<Record<"merge" | "addFields" | "stepDone" | "claimNext" | "refute" | "reservePlaces", Error>>;
    ledger?: AiLedger;
  } = {},
): QualifierTickStore & { log: unknown[][] } {
  const queue = [...snapshots];
  const log: unknown[][] = [];
  const rec = <T>(name: string, rest: unknown[], v: T): T => {
    log.push([name, ...rest]);
    const err = o.failOn?.[name as keyof typeof o.failOn];
    if (err) throw err;
    return v;
  };
  const ledger: AiLedger = o.ledger ?? { dailyCapUsd: NO, spentTodayUsd: NO, record: NO };
  return {
    log,
    async beginTick() {
      return rec("beginTick", [], o.busy ? { tickId: "", busy: true } : { tickId: "tick-1", busy: false });
    },
    async finishTick(_t, counts, error) {
      rec("finishTick", [counts, error], undefined);
    },
    async claimNext() {
      return rec("claimNext", [], queue.shift() ?? null);
    },
    async merge(_t, lead) {
      return rec("merge", [lead], typeof o.merge === "function" ? o.merge(lead) : (o.merge ?? 0));
    },
    async addFields(_t, lead, rows) {
      return rec("addFields", [lead, rows], rows.length);
    },
    async refute(_t, lead, ids) {
      rec("refute", [lead, ids], undefined);
    },
    async stepDone(_t, lead, step, outcome, next, reason) {
      rec("stepDone", [lead, step, outcome, next, reason], undefined);
    },
    async release(_t, lead) {
      rec("release", [lead], undefined);
    },
    async pause(_t, ws, reason) {
      rec("pause", [ws, reason], undefined);
    },
    ledger: () => ledger,
    async reservePlaces(_t, lead, usd) {
      return rec("reservePlaces", [lead, usd], "res-1");
    },
    async settlePlaces(_t, lead, id, cost, ok) {
      rec("settlePlaces", [lead, id, cost, ok], undefined);
    },
  };
}
