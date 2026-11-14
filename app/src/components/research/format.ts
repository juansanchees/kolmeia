// Display helpers (pt-BR). Unknown values render as "?" (rule P2), never as a guess.
import { t } from "@/messages/pt";

const nf = new Intl.NumberFormat("pt-BR");
export const UNKNOWN = t.research.labels.unknown;

export function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return UNKNOWN;
  if (v >= 1_000_000) return `US$ ${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(v / 1_000_000)} mi`;
  return `US$ ${nf.format(Math.round(v))}`;
}

export function moneyFull(v: number | null | undefined): string {
  return v === null || v === undefined ? "" : `US$ ${nf.format(Math.round(v))}`;
}

export function usd(v: number): string {
  return new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
}

export function count(v: number | null | undefined): string {
  return v === null || v === undefined ? UNKNOWN : nf.format(v);
}

/** YYYY-MM-DD or ISO -> DD/MM/YYYY */
export function date(v: string | null | undefined): string {
  if (!v) return UNKNOWN;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : UNKNOWN;
}

export function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
