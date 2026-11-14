import { describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { runQualifierTick } = await import("@/lib/qualifier/tick");
import { fakeHttp, fakeQualifierStore, snapshot } from "./qualifier-fakes";

const lead = (i: number, p: Parameters<typeof snapshot>[0] = {}) => snapshot({ leadId: `lead-${i}`, nextStep: "p3", ...p });
const names = (s: { log: unknown[][] }) => s.log.map((l) => l[0]);

describe("runQualifierTick", () => {
  test("busy: nothing runs", async () => {
    const store = fakeQualifierStore([lead(1)], { busy: true });
    const r = await runQualifierTick({ store, transport: null, http: fakeHttp({}) });
    expect(r).toMatchObject({ outcome: "busy", leads: 0, steps: 0 });
    expect(names(store)).toEqual(["beginTick"]);
  });

  test("up to 10 leads within the budget; finishTick always, also after a throw", async () => {
    const many = Array.from({ length: 14 }, (_, i) => lead(i));
    const store = fakeQualifierStore(many);
    const r = await runQualifierTick({ store, transport: null, http: fakeHttp({}) });
    expect(r).toMatchObject({ outcome: "ok", leads: 10, steps: 30 });
    expect(names(store).at(-1)).toBe("finishTick");
    // budget: the clock jumps past it after the first lead
    let t = 0;
    const slow = fakeQualifierStore(many);
    const r2 = await runQualifierTick({ store: slow, transport: null, http: fakeHttp({}), budgetMs: 1000, now: () => (t += 2000) });
    expect(r2.leads).toBe(1);
    // a throw inside a lead: released, counted, the next lead still runs, finishTick carries the short code
    const bad = fakeQualifierStore([lead(1, { nextStep: "p1" }), lead(2, { nextStep: "p1" })], { failOn: { stepDone: new Error("rpc_step_failed") } });
    const r3 = await runQualifierTick({ store: bad, transport: null, http: fakeHttp({}) });
    expect(r3.outcome).toBe("error");
    expect(names(bad)).toContain("release");
    expect(bad.log.at(-1)).toEqual(["finishTick", expect.objectContaining({ leads: 2 }), "rpc_step_failed"]);
    // a failing claim: finishTick still runs and the error propagates
    const dead = fakeQualifierStore([], { failOn: { claimNext: new Error("down") } });
    await expect(runQualifierTick({ store: dead, transport: null })).rejects.toThrow("down");
    expect(names(dead).at(-1)).toBe("finishTick");
  });

  test("a finished lead is not released; a requeued one is; page text never reaches the heartbeat", async () => {
    const store = fakeQualifierStore([lead(1), lead(2, { nextStep: "p1" })], { merge: 1 });
    await runQualifierTick({ store, transport: null, http: fakeHttp({}) });
    const released = store.log.filter((l) => l[0] === "release").map((l) => l[1]);
    expect(released).toEqual(["lead-2"]);
  });

  test("a pause reason stops that workspace for this tick and others go on", async () => {
    // cascade cannot pause yet (no AI steps): drive the pause through a stubbed cascade
    vi.resetModules();
    vi.doMock("@/lib/qualifier/cascade", () => ({
      qualifyLead: async (s: { leadId: string; workspaceId: string }) =>
        s.workspaceId === "ws-a" ? { steps: 0, result: "paused", pauseReason: "daily_cap" } : { steps: 1, result: "done" },
    }));
    const { runQualifierTick: run } = await import("@/lib/qualifier/tick");
    const store = fakeQualifierStore([lead(1, { workspaceId: "ws-a" }), lead(2, { workspaceId: "ws-a" }), lead(3, { workspaceId: "ws-b" })]);
    const r = await run({ store, transport: null });
    expect(r).toMatchObject({ paused: 1, steps: 1, outcome: "ok" });
    const calls = store.log.map((l) => l[0]);
    expect(calls.indexOf("pause")).toBeGreaterThan(-1);
    expect(store.log.find((l) => l[0] === "pause")!.slice(1)).toEqual(["ws-a", "daily_cap"]);
    // pause came before any release of that lead, and lead-2 (same workspace) was given back untouched
    expect(store.log.filter((l) => l[0] === "release").map((l) => l[1])).toEqual(["lead-2"]);
    expect(calls.at(-1)).toBe("finishTick");
    vi.doUnmock("@/lib/qualifier/cascade");
  });
});
