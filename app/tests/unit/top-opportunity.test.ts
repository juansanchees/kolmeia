import { describe, expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
import { otherOpportunities, topOpportunity } from "@/lib/hunt/top-opportunity";

type Row = { id: string; lead_id: string; status: string; priority: number; signal_date: string | null; title: string; source_url: string | null };
// Tiny in-memory stand-in for the query builder: applies eq/neq/order/limit for real.
function fake(rows: Row[]) {
  return { from: () => {
    let r = [...rows]; const ord: [string, boolean, boolean][] = []; let lim = Infinity;
    const b = {
      select: () => b,
      eq: (c: string, v: unknown) => (r = r.filter((x) => (x as never)[c] === v), b),
      neq: (c: string, v: unknown) => (r = r.filter((x) => (x as never)[c] !== v), b),
      order: (c: string, o: { ascending: boolean; nullsFirst?: boolean }) => (ord.push([c, o.ascending, o.nullsFirst ?? false]), b),
      limit: (n: number) => (lim = n, b),
      then: (f: (v: unknown) => unknown) => { const out = sorted(); return Promise.resolve({ data: out.slice(0, lim), count: out.length }).then(f); },
      maybeSingle: async () => ({ data: sorted()[0] ?? null }),
    };
    const sorted = () => [...r].sort((a, c) => { for (const [k, asc, nf] of ord) { const x = (a as never)[k] as string | number | null, y = (c as never)[k] as string | number | null; if (x === y) continue; if (x == null) return nf ? -1 : 1; if (y == null) return nf ? 1 : -1; return (x < y ? -1 : 1) * (asc ? 1 : -1); } return 0; });
    return b;
  } } as unknown as SupabaseClient;
}
const row = (id: string, priority: number, signal_date: string | null): Row => ({ id, lead_id: "l1", status: "open", priority, signal_date, title: `job ${id}`, source_url: null });

describe("opportunity order", () => {
  test("ties: top is stable, never repeated under others, nothing dropped", async () => {
    const db = fake([row("c", 50, "2026-10-01"), row("a", 50, "2026-10-01"), row("b", 50, "2026-11-01"), row("d", 50, null), row("e", 10, "2026-11-10")]);
    const top = await topOpportunity(db, "l1");
    expect(top?.id).toBe("b"); // same priority: newest date first
    const o = await otherOpportunities(db, "l1", top!.id);
    expect(o.items.map((x) => x.title)).toEqual(["job a", "job c", "job d"]); // tie on date: id asc, null date last
    expect(o.total).toBe(4);
    expect(o.items.some((x) => x.title === "job b")).toBe(false);
  });
  test("no top, no others", async () => {
    expect(await otherOpportunities(fake([]), "l1", undefined)).toEqual({ items: [], total: 0 });
  });
});
