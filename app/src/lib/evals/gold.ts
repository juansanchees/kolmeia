// Gold labels of the Falmouth pilot, read from a private CSV that lives outside the repo (PILOT_DATA_DIR/gold/).
// Only the eval script reads it; the round runner never does.
import { parseCsv } from "@/lib/leads/baseline";

export type GoldRow = { company: string; tier: string; temperature: string; city: string; phone?: string; website?: string; hasFalmouthPermit: boolean };

const yes = (s: string) => /^(1|true|yes|y|sim)$/i.test(s.trim());

/** Columns by header name; rows without a company are dropped. */
export function goldFromCsv(csv: string): GoldRow[] {
  const [head, ...rows] = parseCsv(csv);
  if (!head) return [];
  const h = head.map((x) => x.trim().toLowerCase());
  const at = (r: string[], k: string) => (r[h.indexOf(k)] ?? "").trim();
  return rows
    .map((r) => ({
      company: at(r, "company"),
      tier: at(r, "tier"),
      temperature: at(r, "temperature"),
      city: at(r, "city"),
      ...(at(r, "phone") ? { phone: at(r, "phone") } : {}),
      ...(at(r, "website") ? { website: at(r, "website") } : {}),
      hasFalmouthPermit: yes(at(r, "has_falmouth_permit")),
    }))
    .filter((g) => g.company);
}
