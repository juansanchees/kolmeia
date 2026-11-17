// Display helpers in the UI language's number and date format (`intl` is t.intl: pt-BR or en-US).
// Unknown values render as "?" (rule P2), never as a guess; "?" is the same in every language.
export const UNKNOWN = "?";

const en = (intl: string) => intl.startsWith("en");

export function money(v: number | null | undefined, intl: string): string {
  if (v === null || v === undefined) return UNKNOWN;
  if (v >= 1_000_000) return `US$ ${new Intl.NumberFormat(intl, { maximumFractionDigits: 1 }).format(v / 1_000_000)}${en(intl) ? "M" : " mi"}`;
  return `US$ ${new Intl.NumberFormat(intl).format(Math.round(v))}`;
}

export function moneyFull(v: number | null | undefined, intl: string): string {
  return v === null || v === undefined ? "" : `US$ ${new Intl.NumberFormat(intl).format(Math.round(v))}`;
}

export function usd(v: number, intl: string): string {
  return new Intl.NumberFormat(intl, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
}

export function count(v: number | null | undefined, intl: string): string {
  return v === null || v === undefined ? UNKNOWN : new Intl.NumberFormat(intl).format(v);
}

/** YYYY-MM-DD or ISO -> DD/MM/YYYY (pt-BR) or MM/DD/YYYY (en-US). */
export function date(v: string | null | undefined, intl: string): string {
  if (!v) return UNKNOWN;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return UNKNOWN;
  return en(intl) ? `${m[2]}/${m[3]}/${m[1]}` : `${m[3]}/${m[2]}/${m[1]}`;
}

export function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
