import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
const createHunterTickStore = vi.fn();
const runHunterTick = vi.fn();
const hasAi = vi.fn();
vi.mock("@/lib/hunter/tick-store", () => ({ createHunterTickStore: (...a: unknown[]) => createHunterTickStore(...a) }));
vi.mock("@/lib/hunter/tick", () => ({ runHunterTick: (...a: unknown[]) => runHunterTick(...a) }));
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
});

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

  test("no AI key: 200 {outcome:'no_ai'} and no store is created", async () => {
    hasAi.mockReturnValue(false);
    const res = await call(ok);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "no_ai" });
    expect(createHunterTickStore).not.toHaveBeenCalled();
  });

  test("a well-formed token creates a store with that token and returns only the counts", async () => {
    createHunterTickStore.mockReturnValue({});
    runHunterTick.mockResolvedValue({ tickId: "t", outcome: "ok", runs: 2, steps: 5, paused: 1, failed: 0 });
    const res = await call(ok);
    expect(createHunterTickStore).toHaveBeenCalledWith(TOKEN);
    expect(await res.json()).toEqual({ outcome: "ok", runs: 2, steps: 5, paused: 1, failed: 0 });
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
    expect(JSON.parse(text)).toEqual({ outcome: "error" });
    expect(text).not.toContain(TOKEN);
    createHunterTickStore.mockReturnValue(null);
    expect((await call(ok)).status).toBe(500);
    expect(runHunterTick).toHaveBeenCalledTimes(2);
  });
});
