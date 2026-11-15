// Client-safe: how the learned profile reads on the card.
import { fill, t } from "@/messages/pt";
import { POINT_KEYS, type LearnedProfile, type PointKey } from "./types";

const CITE_MAX = 5;

/** "(linhas 1, 2, 3, 4, 5…)": at most 5 row numbers, then an ellipsis. */
export function citeRows(rows: number[]): string {
  const shown = rows.slice(0, CITE_MAX).join(", ");
  return fill(t.profile.rowsCite, { rows: rows.length > CITE_MAX ? `${shown}…` : shown });
}

/** The card's lines in the spec's order (POINT_KEYS), the model's order inside one key. */
export function cardLines(p: LearnedProfile): { key: PointKey; label: string; text: string; cite: string }[] {
  return POINT_KEYS.flatMap((key) =>
    p.points.filter((pt) => pt.key === key).map((pt) => ({ key, label: t.profile.keys[key], text: pt.text, cite: citeRows(pt.rows) })),
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID_RE.test(s);
