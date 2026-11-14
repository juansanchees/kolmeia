// Candidate de-duplication (G9): same normalized name, same website domain or same phone = same company.
import { hostOf } from "@/lib/safe-url";

const SUFFIXES = /\b(inc|incorporated|llc|l\.l\.c|corp|corporation|co|company|ltd|limited|lp|llp|pc|the)\b/g;

export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

// Directory / social hosts are shared by many companies, so they never identify one.
const SHARED_HOSTS = ["facebook.com", "instagram.com", "yelp.com", "google.com", "houzz.com", "bbb.org", "angi.com", "homeadvisor.com", "nextdoor.com", "x.com", "twitter.com", "sites.google.com", "wixsite.com", "squarespace.com"];

export function domainKey(website: string | null | undefined): string | null {
  if (!website) return null;
  const h = hostOf(website);
  if (!h || SHARED_HOSTS.some((s) => h === s || h.endsWith(`.${s}`))) return null;
  return h;
}

/** Last 10 digits (US numbers with or without +1). */
export function phoneKey(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const d = phone.replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}

export type Dedupable = { name: string; website?: string | null; phone?: string | null };

/**
 * Returns the incoming items that are not duplicates of `existing` (or of each other), plus the names that were
 * merged away and, for each, the name it was merged into, so the run's notes can say which ones were unified (G9).
 */
export function dedupe<T extends Dedupable>(
  existing: Dedupable[],
  incoming: T[],
): { fresh: T[]; merged: string[]; mergedInto: { name: string; into: string }[] } {
  const names = new Map<string, string>();
  const domains = new Map<string, string>();
  const phones = new Map<string, string>();
  const add = (c: Dedupable) => {
    const n = nameKey(c.name);
    if (n && !names.has(n)) names.set(n, c.name);
    const d = domainKey(c.website);
    if (d && !domains.has(d)) domains.set(d, c.name);
    const p = phoneKey(c.phone);
    if (p && !phones.has(p)) phones.set(p, c.name);
  };
  existing.forEach(add);
  const fresh: T[] = [];
  const merged: string[] = [];
  const mergedInto: { name: string; into: string }[] = [];
  for (const c of incoming) {
    const n = nameKey(c.name);
    const d = domainKey(c.website);
    const p = phoneKey(c.phone);
    if (!n) continue;
    const into = names.get(n) ?? (d ? domains.get(d) : undefined) ?? (p ? phones.get(p) : undefined);
    if (into !== undefined) {
      merged.push(c.name);
      mergedInto.push({ name: c.name, into });
      continue;
    }
    add(c);
    fresh.push(c);
  }
  return { fresh, merged, mergedInto };
}
