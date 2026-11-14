import { describe, expect, it } from "vitest";
import { ID_CHUNK, inChunks, listLeads } from "@/lib/leads/queries";

describe("F3a leads reads", () => {
  it("inChunks: 250 ids -> 3 requests of at most 100, merged in order", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id${i}`);
    const sizes: number[] = [];
    const rows = await inChunks<string>(ids, async (c) => { sizes.push(c.length); return { data: c, error: null }; }, "t");
    expect(sizes).toEqual([100, 100, 50]);
    expect(rows).toEqual(ids);
    expect(ID_CHUNK * 8).toBeLessThanOrEqual(1000);
    expect(await inChunks<string>([], async () => ({ data: ["x"], error: null }), "t")).toEqual([]);
  });

  it("inChunks: an error in any chunk throws with the label", async () => {
    await expect(inChunks<string>(["a"], async () => ({ data: null, error: { message: "boom" } }), "lbl")).rejects.toThrow("lbl: boom");
  });

  it("listLeads: chunks the id lookups and skips a lead whose best candidate is not returned", async () => {
    const leads = Array.from({ length: 250 }, (_, i) => ({
      id: `l${i}`, workspace_id: "w", best_candidate_id: `c${i}`, status: "new", origin_kind: "one_off", origin_agent_id: null,
      origin_run_id: null, owner_id: null, first_seen_at: "2026-11-01T00:00:00Z", last_seen_at: "2026-11-01T00:00:00Z",
    }));
    const calls: Record<string, number> = {};
    const db = {
      from(table: string) {
        const q = {
          select: () => q, eq: () => q, not: () => q, order: () => q, limit: () => q,
          in: (_col: string, ids: string[]) => {
            calls[table] = (calls[table] ?? 0) + 1;
            const data = table === "research_candidates" ? ids.filter((id) => id !== "c7").map((id) => ({ id, name: `N ${id}` })) : [];
            return Promise.resolve({ data, error: null });
          },
          then: (res: (v: unknown) => unknown) => res({ data: leads, error: null }),
        };
        return q;
      },
    };
    const items = await listLeads(db as never, "w");
    expect(calls).toEqual({ research_candidates: 3, research_checks: 3 });
    expect(items).toHaveLength(249);
    expect(items.find((i) => i.lead.id === "l7")).toBeUndefined();
    expect(items[0].proofOk).toBe(0);
  });
});
