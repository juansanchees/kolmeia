import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const listLeads = vi.fn();
const inChunks = vi.fn();
vi.mock("@/lib/leads/queries", () => ({ listLeads: (...a: unknown[]) => listLeads(...a), inChunks: (...a: unknown[]) => inChunks(...a) }));

import { todayList } from "@/lib/calls/list-queries";
import { leadFilterSchema } from "@/lib/email-agent/types";

const item = (id: string, status: string) => ({ lead: { id, status, first_contacted_at: null, origin_agent_id: null }, best: null, display: { name: id } });

beforeEach(() => {
  listLeads.mockReset();
  inChunks.mockReset().mockResolvedValue([]);
});

describe("Fechado leads (won/lost/discarded) are not picked", () => {
  it("the email agent filter only accepts new and call_list, so pickLeads never asks for a closed lead", () => {
    const f = (statuses: string[]) => leadFilterSchema.safeParse({ statuses, agentId: null, temperature: null, approach: null }).success;
    expect(f(["new", "call_list"])).toBe(true);
    for (const s of ["won", "lost", "discarded"]) expect(f([s])).toBe(false);
  });

  it("today's call list drops a lead closed after the list was built, keeps one closed by today's call", async () => {
    listLeads.mockResolvedValue([item("a", "call_list"), item("b", "lost"), item("c", "discarded"), item("d", "lost")]);
    inChunks.mockResolvedValue([{ lead_id: "d", called_at: new Date().toISOString() }]);
    const rows = ["a", "b", "c", "d"].map((lead_id, i) => ({ id: `i${i}`, workspace_id: "w", lead_id }));
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit"]) q[m] = () => q;
    q.then = (res: (v: unknown) => unknown) => res({ data: rows, error: null });
    const out = await todayList({ from: () => q } as never, {});
    expect(out.map((r) => [r.lead.lead.id, r.calledToday])).toEqual([["a", false], ["d", true]]);
  });
});
