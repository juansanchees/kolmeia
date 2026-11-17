// Client-safe words of the Home: the New York date line of the plan's hero.
import type { Messages } from "@/lib/i18n";

const TZ = "America/New_York";

/** "TERÇA, 17 DE NOVEMBRO" / "TUESDAY, NOVEMBER 17" (New York date, UI language). */
export function dateLineOf(now: Date, t: Messages): string {
  return new Intl.DateTimeFormat(t.intl, { timeZone: TZ, weekday: "long", day: "numeric", month: "long" }).format(now).replace("-feira", "").toLocaleUpperCase(t.intl);
}
