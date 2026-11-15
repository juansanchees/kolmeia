/** The New York calendar day (same as SQL call_day()), as yyyy-mm-dd. */
export function nyDay(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
