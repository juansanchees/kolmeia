// Client-safe: how the learned profile reads on the card.
import { fill, type Messages } from "@/lib/i18n";
import { POINT_KEYS, type LearnedProfile, type PointKey } from "./types";

const CITE_MAX = 5;

/** "(linhas 1, 2, 3, 4, 5…)": at most 5 row numbers, then an ellipsis. */
export function citeRows(rows: number[], t: Messages): string {
  const shown = rows.slice(0, CITE_MAX).join(", ");
  return fill(t.profile.rowsCite, { rows: rows.length > CITE_MAX ? `${shown}…` : shown });
}

/** A point's citation: its rows, or "do perfil aprovado" when a results proposal carried it over. */
export function citeOf(pt: LearnedProfile["points"][number], t: Messages): string {
  return pt.carried ? t.profile.carriedCite : citeRows(pt.rows, t);
}

/** The card's lines in the spec's order (POINT_KEYS), the model's order inside one key. */
export function cardLines(p: LearnedProfile, t: Messages): { key: PointKey; label: string; text: string; cite: string }[] {
  return POINT_KEYS.flatMap((key) =>
    p.points.filter((pt) => pt.key === key).map((pt) => ({ key, label: t.profile.keys[key], text: pt.text, cite: citeOf(pt, t) })),
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID_RE.test(s);
