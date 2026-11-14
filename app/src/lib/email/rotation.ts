// E3: pure helpers for the campaign's mailbox list (no server-only import; used by actions, page and tests).

/** A campaign sends through at most this many mailboxes (also enforced by guard_campaign_mailbox() in SQL). */
export const MAX_CAMPAIGN_MAILBOXES = 10;

/** What changes between the saved list and the ticked one: `remove` in saved order, `add` in screen order, no duplicates. */
export function mailboxListChange(current: string[], next: string[]): { remove: string[]; add: string[] } {
  const wanted = [...new Set(next)];
  const have = new Set(current);
  return { remove: current.filter((id) => !wanted.includes(id)), add: wanted.filter((id) => !have.has(id)) };
}

/** Send-log rows counted per sending address. */
export function sentTodayByAddress(rows: { mailbox_address: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.mailbox_address] = (out[r.mailbox_address] ?? 0) + 1;
  return out;
}
