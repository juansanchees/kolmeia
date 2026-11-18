// Scores a call queue against gold labels. Pure. Matching uses the dedupe keys (name, site domain, phone) like the baseline.
import { domainKey, nameKey, phoneKey } from "@/lib/research/dedupe";
import type { GoldRow } from "./gold";

export type QueueItem = { company: string; phone?: string | null; website?: string | null; signalRef?: string | null; sourceUrl?: string | null; contactPath?: string | null };
type Tiers = Record<string, number>;
export type QueueScore = {
  denominators: { queue: number; gold: number; goldByTier: Tiers; goldWithPermit: number };
  recovered: { count: number; byTier: Tiers; withPermit: number; goldIdx: number[] };
  missed: { count: number; byTier: Tiers; withPermit: number; goldIdx: number[] };
  /** Queue items that are not in gold: `falsePositives` have no proof; `newNotInGold` have a source and go to manual review. */
  /** Queue positions that are in gold. */
  inGoldIdx: number[];
  notInGold: number;
  falsePositives: number;
  newNotInGold: number[];
  duplicates: { company: number; signal: number };
  withProof: number;
  withContactPath: number;
  precisionAt: Record<number, number>;
};

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const keysOf = (x: { company?: string; name?: string; phone?: string | null; website?: string | null }): string[] =>
  [nameKey(x.company ?? x.name ?? "") && `n:${nameKey(x.company ?? x.name ?? "")}`, domainKey(x.website) && `d:${domainKey(x.website)}`, phoneKey(x.phone) && `p:${phoneKey(x.phone)}`].filter((k): k is string => !!k);

const count = (rows: GoldRow[], idx: number[]) => {
  const byTier: Tiers = {};
  for (const i of idx) byTier[rows[i].tier || "?"] = (byTier[rows[i].tier || "?"] ?? 0) + 1;
  return { count: idx.length, byTier, withPermit: idx.filter((i) => rows[i].hasFalmouthPermit).length, goldIdx: idx };
};

/** `queue` is already in call order (best first). */
export function scoreQueue(queue: QueueItem[], gold: GoldRow[], topNs: number[] = [25, 50]): QueueScore {
  const byKey = new Map<string, number[]>();
  gold.forEach((g, i) => keysOf(g).forEach((k) => byKey.set(k, [...(byKey.get(k) ?? []), i])));
  const hit = new Set<number>();
  const matched = queue.map((q) => {
    const m = new Set(keysOf(q).flatMap((k) => byKey.get(k) ?? []));
    m.forEach((i) => hit.add(i));
    return m.size > 0;
  });
  const seen = new Set<string>();
  const sigs = new Set<string>();
  const dup = { company: 0, signal: 0 };
  for (const q of queue) {
    const ks = keysOf(q);
    if (ks.some((k) => seen.has(k))) dup.company++;
    ks.forEach((k) => seen.add(k));
    if (q.signalRef) {
      if (sigs.has(q.signalRef)) dup.signal++;
      sigs.add(q.signalRef);
    }
  }
  const all = gold.map((_, i) => i);
  const outside = queue.map((q, i) => ({ q, i })).filter((x) => !matched[x.i]);
  return {
    denominators: { queue: queue.length, gold: gold.length, goldByTier: count(gold, all).byTier, goldWithPermit: count(gold, all).withPermit },
    recovered: count(gold, all.filter((i) => hit.has(i))),
    missed: count(gold, all.filter((i) => !hit.has(i))),
    inGoldIdx: matched.flatMap((m, i) => (m ? [i] : [])),
    notInGold: outside.length,
    falsePositives: outside.filter((x) => !x.q.sourceUrl).length,
    newNotInGold: outside.filter((x) => !!x.q.sourceUrl).map((x) => x.i),
    duplicates: dup,
    withProof: queue.filter((q) => !!q.sourceUrl).length,
    withContactPath: queue.filter((q) => q.contactPath && q.contactPath !== "none").length,
    precisionAt: Object.fromEntries(topNs.map((n) => [n, queue.length ? r3(matched.slice(0, n).filter(Boolean).length / Math.min(n, queue.length)) : 0])),
  };
}

export type RoundItem = { key: string; priority: number };
/** Round a -> round b by item key: priority up/down/same, new in b, dropped from a (demoted out of the queue). */
export function compareRounds(a: RoundItem[], b: RoundItem[]): { up: number; down: number; same: number; new: number; dropped: number } {
  const prev = new Map(a.map((x) => [x.key, x.priority]));
  const now = new Set(b.map((x) => x.key));
  const d = { up: 0, down: 0, same: 0, new: 0, dropped: a.filter((x) => !now.has(x.key)).length };
  for (const x of b) {
    const p = prev.get(x.key);
    if (p === undefined) d.new++;
    else if (x.priority > p) d.up++;
    else if (x.priority < p) d.down++;
    else d.same++;
  }
  return d;
}

/** "Acme Builders LLC" in Falmouth -> "A.B.L. (Falmouth)": initials and town only, never a full name, phone or address. */
export function anonymize(company: string, town: string): string {
  const ini = company.split(/[^A-Za-z]+/).filter(Boolean).slice(0, 4).map((w) => `${w[0].toUpperCase()}.`).join("");
  return `${ini || "?"} (${town.replace(/[^A-Za-z .'-]/g, "").slice(0, 40) || "?"})`;
}
