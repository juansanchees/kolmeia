// "Por que este lead é quente?" (Fase 3, item 13): an explanation built ONLY from what the lead already stores (level,
// research permits and hook, values with their source, passed checks with their evidence). Template first; the
// optional AI summary gets exactly these numbered facts and must cite them. Client-safe.
import { date, money } from "@/components/research/format";
import { levelReason } from "@/lib/qualifier/view";
import type { CandidateRow } from "@/lib/research/rows";
import type { CheckWithEvidence } from "@/lib/research/store";
import { sanitizeUrl } from "@/lib/safe-url";
import { fill, t } from "@/messages/pt";
import type { LeadFieldRow } from "./types";

export type WhyFact = { text: string; url: string | null };
export type WhyIn = { level: number; best: CandidateRow | null; fields: LeadFieldRow[]; checks: Pick<CheckWithEvidence, "candidate_id" | "kind" | "result" | "evidence">[] };

const W = t.leads.whyHot;
const MAX_FACTS = 10;
/** Values that say something about the work or the person to ask for (not phone/e-mail plumbing). */
const WHY_FIELDS = new Set(["active_project", "company_type", "contact_name", "contact_title", "note"]);
const url = (u: string | null | undefined) => (u ? sanitizeUrl(u) : null);

export function whyHotFacts(i: WhyIn): WhyFact[] {
  const out: WhyFact[] = [{ text: fill(W.level, { n: i.level, reason: levelReason(i.fields, i.level) }), url: null }];
  const b = i.best;
  const ok = i.checks.filter((k) => k.result === "ok" && k.candidate_id === b?.id && k.evidence.length > 0);
  const workUrl = url(ok.find((k) => k.kind === "has_work")?.evidence[0]?.url);
  if (b?.temperature) out.push({ text: fill(W.temperature, { v: t.research.labels.temperature[b.temperature] }), url: null });
  if ((b?.permit_count ?? 0) > 0) out.push({ text: fill(W.permits, { n: b!.permit_count!, total: money(b!.total_value_usd), date: date(b!.last_permit_date) }), url: workUrl });
  if (b?.biggest_job_address) {
    out.push({ text: fill(W.biggest, { v: [b.biggest_job_address, b.biggest_job_type, b.biggest_job_value_usd !== null ? money(b.biggest_job_value_usd) : null].filter(Boolean).join(" · ") }), url: workUrl });
  }
  if (b?.hook) out.push({ text: fill(W.hook, { v: b.hook }), url: url(b.found_at_url) });
  for (const f of i.fields) {
    if (!WHY_FIELDS.has(f.field) || f.status === "refuted" || f.source === "pattern") continue;
    out.push({ text: fill(W.field, { field: f.field, value: f.value.slice(0, 200), source: f.source }), url: url(f.source_ref) });
  }
  for (const k of ok) for (const e of k.evidence) out.push({ text: fill(W.proof, { v: (e.excerpt || e.title || e.url).slice(0, 200) }), url: url(e.url) });
  return out.slice(0, MAX_FACTS);
}

/** Only the level line: nothing stored says why this lead is hot. */
export function isThin(facts: WhyFact[]): boolean {
  return facts.length <= 1;
}
