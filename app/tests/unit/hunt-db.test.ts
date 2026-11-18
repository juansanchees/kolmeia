import { describe, expect, test } from "vitest";
import { ID_CHUNK, supabaseHuntDb } from "@/lib/hunt/db";

// outcomes(): ids are chunked so the request URL stays short. Fake client, invented data.
describe("supabaseHuntDb.outcomes", () => {
  test("chunks lead ids and merges the newest call per lead", async () => {
    const n = ID_CHUNK * 2 + 5;
    const leadIds = Array.from({ length: n }, (_, i) => `lead-${i}`);
    const facts = { signal: { kind: "permit", source: "permit", source_ref: "p", description: "New single family dwelling" }, company: null, link_status: "none", contacts: {} };
    const sizes: number[] = [];
    const db = {
      from(t: string) {
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.eq = () => (t === "lead_opportunities" ? Promise.resolve({ data: leadIds.map((l) => ({ lead_id: l, facts })), error: null }) : q);
        q.in = (_c: string, part: string[]) => {
          sizes.push(part.length);
          return Promise.resolve({ data: t === "leads" ? part.map((id) => ({ id, status: "new" })) : part.includes("lead-0") ? [{ lead_id: "lead-0", outcome: "no_answer", called_at: "2026-11-01" }, { lead_id: "lead-0", outcome: "not_interested", called_at: "2026-11-02" }] : [], error: null });
        };
        return q;
      },
    };
    const out = await supabaseHuntDb(db as never).outcomes("c1");
    expect(out).toHaveLength(n);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(ID_CHUNK);
    expect(sizes.length).toBe(6); // 3 chunks x (leads + calls)
    expect(out.find((o) => o.lead_id === "lead-0")!.call).toBe("not_interested");
  });
});
