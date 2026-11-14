import { describe, expect, it } from "vitest";
import { ID_CHUNK, getLead, inChunks, listLeads } from "@/lib/leads/queries";

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
      origin_run_id: null, origin_import_id: null, owner_id: null, first_seen_at: "2026-11-01T00:00:00Z", last_seen_at: "2026-11-01T00:00:00Z",
    }));
    const calls: Record<string, number> = {};
    const db = {
      from(table: string) {
        const q = {
          select: () => q, eq: () => q, not: () => q, order: () => q, limit: () => q, range: () => q,
          in: (_col: string, ids: string[]) => {
            calls[table] = (calls[table] ?? 0) + 1;
            if (table === "research_checks") {
              const ev = [{ url: "https://x.test", title: "t", excerpt: "e", seen_at: "2026-11-01T00:00:00Z" }];
              const data = ids.includes("c0") ? [{ id: "k1", candidate_id: "c0", result: "ok", research_evidence: ev }, { id: "k2", candidate_id: "c0", result: "no", research_evidence: ev }] : [];
              return Promise.resolve({ data, error: null });
            }
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
    expect(items.find((i) => i.lead.id === "l0")?.proofOk).toBe(1);
    expect(items.find((i) => i.lead.id === "l1")?.proofOk).toBe(0);
  });

  it("listLeads reads leads without a best candidate with their display fields, in pages of 1000", async () => {
    const mk = (i: number) => ({
      id: `l${i}`, workspace_id: "w", best_candidate_id: null, status: "new", origin_kind: "import", origin_agent_id: null,
      origin_run_id: null, origin_import_id: i % 2 ? "imp1" : null, owner_id: null, first_seen_at: "2026-11-01T00:00:00Z", last_seen_at: "2026-11-01T00:00:00Z",
    });
    const all = Array.from({ length: 1200 }, (_, i) => mk(i));
    const ranges: [number, number][] = [];
    const fieldCalls: number[] = [];
    const db = {
      from(table: string) {
        let range: [number, number] | null = null;
        const q = {
          select: () => q, eq: () => q, order: () => q,
          range: (a: number, b: number) => { ranges.push([a, b]); range = [a, b]; return q; },
          in: (col: string, ids: string[]) => {
            if (table === "lead_fields" && col === "lead_id") {
              fieldCalls.push(ids.length);
              return { in: () => Promise.resolve({ data: ids.map((id) => ({ id: `f-${id}`, lead_id: id, field: "name", value: `Co ${id}`, source: "import", source_ref: "imp1", status: "unverified", excerpt: null, seen_at: "2026-11-01T00:00:00Z" })), error: null }) };
            }
            const data = table === "lead_imports" ? [{ id: "imp1", list_name: "Lista Teste" }] : [];
            return Promise.resolve({ data, error: null });
          },
          then: (res: (v: unknown) => unknown) => res({ data: range ? all.slice(range[0], range[1] + 1) : all, error: null }),
        };
        return q;
      },
    };
    const items = await listLeads(db as never, "w");
    expect(ranges).toEqual([[0, 999], [1000, 1999]]);
    expect(items).toHaveLength(1200);
    expect(fieldCalls).toHaveLength(24);
    expect(Math.max(...fieldCalls)).toBe(50);
    expect(items[3].best).toBeNull();
    expect(items[3].display.name).toBe("Co l3");
    expect(items[3].importName).toBe("Lista Teste");
    expect(items[2].importName).toBeNull();
  });

  it("getLead: checks from several chunks come back in created_at order", async () => {
    const cands = Array.from({ length: 150 }, (_, i) => ({ id: `c${i}`, name: `N${i}`, research_runs: { title: "R", created_at: "2026-11-01T00:00:00Z" } }));
    const db = {
      from(table: string) {
        const q = {
          select: () => q, eq: () => q, order: () => q, range: () => Promise.resolve({ data: [], error: null }),
          maybeSingle: () => Promise.resolve({ data: { id: "l1", origin_agent_id: null }, error: null }),
          in: (_col: string, ids: string[]) => {
            const res = Promise.resolve({
              data: ids.includes("c0")
                ? [{ id: "k-b", candidate_id: "c0", created_at: "2026-11-03T00:00:00Z", research_evidence: [] }, { id: "k-d", candidate_id: "c0", created_at: "2026-11-05T00:00:00Z", research_evidence: [] }]
                : [{ id: "k-a", candidate_id: "c120", created_at: "2026-11-02T00:00:00Z", research_evidence: [] }, { id: "k-c", candidate_id: "c120", created_at: "2026-11-04T00:00:00Z", research_evidence: [] }],
              error: null,
            });
            return Object.assign(res, { order: () => res });
          },
          then: (res: (v: unknown) => unknown) => res({ data: table === "research_candidates" ? cands : [], error: null }),
        };
        return q;
      },
    };
    const d = await getLead(db as never, "l1");
    expect(d?.checks.map((c) => c.id)).toEqual(["k-a", "k-b", "k-c", "k-d"]);
  });
});
