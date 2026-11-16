// "Abertura por sinal" (Fase 3, item 10): the work/permit signal a draft opens with, picked from data we already hold
// (research permits, the lead's active_project / note values, the research hook). Pure and client-safe. The chosen
// text goes to the draft prompt (as untrusted data) and is stored on the draft as "Sinal usado".

export type SignalCandidate = {
  permit_count: number | null;
  last_permit_date: string | null;
  biggest_job_address: string | null;
  biggest_job_type: string | null;
  hook: string | null;
};
export type SignalField = { field: string; value: string; status: string; source: string };
export type SignalIn = { candidate: SignalCandidate | null; fields: SignalField[]; hook: string | null };

/** A note only counts as a signal when it talks about permits or work. */
const WORK_WORDS = /\b(alvar[aá]s?|permits?|obras?|construction|project|building|units?|renovation|reforma)\b/i;
const MAX = 200;

const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, MAX);
const monthYear = (iso: string | null) => {
  if (!iso || Number.isNaN(Date.parse(iso))) return null;
  return new Date(iso).toLocaleDateString("pt-BR", { month: "short", year: "numeric", timeZone: "UTC" }).replace(" de ", "/").replace(".", "");
};

/** The strongest signal, as one short label ("Alvará · 12 Elm St · mar/2026"), or null. Order: permit, active project, note, hook. */
export function pickSignal(i: SignalIn): string | null {
  const c = i.candidate;
  if (c?.biggest_job_address?.trim()) {
    return clip(["Alvará", c.biggest_job_address.trim(), c.biggest_job_type?.trim() || null, monthYear(c.last_permit_date)].filter(Boolean).join(" · "));
  }
  if ((c?.permit_count ?? 0) > 0) return clip(["Alvará", `${c!.permit_count} alvarás`, monthYear(c!.last_permit_date)].filter(Boolean).join(" · "));
  const live = i.fields.filter((f) => f.status !== "refuted" && f.source !== "pattern" && f.value.trim());
  const project = live.find((f) => f.field === "active_project");
  if (project) return clip(`Obra · ${project.value}`);
  const note = live.find((f) => f.field === "note" && WORK_WORDS.test(f.value));
  if (note) return clip(`Nota · ${note.value}`);
  const hook = (i.hook ?? c?.hook)?.trim();
  return hook ? clip(`Gancho · ${hook}`) : null;
}
