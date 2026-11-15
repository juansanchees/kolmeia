import { beforeEach, describe, expect, test, vi } from "vitest";

// The clock's route (E1): it refuses anything that is not a well-formed bearer token BEFORE it creates a database
// client, and never echoes internals.

const createSchedulerStore = vi.fn();
const runTick = vi.fn();
vi.mock("@/lib/email/scheduler-store", () => ({ createSchedulerStore: (...a: unknown[]) => createSchedulerStore(...a) }));
class FakeNoSend {}
class FakeGmail {}
vi.mock("@/lib/email/scheduler", () => ({ runTick: (...a: unknown[]) => runTick(...a), NoSendSmtp: FakeNoSend }));
vi.mock("@/lib/email/transport", () => ({ GmailSmtp: FakeGmail }));
// the server switch (0025, D4), stubbed: the variable itself is never set in tests
const sw = { on: false };
vi.mock("@/lib/email/config", () => ({ realClockEnabled: () => sw.on, configuredPublicOrigin: () => "https://app.example.com" }));

const { POST } = await import("@/app/api/scheduler/tick/route");
const TOKEN = "ab".repeat(32);
const call = (headers: Record<string, string> = {}) => POST(new Request("https://app.example.com/api/scheduler/tick", { method: "POST", headers }));

beforeEach(() => {
  sw.on = false;
  createSchedulerStore.mockReset();
  runTick.mockReset();
});

describe("POST /api/scheduler/tick", () => {
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
  ])("401 for %s, and no store is created", async (_name, headers) => {
    const res = await call(headers as Record<string, string>);
    expect(res.status).toBe(401);
    expect(createSchedulerStore).not.toHaveBeenCalled();
    expect(runTick).not.toHaveBeenCalled();
  });

  test("a well-formed token creates a store with that token and returns only the counts", async () => {
    createSchedulerStore.mockReturnValue({});
    runTick.mockResolvedValue({ runId: "run-1", outcome: "ok", campaigns: 2, sent: 1, failed: 0 });
    const res = await call({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(createSchedulerStore).toHaveBeenCalledWith(TOKEN, false);
    expect(runTick.mock.calls[0][0].smtp).toBeInstanceOf(FakeNoSend);
    expect(await res.json()).toEqual({ outcome: "ok", campaigns: 2, sent: 1, failed: 0 });
  });

  test("the switch on: a real store and the Gmail transport, from one read of the switch", async () => {
    sw.on = true;
    createSchedulerStore.mockReturnValue({});
    runTick.mockResolvedValue({ runId: "run-1", outcome: "ok", campaigns: 1, sent: 1, failed: 0 });
    expect((await call({ authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    expect(createSchedulerStore).toHaveBeenCalledWith(TOKEN, true);
    expect(runTick.mock.calls[0][0].smtp).toBeInstanceOf(FakeGmail);
  });

  test("the database refusing the token is a 401", async () => {
    createSchedulerStore.mockReturnValue({});
    runTick.mockRejectedValue(Object.assign(new Error("scheduler_unauthorized"), { name: "SchedulerAuthError" }));
    expect((await call({ authorization: `Bearer ${TOKEN}` })).status).toBe(401);
  });

  test("a fatal error is a 500 whose body never echoes internals", async () => {
    createSchedulerStore.mockReturnValue({});
    runTick.mockRejectedValue(new Error(`connect failed for juan@x.example with token ${TOKEN} body "Hello Pat"`));
    const res = await call({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ outcome: "error" });
    expect(text).not.toMatch(/juan|token|Hello|connect/i);
    expect(text).not.toContain(TOKEN);
  });

  test("a missing database configuration is a 500 with the same bare body", async () => {
    createSchedulerStore.mockReturnValue(null);
    const res = await call({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ outcome: "error" });
    expect(runTick).not.toHaveBeenCalled();
  });
});
