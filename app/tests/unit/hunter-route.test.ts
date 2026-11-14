import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
const createHunterTickStore = vi.fn();
const runHunterTick = vi.fn();
const hasAi = vi.fn();
vi.mock("@/lib/hunter/tick-store", () => ({ createHunterTickStore: (...a: unknown[]) => createHunterTickStore(...a) }));
vi.mock("@/lib/hunter/tick", () => ({ runHunterTick: (...a: unknown[]) => runHunterTick(...a) }));
const createSourceTickStore = vi.fn();
const runSourceTick = vi.fn();
vi.mock("@/lib/sources/store", () => ({ createSourceTickStore: (...a: unknown[]) => createSourceTickStore(...a) }));
vi.mock("@/lib/sources/tick", () => ({ SOURCE_TICK_BUDGET_MS: 30_000, runSourceTick: (...a: unknown[]) => runSourceTick(...a) }));
const createQualifierTickStore = vi.fn();
const runQualifierTick = vi.fn();
vi.mock("@/lib/qualifier/store", () => ({ createQualifierTickStore: (...a: unknown[]) => createQualifierTickStore(...a) }));
vi.mock("@/lib/qualifier/tick", () => ({ QUALIFIER_TICK_BUDGET_MS: 60_000, runQualifierTick: (...a: unknown[]) => runQualifierTick(...a) }));
vi.mock("@/lib/ai/config", () => ({ hasAi: () => hasAi() }));
vi.mock("@/lib/ai/gateway", () => ({ defaultTransport: () => ({ fake: true }) }));

const { POST, maxDuration } = await import("@/app/api/hunter/tick/route");
const TOKEN = "ab".repeat(32);
const call = (headers: Record<string, string> = {}) => POST(new Request("https://app.example.com/api/hunter/tick", { method: "POST", headers }));
const ok = { authorization: `Bearer ${TOKEN}` };

beforeEach(() => {
  createHunterTickStore.mockReset();
  runHunterTick.mockReset();
  hasAi.mockReset().mockReturnValue(true);
  createQualifierTickStore.mockReset().mockReturnValue({});
  runQualifierTick.mockReset().mockResolvedValue({ tickId: "q", outcome: "ok", leads: 0, steps: 0, paused: 0, failed: 0 });
  createSourceTickStore.mockReset().mockReturnValue({});
  runSourceTick.mockReset().mockResolvedValue({ outcome: "ok", started: 0, polled: 0, imported: 0, failed: 0 });
});
const NO_SOURCES = { outcome: "ok", started: 0, polled: 0, imported: 0, failed: 0 };
const NO_QUALIFIER = { outcome: "ok", leads: 0, steps: 0, paused: 0, failed: 0 };

describe("POST /api/hunter/tick", () => {
  test.each([
    ["no Authorization header", {}],
    ["an empty header", { authorization: "" }],
    ["no Bearer scheme", { authorization: TOKEN }],
    ["Basic scheme", { authorization: `Basic ${TOKEN}` }],
    ["lowercase scheme", { authorization: `bearer ${TOKEN}` }],
    ["a token that is too short", { authorization: `Bearer ${"ab".repeat(31)}` }],
    ["a token that is too long", { authorization: `Bearer ${"ab".repeat(33)}` }],
    ["upper-case hex", { authorization: `Bearer ${TOKEN.toUpperCase()}` }],
    ["non-hex characters", { authorization: `Bearer ${"zz".repeat(32)}` }],
    ["trailing text", { authorization: `Bearer ${TOKEN} extra` }],
  ])("401 for %s, and no store is created", async (_n, headers) => {
    const res = await call(headers as Record<string, string>);
    expect(res.status).toBe(401);
    expect(createHunterTickStore).not.toHaveBeenCalled();
    expect(runHunterTick).not.toHaveBeenCalled();
  });

  test("without an AI key the Caçador says no_ai and the Qualificador still runs its free steps", async () => {
    hasAi.mockReturnValue(false);
    const res = await call(ok);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "no_ai", qualifier: NO_QUALIFIER, sources: NO_SOURCES });
    expect(createHunterTickStore).not.toHaveBeenCalled();
    expect(createQualifierTickStore).toHaveBeenCalledWith(TOKEN);
    expect(runQualifierTick.mock.calls[0][0].transport).toBeNull();
    expect(createSourceTickStore).toHaveBeenCalledWith(TOKEN);
  });

  test("the Qualificador runs between the Caçador and the sources, with its own result; its failure does not hide the others", async () => {
    createHunterTickStore.mockReturnValue({});
    const order: string[] = [];
    runHunterTick.mockImplementation(async () => (order.push("hunter"), { tickId: "t", outcome: "ok", runs: 1, steps: 1, paused: 0, failed: 0 }));
    runQualifierTick.mockImplementation(async () => (order.push("qualifier"), { tickId: "q", outcome: "ok", leads: 3, steps: 9, paused: 1, failed: 0 }));
    runSourceTick.mockImplementation(async () => (order.push("sources"), { outcome: "ok", started: 0, polled: 0, imported: 0, failed: 0 }));
    const body = await (await call(ok)).json();
    expect(order).toEqual(["hunter", "qualifier", "sources"]);
    expect(body.qualifier).toEqual({ outcome: "ok", leads: 3, steps: 9, paused: 1, failed: 0 });
    expect(runQualifierTick.mock.calls[0][0].transport).toEqual({ fake: true });
    // I-1b: the request's own deadline (start + REQUEST_BUDGET_MS) goes to the Qualificador tick
    const deadline = runQualifierTick.mock.calls[0][0].deadline as number;
    expect(deadline).toBeGreaterThan(Date.now() + 230_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 240_000);
    runQualifierTick.mockRejectedValue(new Error(`boom ${TOKEN}`));
    const text = await (await call(ok)).text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text).qualifier).toEqual({ outcome: "error", leads: 0, steps: 0, paused: 0, failed: 0 });
    expect(JSON.parse(text).sources.outcome).toBe("ok");
    runQualifierTick.mockRejectedValue(Object.assign(new Error("x"), { name: "HunterAuthError" }));
    expect((await call(ok)).status).toBe(401);
  });

  test("the route runs the sources tick and reports it", async () => {
    createHunterTickStore.mockReturnValue({});
    runHunterTick.mockResolvedValue({ tickId: "t", outcome: "ok", runs: 0, steps: 0, paused: 0, failed: 0 });
    runSourceTick.mockResolvedValue({ outcome: "ok", started: 1, polled: 2, imported: 3, failed: 4 });
    const res = await call(ok);
    expect(createSourceTickStore).toHaveBeenCalledWith(TOKEN);
    expect(await res.json()).toEqual({ outcome: "ok", runs: 0, steps: 0, paused: 0, failed: 0, qualifier: NO_QUALIFIER, sources: { outcome: "ok", started: 1, polled: 2, imported: 3, failed: 4 } });
  });

  test("a sources failure is a bare error object and does not hide the hunter result; a refused token is 401", async () => {
    createHunterTickStore.mockReturnValue({});
    runHunterTick.mockResolvedValue({ tickId: "t", outcome: "ok", runs: 1, steps: 1, paused: 0, failed: 0 });
    runSourceTick.mockRejectedValue(new Error(`boom ${TOKEN}`));
    const res = await call(ok);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text).sources).toEqual({ outcome: "error", started: 0, polled: 0, imported: 0, failed: 0 });
    expect(JSON.parse(text).outcome).toBe("ok");
    runSourceTick.mockRejectedValue(Object.assign(new Error("x"), { name: "HunterAuthError" }));
    expect((await call(ok)).status).toBe(401);
  });

  test("a well-formed token creates a store with that token and returns only the counts", async () => {
    createHunterTickStore.mockReturnValue({});
    runHunterTick.mockResolvedValue({ tickId: "t", outcome: "ok", runs: 2, steps: 5, paused: 1, failed: 0 });
    const res = await call(ok);
    expect(createHunterTickStore).toHaveBeenCalledWith(TOKEN);
    expect(await res.json()).toEqual({ outcome: "ok", runs: 2, steps: 5, paused: 1, failed: 0, qualifier: NO_QUALIFIER, sources: NO_SOURCES });
  });

  test("a fast hunter leaves the sources their default budget; a slow one shrinks it; an exhausted one gives 0", async () => {
    createHunterTickStore.mockReturnValue({});
    const spy = vi.spyOn(Date, "now");
    try {
      let t = 1_000_000;
      spy.mockImplementation(() => t);
      runHunterTick.mockImplementation(async () => {
        t += 10_000;
        return { tickId: "t", outcome: "ok", runs: 0, steps: 0, paused: 0, failed: 0 };
      });
      await call(ok);
      expect(runSourceTick.mock.calls.at(-1)?.[0].budgetMs).toBe(30_000);
      expect(runQualifierTick.mock.calls.at(-1)?.[0].budgetMs).toBe(60_000);
      // the sources budget is computed after the qualifier finished
      runQualifierTick.mockImplementation(async () => {
        t += 200_000;
        return { tickId: "q", outcome: "ok", leads: 0, steps: 0, paused: 0, failed: 0 };
      });
      await call(ok);
      expect(runQualifierTick.mock.calls.at(-1)?.[0].budgetMs).toBe(60_000);
      expect(runSourceTick.mock.calls.at(-1)?.[0].budgetMs).toBe(30_000);
      runQualifierTick.mockImplementation(async () => {
        t += 215_000;
        return { tickId: "q", outcome: "ok", leads: 0, steps: 0, paused: 0, failed: 0 };
      });
      await call(ok);
      expect(runSourceTick.mock.calls.at(-1)?.[0].budgetMs).toBe(15_000);
      runQualifierTick.mockResolvedValue({ tickId: "q", outcome: "ok", leads: 0, steps: 0, paused: 0, failed: 0 });
      runHunterTick.mockImplementation(async () => {
        t += 225_000;
        return { tickId: "t", outcome: "ok", runs: 0, steps: 0, paused: 0, failed: 0 };
      });
      await call(ok);
      expect(runSourceTick.mock.calls.at(-1)?.[0].budgetMs).toBe(15_000);
      expect(runQualifierTick.mock.calls.at(-1)?.[0].budgetMs).toBe(15_000);
      runHunterTick.mockImplementation(async () => {
        t += 290_000;
        return { tickId: "t", outcome: "ok", runs: 0, steps: 0, paused: 0, failed: 0 };
      });
      const res = await call(ok);
      expect(res.status).toBe(200);
      expect(runSourceTick.mock.calls.at(-1)?.[0].budgetMs).toBe(0);
      expect(runQualifierTick.mock.calls.at(-1)?.[0].budgetMs).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("maxDuration is 300, HunterAuthError is 401, other errors are a bare 500", async () => {
    expect(maxDuration).toBe(300);
    createHunterTickStore.mockReturnValue({});
    runHunterTick.mockRejectedValue(Object.assign(new Error("x"), { name: "HunterAuthError" }));
    expect((await call(ok)).status).toBe(401);
    runHunterTick.mockRejectedValue(new Error(`connect failed juan@x.example token ${TOKEN}`));
    const res = await call(ok);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ outcome: "error", qualifier: NO_QUALIFIER, sources: NO_SOURCES });
    expect(text).not.toContain(TOKEN);
    createHunterTickStore.mockReturnValue(null);
    expect((await call(ok)).status).toBe(500);
    expect(runHunterTick).toHaveBeenCalledTimes(2);
  });
});
