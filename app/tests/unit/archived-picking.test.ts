import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const listLeads = vi.fn();
vi.mock("@/lib/leads/queries", () => ({ listLeads: (...a: unknown[]) => listLeads(...a), inChunks: async () => [] }));

import { todayList } from "@/lib/calls/list-queries";
import { pickLeads } from "@/lib/email-agent/queries";

const item = (id: string, archived_at: string | null) => ({ lead: { id, archived_at, origin_agent_id: null }, best: null, display: { name: id } });

beforeEach(() => listLeads.mockReset());

describe("archived leads are not picked", () => {
  it("email agent pickLeads drops archived leads", async () => {
    listLeads.mockResolvedValue([item("a", null), item("b", "2026-11-16T00:00:00Z")]);
    const out = await pickLeads({} as never, "w", { statuses: [] } as never);
    expect(out.map((i) => i.lead.id)).toEqual(["a"]);
  });

  it("call list (todayList) drops archived leads", async () => {
    listLeads.mockResolvedValue([item("a", null), item("b", "2026-11-16T00:00:00Z")]);
    const rows = [{ id: "i1", workspace_id: "w", lead_id: "a" }, { id: "i2", workspace_id: "w", lead_id: "b" }];
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit"]) q[m] = () => q;
    q.then = (res: (v: unknown) => unknown) => res({ data: rows, error: null });
    const out = await todayList({ from: () => q } as never, {});
    expect(out.map((r) => r.lead.lead.id)).toEqual(["a"]);
  });
});
