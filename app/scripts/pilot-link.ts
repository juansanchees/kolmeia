// Small helpers of the round runner that tests can import without a database: the permit-number lookup over the
// base, and the write-back of a gap-found company link (re-ingest of the signal through kb_ingest).
import { normalizeAddress, type CompanyHit } from "@/lib/kb/gaps";
import type { KbItem } from "@/lib/kb/types";

export type KbHit = CompanyHit & { id: string };
export type LinkCo = { id: string; name: string; name_key: string; domain?: string | null; phone?: string | null; city?: string | null };
export type LinkSig = { kind: "permit" | "project"; source: string; source_ref: string; address?: string | null; town?: string | null; value_usd?: number | string | null; work_class?: string | null; use?: string | null; issued_on?: string | null; description?: string | null; source_url?: string | null; permit_no?: string | null };

/** Companies already linked (by another source) to a signal with the same permit number in the town: one hit = a match, several = pending. */
export async function permitNoHits(
  q: { signalCompanyIds: (permitNo: string, town: string) => Promise<string[]>; companies: (ids: string[]) => Promise<KbHit[]> },
  permitNo: string,
  town: string,
): Promise<KbHit[]> {
  const ids = [...new Set(await q.signalCompanyIds(permitNo, town))];
  return ids.length ? q.companies(ids) : [];
}

const nn = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "")) as T;

/** A match_only item for the signal with the found company's key (domain / phone / name + city). Never carries an applicant name or phone (D13). */
export function linkItem(s: LinkSig, c: LinkCo, note?: string): KbItem {
  return {
    match_only: true,
    company: nn({ name: c.name, name_key: c.name_key, website: c.domain ? `https://${c.domain}` : undefined, phone: c.phone ?? undefined, city: c.city ?? undefined }) as NonNullable<KbItem["company"]>,
    signals: [nn({ kind: s.kind, source: s.source, source_ref: s.source_ref, address: s.address, town: s.town, value_usd: s.value_usd == null ? undefined : Number(s.value_usd), work_class: s.work_class, use: s.use, issued_on: s.issued_on, description: s.description, source_url: s.source_url, permit_no: s.permit_no, link_note: note }) as never],
  };
}

/** Sends the link items in batches of at most 500; returns how many were sent. */
export async function ingestLinks(ingest: (items: KbItem[]) => Promise<unknown>, items: KbItem[]): Promise<number> {
  for (let i = 0; i < items.length; i += 500) await ingest(items.slice(i, i + 500));
  return items.length;
}

/** Same-address lookup over signals already read: companies linked to other signals at the same normalized address and town. */
export function addressLookup(sigs: { source_ref: string; address?: string | null; town?: string | null; company_id: string | null }[], companies: (ids: string[]) => KbHit[]) {
  const idx = new Map<string, { ref: string; id: string }[]>();
  for (const s of sigs) {
    const a = normalizeAddress(s.address);
    if (!a || !s.company_id) continue;
    const k = `${(s.town ?? "").toLowerCase().trim()}|${a}`;
    idx.set(k, [...(idx.get(k) ?? []), { ref: s.source_ref, id: s.company_id }]);
  }
  return async (addressKey: string, town: string, selfRef: string): Promise<KbHit[]> => {
    const ids = [...new Set((idx.get(`${town.toLowerCase().trim()}|${addressKey}`) ?? []).filter((x) => x.ref !== selfRef).map((x) => x.id))];
    return ids.length ? companies(ids) : [];
  };
}
