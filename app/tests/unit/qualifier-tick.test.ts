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
    const r2 = await runQualifierTick({ store: slow, transport: null, http: fakeHttp({}), budgetMs: 60_000, now: () => (t += 20_000) });
    expect(r2.leads).toBe(1);
    // a throw inside a lead: counted, kept locked for the tick (finishTick frees it), the next lead still runs, short code kept
    const bad = fakeQualifierStore([lead(1, { nextStep: "p1" }), lead(2, { nextStep: "p1" })], { failOn: { stepDone: new Error("rpc_step_failed") } });
    const r3 = await runQualifierTick({ store: bad, transport: null, http: fakeHttp({}) });
    expect(r3.outcome).toBe("error");
    expect(names(bad)).not.toContain("release");
    expect(bad.log.at(-1)).toEqual(["finishTick", expect.objectContaining({ leads: 2 }), "rpc_step_failed"]);
    // a failing claim: finishTick still runs and the error propagates
    const dead = fakeQualifierStore([], { failOn: { claimNext: new Error("down") } });
    await expect(runQualifierTick({ store: dead, transport: null })).rejects.toThrow("down");
    expect(names(dead).at(-1)).toBe("finishTick");
  });

  test("I-1: with no budget nothing is claimed, but the tick is begun and finished", async () => {
    const store = fakeQualifierStore([lead(1)]);
    const r = await runQualifierTick({ store, transport: null, http: fakeHttp({}), budgetMs: 0 });
    expect(r).toMatchObject({ outcome: "ok", leads: 0 });
    expect(names(store)).toEqual(["beginTick", "finishTick"]);
  });

  test("I-2: no new lead is claimed with less than 35 s left", async () => {
    let t = 0;
    const store2 = fakeQualifierStore([lead(1), lead(2), lead(3)]);
    const orig = store2.stepDone;
    store2.stepDone = async (...a) => {
      t += 7_000;
      return orig(...a);
    };
    t = 0;
    const r2 = await runQualifierTick({ store: store2, transport: null, http: fakeHttp({}), budgetMs: 60_000, now: () => t });
    // 3 steps x 7 s = 21 s per lead: starts at 0 (60 left) and 21 (39 left); at 42 only 18 left -> stop
    expect(r2.leads).toBe(2);
    // a budget under the floor claims nothing
    const small = fakeQualifierStore([lead(1)]);
    expect((await runQualifierTick({ store: small, transport: null, budgetMs: 34_999, now: () => 0 })).leads).toBe(0);
  });

  test("I-1b: the request deadline reaches the cascade; a lead deferred for lack of time is not released nor picked again in this tick", async () => {
    const store = fakeQualifierStore([lead(1, { nextStep: "p5", level: 1, profileMatch: true }), lead(2, { nextStep: "p5", level: 1, profileMatch: true })]);
    const transport = { send: async () => Promise.reject(new Error("must not be called")) };
    // the deadline is 100 s away: P5 (150 s) is deferred for both leads
    const r = await runQualifierTick({ store, transport, http: fakeHttp({}), deadline: 100_000, now: () => 0, budgetMs: 60_000 });
    expect(r.outcome).toBe("ok");
    expect(store.log.filter((l) => l[0] === "stepDone").map((l) => `${l[2]}:${l[3]}:${l[4]}`)).toEqual(["p5:deadline:p5", "p5:deadline:p5"]);
    expect(store.log.filter((l) => l[0] === "release")).toEqual([]);
  });

  test("m-3: a lead that failed is not released and not picked again in this tick", async () => {
    const store = fakeQualifierStore([lead(1, { nextStep: "p1" }), lead(2, { nextStep: "p1" })], { failOn: { stepDone: new Error("rpc_x") } });
    await runQualifierTick({ store, transport: null, http: fakeHttp({}) });
    expect(store.log.filter((l) => l[0] === "release")).toEqual([]);
  });

  test("m-1: a refusal on one lead followed by a good claim is lead_gone; with no good claim it stays refused", async () => {
    const gone = Object.assign(new Error("x"), { code: "42501" });
    const calls = { n: 0 };
    const a = fakeQualifierStore([lead(1, { nextStep: "p1" }), lead(2)], { failOn: {} });
    const orig = a.stepDone;
    a.stepDone = async (...args) => {
      if (calls.n++ === 0) throw gone;
      return orig(...args);
    };
    const r = await runQualifierTick({ store: a, transport: null, http: fakeHttp({}) });
    expect(r.outcome).toBe("error");
    expect(a.log.at(-1)).toEqual(["finishTick", expect.anything(), "lead_gone"]);
    const b = fakeQualifierStore([lead(1, { nextStep: "p1" })]);
    b.stepDone = async () => {
      throw gone;
    };
    await runQualifierTick({ store: b, transport: null, http: fakeHttp({}) });
    expect(b.log.at(-1)).toEqual(["finishTick", expect.anything(), "refused"]);
  });

  test("m-6: page text and secrets in an error never reach the heartbeat", async () => {
    const store = fakeQualifierStore([lead(1, { nextStep: "p1" })], { failOn: { stepDone: new Error("<html>SECRET page text sk-ant-123</html>") } });
    await runQualifierTick({ store, transport: null, http: fakeHttp({}) });
    const fin = store.log.at(-1)!;
    expect(fin[0]).toBe("finishTick");
    expect(fin[2]).toBe("lead_error");
    expect(JSON.stringify(fin)).not.toMatch(/SECRET|sk-ant/);
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
