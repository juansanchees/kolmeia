import { describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { runHunterTick, HUNTER_MAX_RUNS, HUNTER_MAX_STEPS, HUNTER_TICK_BUDGET_MS } = await import("@/lib/hunter/tick");
import type { HunterTickStore } from "@/lib/hunter/tick-store";
import type { StepOutcome } from "@/lib/research/engine";
import type { RunRow } from "@/lib/research/rows";

const run = (status: string) => ({ id: "r", status, questions: [], plan: {} }) as unknown as RunRow;
const stepped = (more: boolean): StepOutcome => ({ kind: "stepped", did: "x", run: run(more ? "running" : "done") });

class AuthErr extends Error {
  constructor() {
    super("hunter path refused the scheduler token");
    this.name = "HunterAuthError";
  }
}

function fakeStore(over: Partial<HunterTickStore> & { runs?: string[]; busy?: boolean } = {}) {
  const calls: string[] = [];
  const finish = vi.fn(async (...a: unknown[]) => void calls.push(`finish:${JSON.stringify(a.slice(1))}`));
  const store: HunterTickStore = {
    beginTick: async () => ({ tickId: over.busy ? "" : "t1", busy: over.busy ?? false }),
    dueWork: vi.fn(async () => over.runs ?? []),
    pauseAgent: vi.fn(async () => undefined),
    finishTick: finish as unknown as HunterTickStore["finishTick"],
    research: () => ({}) as never,
    ...over,
  };
  return { store, finish, calls };
}

/** step script per run: array of outcomes (or Errors) consumed in order */
function scripted(plan: Record<string, (StepOutcome | Error)[]>) {
  const idx: Record<string, number> = {};
  const seen: string[] = [];
  const step = async (_r: unknown, runId: string, holder: string) => {
    expect(holder).toBe("t1");
    seen.push(runId);
    const o = plan[runId][idx[runId] = (idx[runId] ?? -1) + 1];
    if (o instanceof Error) throw o;
    return o;
  };
  return { step, seen };
}

describe("runHunterTick", () => {
  test("constants", () => {
    expect([HUNTER_TICK_BUDGET_MS, HUNTER_MAX_RUNS, HUNTER_MAX_STEPS]).toEqual([120_000, 3, 12]);
  });

  test("busy: another tick holds the lease and nothing runs", async () => {
    const { store, finish } = fakeStore({ busy: true });
    const r = await runHunterTick({ store, transport: null });
    expect(r.outcome).toBe("busy");
    expect(store.dueWork).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  test("steps each due run until it needs nothing, then the next; no new step after the budget; finishTick always", async () => {
    const mk = () => scripted({ a: [stepped(true), stepped(false)], b: [stepped(true), stepped(true), stepped(false)] });
    const s1 = mk();
    const f1 = fakeStore({ runs: ["a", "b"] });
    const r1 = await runHunterTick({ store: f1.store, transport: null, step: s1.step });
    expect(r1).toMatchObject({ outcome: "ok", steps: 5, runs: 2, paused: 0, failed: 0 });
    expect(s1.seen).toEqual(["a", "a", "b", "b", "b"]);
    expect(f1.finish).toHaveBeenCalledTimes(1);
    expect(f1.finish).toHaveBeenCalledWith("t1", { runs: 2, steps: 5, paused: 0, failed: 0 }, null);

    // budget spent after the first step (the step itself takes 130 s)
    let t = 0;
    const s2 = mk();
    const f2 = fakeStore({ runs: ["a", "b"] });
    const slow = async (r: unknown, runId: string, holder: string) => {
      const o = await s2.step(r, runId, holder);
      t += 130_000;
      return o;
    };
    const r2 = await runHunterTick({ store: f2.store, transport: null, step: slow, now: () => t });
    expect(r2.steps).toBe(1);
    expect(f2.finish).toHaveBeenCalledTimes(1);
  });

  test("at most 3 runs and 12 steps per tick", async () => {
    const many = Array.from({ length: 20 }, () => stepped(true));
    const s = scripted({ a: many, b: many, c: many, d: many });
    const f = fakeStore({ runs: ["a", "b", "c", "d"] });
    const r = await runHunterTick({ store: f.store, transport: null, step: s.step });
    expect(r.steps).toBe(12);
    expect(s.seen.every((x) => x === "a")).toBe(true);
    const s2 = scripted({ a: [stepped(false)], b: [stepped(false)], c: [stepped(false)], d: [stepped(false)] });
    const f2 = fakeStore({ runs: ["a", "b", "c", "d"] });
    expect((await runHunterTick({ store: f2.store, transport: null, step: s2.step })).runs).toBe(3);
  });

  test("C5 a cap or no-access error pauses the agent with that code and moves on", async () => {
    const s = scripted({
      a: [{ kind: "ai_error", code: "daily_cap", run: run("running") }],
      b: [stepped(false)],
    });
    const f = fakeStore({ runs: ["a", "b"] });
    const r = await runHunterTick({ store: f.store, transport: null, step: s.step });
    expect(f.store.pauseAgent).toHaveBeenCalledWith("t1", "a", "daily_cap");
    expect(s.seen).toEqual(["a", "b"]); // no retry of the capped run
    expect(r).toMatchObject({ paused: 1, steps: 1, outcome: "ok" });
    for (const code of ["user_cap", "global_cap", "no_access"] as const) {
      const f2 = fakeStore({ runs: ["a"] });
      await runHunterTick({ store: f2.store, transport: null, step: scripted({ a: [{ kind: "ai_error", code, run: run("running") }] }).step });
      expect(f2.store.pauseAgent).toHaveBeenCalledWith("t1", "a", code);
    }
  });

  test("other ai errors do not pause the agent; not_configured stops starting steps", async () => {
    const s = scripted({ a: [{ kind: "ai_error", code: "not_configured", run: run("running") }], b: [stepped(false)] });
    const f = fakeStore({ runs: ["a", "b"] });
    const r = await runHunterTick({ store: f.store, transport: null, step: s.step });
    expect(s.seen).toEqual(["a"]);
    expect(f.store.pauseAgent).not.toHaveBeenCalled();
    expect(r.paused).toBe(0);
    const s2 = scripted({ a: [{ kind: "ai_error", code: "refused", run: run("running") }], b: [stepped(false)] });
    const f2 = fakeStore({ runs: ["a", "b"] });
    await runHunterTick({ store: f2.store, transport: null, step: s2.step });
    expect(s2.seen).toEqual(["a", "b"]);
    expect(f2.store.pauseAgent).not.toHaveBeenCalled();
  });

  test("busy or idle outcome ends that run without counting a step", async () => {
    const s = scripted({ a: [{ kind: "busy" }], b: [{ kind: "not_found" }], c: [stepped(false)] });
    const r = await runHunterTick({ store: fakeStore({ runs: ["a", "b", "c"] }).store, transport: null, step: s.step });
    expect(r).toMatchObject({ steps: 1, runs: 3, failed: 0 });
  });

  test("an error in one run is counted, the first short code kept, and other runs still step", async () => {
    const s = scripted({ a: [new Error("rpc_failed")], b: [new Error("boom: secret@x.example")], c: [stepped(false)] });
    const f = fakeStore({ runs: ["a", "b", "c"] });
    const r = await runHunterTick({ store: f.store, transport: null, step: s.step });
    expect(r).toMatchObject({ outcome: "error", failed: 2, steps: 1 });
    expect(f.finish).toHaveBeenCalledWith("t1", expect.objectContaining({ failed: 2 }), "rpc_failed");
  });

  test("a scope refusal (HunterAuthError) inside a step aborts that run only, not the whole tick", async () => {
    const s = scripted({ a: [new AuthErr()], b: [stepped(false)] });
    const f = fakeStore({ runs: ["a", "b"] });
    const r = await runHunterTick({ store: f.store, transport: null, step: s.step });
    expect(s.seen).toEqual(["a", "b"]);
    expect(r).toMatchObject({ outcome: "error", failed: 1, steps: 1 });
    expect(f.finish).toHaveBeenCalledWith("t1", expect.anything(), "run_refused");
  });

  test("a token refusal at begin or due work propagates; due work failure still finishes the tick", async () => {
    const b = fakeStore();
    b.store.beginTick = async () => {
      throw new AuthErr();
    };
    await expect(runHunterTick({ store: b.store, transport: null })).rejects.toThrow(/refused/);
    expect(b.finish).not.toHaveBeenCalled();
    const d = fakeStore({ dueWork: vi.fn(async () => { throw new AuthErr(); }) });
    await expect(runHunterTick({ store: d.store, transport: null })).rejects.toThrow(/refused/);
    expect(d.finish).toHaveBeenCalledTimes(1);
  });
});
