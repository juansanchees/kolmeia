import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
const researchSession = vi.fn();
vi.mock("@/lib/research/session", () => ({ researchSession: () => researchSession() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`redirect:${u}`); } }));
vi.mock("@/lib/i18n/server", async () => {
  const { pt } = await import("@/messages/pt");
  return { getT: async () => pt };
});

const { GET } = await import("@/app/api/agents/[id]/live/route");
const { runHunterNowAction } = await import("@/app/(app)/agentes/agent-actions");
const { pt } = await import("@/messages/pt");

const ID = "11111111-1111-4111-8111-111111111111";
const get = (id: string) => GET(new Request(`https://x.test/api/agents/${id}/live`), { params: Promise.resolve({ id }) });

/** Fake supabase: every chain method returns the builder; maybeSingle/await resolve per table. */
function fakeDb(tables: Record<string, { row?: unknown; count?: number }>) {
  return {
    from(table: string) {
      const t = tables[table] ?? {};
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: t.row ?? null });
      b.then = (res: (v: unknown) => unknown) => res({ count: t.count ?? 0 });
      return b;
    },
  };
}

beforeEach(() => researchSession.mockReset());

describe("GET /api/agents/[id]/live", () => {
  test("404 for an invalid uuid", async () => {
    const res = await get("nope");
    expect(res.status).toBe(404);
    expect(researchSession).not.toHaveBeenCalled();
  });
  test("404 without a session", async () => {
    researchSession.mockResolvedValue(null);
    expect((await get(ID)).status).toBe(404);
  });
  test("404 when the agent is not visible or not a hunter", async () => {
    researchSession.mockResolvedValue({ supabase: fakeDb({}) });
    expect((await get(ID)).status).toBe(404);
    researchSession.mockResolvedValue({ supabase: fakeDb({ agents: { row: { type: "email", status: "running", next_run_at: null, paused_reason: null } } }) });
    expect((await get(ID)).status).toBe(404);
  });
  test("200 with the live shape for a running run, no-store", async () => {
    const run = { id: "r1", status: "running", started_at: "2026-11-17T10:00:00Z", finished_at: null, spent_cost_usd: "0.5", max_cost_usd: "2", max_candidates: 10, progress: { stage: "search" }, error: null };
    researchSession.mockResolvedValue({
      supabase: fakeDb({
        agents: { row: { type: "hunter", status: "running", next_run_at: null, paused_reason: null } },
        research_runs: { row: run },
        research_candidates: { row: { name: "Acme Co" }, count: 3 },
      }),
    });
    const res = await get(ID);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ state: "running", run: { id: "r1", stage: "search", found: 3, maxFound: 10, lastName: "Acme Co", spentUsd: 0.5, maxUsd: 2 } });
  });
});

describe("runHunterNowAction", () => {
  const session = (rpc: unknown, role = "owner") => ({ supabase: { rpc }, workspace: { id: "w", role } });
  test("queued is success", async () => {
    researchSession.mockResolvedValue(session(async () => ({ data: "queued", error: null })));
    expect(await runHunterNowAction(ID)).toEqual({ status: "success" });
  });
  test("already_running is success with its message", async () => {
    researchSession.mockResolvedValue(session(async () => ({ data: "already_running", error: null })));
    expect(await runHunterNowAction(ID)).toEqual({ status: "success", message: pt.agents.hunter.errors.alreadyRunning });
  });
  test("too_many is the tooMany error", async () => {
    researchSession.mockResolvedValue(session(async () => ({ data: "too_many", error: null })));
    expect(await runHunterNowAction(ID)).toEqual({ status: "error", message: pt.agents.errors.tooMany });
  });
  test("a database error is a generic error, internals not echoed", async () => {
    researchSession.mockResolvedValue(session(async () => ({ data: null, error: { message: "secret detail" } })));
    expect(await runHunterNowAction(ID)).toEqual({ status: "error", message: pt.agents.live.runFailed });
  });
  test("run-now failures use the run-now copy, not the creation copy", async () => {
    researchSession.mockResolvedValue(session(async () => ({ data: "weird", error: null })));
    expect(await runHunterNowAction(ID)).toEqual({ status: "error", message: pt.agents.live.runFailed });
    expect(pt.agents.live.runFailed).not.toBe(pt.agents.hunter.errors.failed);
  });
  test("bad uuid never reaches the database", async () => {
    const rpc = vi.fn();
    researchSession.mockResolvedValue(session(rpc));
    expect((await runHunterNowAction("x")).status).toBe("error");
    expect(rpc).not.toHaveBeenCalled();
  });
});
