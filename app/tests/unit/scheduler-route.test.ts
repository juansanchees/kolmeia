import { beforeEach, describe, expect, test, vi } from "vitest";

// The clock's route (E1): it refuses anything that is not a well-formed bearer token BEFORE it creates a database
// client, and never echoes internals.

const createSchedulerStore = vi.fn();
const runTick = vi.fn();
vi.mock("@/lib/email/scheduler-store", () => ({ createSchedulerStore: (...a: unknown[]) => createSchedulerStore(...a) }));
class FakeNoSend {}
class FakeGmail {
  constructor(readonly timeouts: unknown) {}
}
const CLOCK = { connectionTimeout: 1, greetingTimeout: 1, socketTimeout: 1 };
vi.mock("@/lib/email/scheduler", () => ({ runTick: (...a: unknown[]) => runTick(...a), NoSendSmtp: FakeNoSend, TICK_BUDGET_MS: 40_000, TICK_REAL_BUDGET_MS: 30_000 }));
vi.mock("@/lib/email/transport", () => ({ GmailSmtp: FakeGmail, CLOCK_SMTP_TIMEOUTS: CLOCK }));
// E5 (0026): the clock's IMAP comes only from clockImap(), behind the same switch
class FakeImap {}
const clockImap = vi.fn(() => new FakeImap());
vi.mock("@/lib/email/clock-replies", () => ({ clockImap: () => clockImap() }));
// the server switch (0025, D4) and the mailbox key, stubbed: the variables themselves are never set in tests
const sw = { on: false, key: true };
vi.mock("@/lib/email/config", () => ({ realClockEnabled: () => sw.on, hasMailboxKey: () => sw.key, configuredPublicOrigin: () => "https://app.example.com" }));

const { POST } = await import("@/app/api/scheduler/tick/route");
const TOKEN = "ab".repeat(32);
const call = (headers: Record<string, string> = {}) => POST(new Request("https://app.example.com/api/scheduler/tick", { method: "POST", headers }));

beforeEach(() => {
  sw.on = false;
  sw.key = true;
  createSchedulerStore.mockReset();
  runTick.mockReset();
  clockImap.mockClear();
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
    expect(runTick.mock.calls[0][0].imap).toBeNull(); // E5: no IMAP with the switch off
    expect(clockImap).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ outcome: "ok", campaigns: 2, sent: 1, failed: 0 });
  });

  test("the switch on: a real store and the Gmail transport, from one read of the switch", async () => {
    sw.on = true;
    createSchedulerStore.mockReturnValue({});
    runTick.mockResolvedValue({ runId: "run-1", outcome: "ok", campaigns: 1, sent: 1, failed: 0 });
    expect((await call({ authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    expect(createSchedulerStore).toHaveBeenCalledWith(TOKEN, true);
    expect(runTick.mock.calls[0][0].smtp).toBeInstanceOf(FakeGmail);
    expect(runTick.mock.calls[0][0].smtp.timeouts).toBe(CLOCK); // short SMTP timeouts on the clock
    expect(runTick.mock.calls[0][0].budgetMs).toBe(30_000);
    expect(runTick.mock.calls[0][0].imap).toBeInstanceOf(FakeImap); // E5: replies read behind the same switch
    expect(clockImap).toHaveBeenCalledTimes(1);
  });

  test("the switch on but no mailbox key: treated as off (rehearsal store, no Gmail transport)", async () => {
    sw.on = true;
    sw.key = false;
    createSchedulerStore.mockReturnValue({});
    runTick.mockResolvedValue({ runId: "run-1", outcome: "ok", campaigns: 0, sent: 0, failed: 0 });
    expect((await call({ authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    expect(createSchedulerStore).toHaveBeenCalledWith(TOKEN, false);
    expect(runTick.mock.calls[0][0].smtp).toBeInstanceOf(FakeNoSend);
    expect(runTick.mock.calls[0][0].budgetMs).toBe(40_000);
    expect(runTick.mock.calls[0][0].imap).toBeNull(); // E5: no key, no IMAP
    expect(clockImap).not.toHaveBeenCalled();
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
