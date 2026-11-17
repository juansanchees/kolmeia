import { describe, expect, test } from "vitest";
import { nyLocalToIso } from "@/lib/calls/call-input";
import { suppressedOf } from "@/lib/home/queries";
import { blocksFor, buildPlan, DEFAULT_PLAN, moveBlock, parsePlan, planSchema, type DayPlan, type PlanCalls, type PlanInput, type PlanTask } from "@/lib/home/plan";
import { DEFAULT_HOME_RULE, type HomeRow } from "@/lib/home/rule";
import type { Segment } from "@/lib/leads/types";

// "Plano de hoje": fictional leads only. NOW = Tue 17 Nov 2026, 10:00 in New York (EST, UTC-5).
const NOW = "2026-11-17T15:00:00.000Z";
const ME = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

let seq = 0;
function row(o: { id?: string; status?: string; contacted?: string | null; dnc?: boolean; phone?: string | null; email?: string | null; owner?: string; segment?: Segment | null; seen?: string; touch?: string | null; contact?: string } = {}): HomeRow {
  const id = o.id ?? `lead-${++seq}`;
  return {
    lead: { id, status: (o.status ?? "new") as never, level: 1, origin_kind: "import", origin_agent_id: null, first_contacted_at: o.contacted ?? null, last_touch_at: o.touch ?? null, segment: null, first_seen_at: o.seen ?? "2026-11-01T12:00:00Z", do_not_call: o.dnc ?? false, owner_id: o.owner ?? null },
    best: null,
    display: { name: `Co ${id}`, city: "Boston", phone: o.phone === undefined ? "(508) 555-0101" : o.phone, website: null, email: o.email ?? null, contactName: o.contact ?? null },
    origins: [],
    agentName: null,
    importName: null,
    segment: o.segment === undefined ? "large" : o.segment,
  };
}
const task = (o: Partial<PlanTask> & { lead_id: string; due_at: string }): PlanTask => ({ id: `t-${++seq}`, kind: "call", title: "", done_at: null, assignee_id: ME, ...o });
const calls = (o: Partial<PlanCalls>): PlanCalls => ({ noAnswer: 0, last: null, byMeToday: false, ...o });
const input = (o: Partial<PlanInput>): PlanInput => ({ now: NOW, userId: ME, sender: true, rows: [], tasks: [], calls: {}, emailedToday: [], suppressed: [], marks: [], ...o });
const block = (p: ReturnType<typeof buildPlan>, id: string) => p.blocks.find((b) => b.id === id)!;
const keys = (p: ReturnType<typeof buildPlan>, id: string) => block(p, id).items.map((i) => i.key);

describe("plan setup: parse, defaults, fallback", () => {
  test("nothing stored gives the default; the default is valid", () => {
    expect(parsePlan(undefined)).toEqual(DEFAULT_PLAN);
    expect(parsePlan({})).toEqual(DEFAULT_PLAN);
    expect(planSchema.safeParse(DEFAULT_PLAN).success).toBe(true);
    expect(DEFAULT_PLAN.order).toEqual(["returns", "call", "email", "review"]);
    expect(DEFAULT_PLAN.counts).toEqual({ returns: 5, call: 5, email: 5, review: 3 });
    expect(DEFAULT_PLAN.returns).toEqual({ late: true, today: true, tomorrow: false, team: false });
  });
  test("each part falls back alone: a broken order keeps the good counts; missing keys take the default", () => {
    const p = parsePlan({ order: ["call", "call", "email", "review"], counts: { call: 9 }, hidden: ["email", "nope"], returns: { tomorrow: true } });
    expect(p.order).toEqual(DEFAULT_PLAN.order);
    expect(p.counts).toEqual({ ...DEFAULT_PLAN.counts, call: 9 });
    expect(p.hidden).toEqual([]);
    expect(p.returns).toEqual({ ...DEFAULT_PLAN.returns, tomorrow: true });
    expect(parsePlan({ counts: { call: 99 } }).counts).toEqual(DEFAULT_PLAN.counts);
    expect(parsePlan("garbage")).toEqual(DEFAULT_PLAN);
    expect(parsePlan([1, 2])).toEqual(DEFAULT_PLAN);
  });
  test("write side is strict: the schema refuses duplicates and out-of-range counts", () => {
    expect(planSchema.safeParse({ ...DEFAULT_PLAN, order: ["call", "call", "email", "review"] }).success).toBe(false);
    expect(planSchema.safeParse({ ...DEFAULT_PLAN, counts: { ...DEFAULT_PLAN.counts, review: 0 } }).success).toBe(false);
    expect(planSchema.safeParse({ ...DEFAULT_PLAN, email: { ...DEFAULT_PLAN.email, noAnswerN: 1 } }).success).toBe(false);
  });
  test("moving a block swaps it with its neighbour; the ends do not move", () => {
    expect(moveBlock(DEFAULT_PLAN.order, "email", -1)).toEqual(["returns", "email", "call", "review"]);
    expect(moveBlock(DEFAULT_PLAN.order, "returns", -1)).toEqual(DEFAULT_PLAN.order);
    expect(moveBlock(DEFAULT_PLAN.order, "review", 1)).toEqual(DEFAULT_PLAN.order);
  });
});

describe("Retornos combinados", () => {
  const a = row({ id: "a", contacted: "2026-11-10T12:00:00Z" });
  test("late and today by the New York day, mine only, soonest first; tomorrow only when asked", () => {
    const late = task({ lead_id: "a", due_at: "2026-11-16T04:30:00Z" }); // 23:30 on the 15th in NY: 2 days late
    const today = task({ lead_id: "a", due_at: "2026-11-17T19:00:00Z" }); // 14:00 NY
    const lateNight = task({ lead_id: "a", due_at: "2026-11-18T04:59:00Z" }); // 23:59 on the 17th in NY: still today
    const tomorrow = task({ lead_id: "a", due_at: "2026-11-18T05:00:00Z" }); // 00:00 on the 18th
    const theirs = task({ lead_id: "a", due_at: "2026-11-17T16:00:00Z", assignee_id: OTHER });
    const meeting = task({ lead_id: "a", due_at: "2026-11-17T16:00:00Z", kind: "meeting" });
    const p = buildPlan(input({ rows: [a], tasks: [today, tomorrow, theirs, late, lateNight, meeting] }), DEFAULT_PLAN, DEFAULT_HOME_RULE);
    expect(keys(p, "returns")).toEqual([`task:${late.id}`, `task:${today.id}`, `task:${lateNight.id}`]);
    expect(block(p, "returns").items[0].reason).toEqual({ t: "late", days: 2 });
    expect(block(p, "returns").items[1].reason).toEqual({ t: "today", at: "14:00" });
    const plus = buildPlan(input({ rows: [a], tasks: [today, tomorrow, theirs] }), { ...DEFAULT_PLAN, returns: { late: false, today: false, tomorrow: true, team: true } }, DEFAULT_HOME_RULE);
    expect(keys(plus, "returns")).toEqual([`task:${tomorrow.id}`]);
  });
  test("the whole team only for senders; a closer always sees her own", () => {
    const theirs = task({ lead_id: "a", due_at: "2026-11-17T16:00:00Z", assignee_id: OTHER });
    const team = { ...DEFAULT_PLAN, returns: { ...DEFAULT_PLAN.returns, team: true } };
    expect(keys(buildPlan(input({ rows: [a], tasks: [theirs] }), team, DEFAULT_HOME_RULE), "returns")).toHaveLength(1);
    expect(keys(buildPlan(input({ rows: [a], tasks: [theirs], sender: false }), team, DEFAULT_HOME_RULE), "returns")).toHaveLength(0);
  });
  test("a closer also sees every open task on the leads she owns, whoever it is assigned to", () => {
    const mine = row({ id: "own", owner: ME });
    const other = row({ id: "oth", owner: OTHER });
    const onMine = task({ lead_id: "own", due_at: "2026-11-17T16:00:00Z", assignee_id: OTHER });
    const onOther = task({ lead_id: "oth", due_at: "2026-11-17T16:00:00Z", assignee_id: OTHER });
    const assignedToMe = task({ lead_id: "oth", due_at: "2026-11-17T17:00:00Z" });
    const ids = (sender: boolean) => keys(buildPlan(input({ rows: [mine, other], tasks: [onMine, onOther, assignedToMe], sender }), DEFAULT_PLAN, DEFAULT_HOME_RULE), "returns");
    expect(ids(false)).toEqual([`task:${onMine.id}`, `task:${assignedToMe.id}`]);
    expect(ids(true)).toEqual([`task:${assignedToMe.id}`]); // sender: "mine" stays assigned-to-me
  });
  test("done only when the task is done today or ticked by hand; a call on the lead does not tick it (the task stays open)", () => {
    const done = task({ lead_id: "a", due_at: "2026-11-17T16:00:00Z", done_at: "2026-11-17T14:30:00Z" });
    const open = task({ lead_id: "a", due_at: "2026-11-17T17:00:00Z" });
    const p1 = buildPlan(input({ rows: [a], tasks: [done, open], calls: { a: calls({ byMeToday: true }) } }), DEFAULT_PLAN, DEFAULT_HOME_RULE);
    expect(block(p1, "returns").items.map((i) => [i.done, i.real])).toEqual([[true, true], [false, false]]);
    const p2 = buildPlan(input({ rows: [a], tasks: [open], marks: [`task:${open.id}`] }), DEFAULT_PLAN, DEFAULT_HOME_RULE);
    expect(block(p2, "returns").items.map((i) => [i.done, i.real])).toEqual([[true, false]]);
  });
  test("a lead shows once: a task on a lead already in an earlier block stays out of Retornos", () => {
    const fresh = row({ id: "f" });
    const p = buildPlan(input({ rows: [fresh], tasks: [task({ lead_id: "f", due_at: "2026-11-17T16:00:00Z" })] }), { ...DEFAULT_PLAN, order: ["call", "returns", "email", "review"] }, DEFAULT_HOME_RULE);
    expect(keys(p, "call")).toEqual(["call:f"]);
    expect(keys(p, "returns")).toEqual([]);
  });
  test("a task on a lead the user cannot see, or on a closed one, is left out", () => {
    const p = buildPlan(input({ rows: [row({ id: "won", status: "won", contacted: "2026-11-01T00:00:00Z" })], tasks: [task({ lead_id: "zz", due_at: "2026-11-17T16:00:00Z" }), task({ lead_id: "won", due_at: "2026-11-17T16:00:00Z" })] }), DEFAULT_PLAN, DEFAULT_HOME_RULE);
    expect(block(p, "returns").items).toEqual([]);
  });
});

describe("Ligar agora", () => {
  test("the user's rule, capped at the count; called today for the first time stays on the plan as done (refill)", () => {
    const rows = Array.from({ length: 7 }, (_, i) => row({ id: `n${i}` }));
    const called = row({ id: "c", status: "call_list", contacted: "2026-11-17T14:00:00Z" });
    const calledBefore = row({ id: "old", status: "call_list", contacted: "2026-11-10T14:00:00Z" });
    const p = buildPlan(input({ rows: [called, calledBefore, ...rows], calls: { c: calls({ byMeToday: true }), old: calls({ byMeToday: true }) } }), DEFAULT_PLAN, DEFAULT_HOME_RULE);
    const b = block(p, "call");
    expect(b.items.map((i) => i.key)).toEqual(["call:c", "call:n0", "call:n1", "call:n2", "call:n3"]);
    expect(b.items[0]).toMatchObject({ done: true, real: true, href: "/leads/ligar/c" });
    expect(b.available).toBe(8);
    expect(p.queue.map((i) => i.key)).toEqual(["call:n4", "call:n5", "call:n6"]);
  });
  test("never do-not-call, never without a usable phone, never another type than the rule's", () => {
    const p = buildPlan(input({ rows: [row({ id: "dnc", dnc: true }), row({ id: "nophone", phone: "call me" }), row({ id: "res", segment: "residential" }), row({ id: "ok" })] }), DEFAULT_PLAN, DEFAULT_HOME_RULE);
    expect(keys(p, "call")).toEqual(["call:ok"]);
  });
  test("a lead already in an earlier block is not repeated", () => {
    const a = row({ id: "a" });
    const p = buildPlan(input({ rows: [a], tasks: [task({ lead_id: "a", due_at: "2026-11-17T16:00:00Z" })] }), DEFAULT_PLAN, DEFAULT_HOME_RULE);
    expect(keys(p, "returns")).toHaveLength(1);
    expect(keys(p, "call")).toEqual([]);
    // hidden blocks take nobody
    const hidden = buildPlan(input({ rows: [a], tasks: [task({ lead_id: "a", due_at: "2026-11-17T16:00:00Z" })] }), { ...DEFAULT_PLAN, hidden: ["returns"] }, DEFAULT_HOME_RULE);
    expect(keys(hidden, "call")).toEqual(["call:a"]);
  });
});

describe("Mandar e-mail", () => {
  const C = "2026-11-10T12:00:00Z";
  test("no answer N times, or e-mail without phone, or replied then silent > 7 days; in that order", () => {
    const silent = row({ id: "s", status: "replied", contacted: C, email: "s@ex.example", touch: "2026-11-05T12:00:00Z" });
    const recent = row({ id: "r", status: "replied", contacted: C, email: "r@ex.example", touch: "2026-11-15T12:00:00Z" });
    const noPhone = row({ id: "np", phone: null, email: "np@ex.example", segment: "residential" });
    const twice = row({ id: "tw", status: "call_list", contacted: C, email: "tw@ex.example" });
    const once = row({ id: "on", status: "call_list", contacted: C, email: "on@ex.example" });
    const p = buildPlan(input({ rows: [silent, recent, noPhone, twice, once], calls: { tw: calls({ noAnswer: 2 }), on: calls({ noAnswer: 1 }) } }), DEFAULT_PLAN, DEFAULT_HOME_RULE);
    expect(keys(p, "email")).toEqual(["email:tw", "email:np", "email:s"]);
    expect(block(p, "email").items[0].reason).toEqual({ t: "noAnswer", n: 2 });
    const three = buildPlan(input({ rows: [twice], calls: { tw: calls({ noAnswer: 2 }) } }), { ...DEFAULT_PLAN, email: { ...DEFAULT_PLAN.email, noAnswerN: 3 } }, DEFAULT_HOME_RULE);
    expect(keys(three, "email")).toEqual([]);
  });
  test("never do-not-call, closed, blocked or invalid e-mails; type filter; e-mailed today = done", () => {
    const C2 = { contacted: C, status: "call_list" };
    const rows = [
      row({ id: "dnc", ...C2, email: "a@ex.example", dnc: true }),
      row({ id: "won", status: "won", contacted: C, email: "b@ex.example" }),
      row({ id: "blk", ...C2, email: "c@ex.example" }),
      { ...row({ id: "bad", ...C2, email: "d@ex.example" }), emailQuality: "invalid" as const },
      row({ id: "res", ...C2, email: "e@ex.example", segment: "residential" }),
      row({ id: "ok", ...C2, email: "f@ex.example" }),
    ];
    const no = Object.fromEntries(rows.map((r) => [r.lead.id, calls({ noAnswer: 3 })]));
    const p = buildPlan(input({ rows, calls: no, suppressed: ["blk"], emailedToday: ["ok"] }), { ...DEFAULT_PLAN, email: { ...DEFAULT_PLAN.email, segments: ["large"] } }, DEFAULT_HOME_RULE);
    expect(block(p, "email").items.map((i) => [i.key, i.done])).toEqual([["email:ok", true]]);
  });
});

describe("Analisar", () => {
  test("meeting wanted without a date first, then counts: new yesterday (NY day), large without a contact name, no type", () => {
    const rows = [
      row({ id: "m", status: "meeting", contacted: "2026-11-10T00:00:00Z", contact: "Ana" }),
      row({ id: "m2", status: "meeting", contacted: "2026-11-10T00:00:00Z", contact: "Bia" }),
      row({ id: "y1", seen: "2026-11-16T05:00:00Z", contact: "C" }), // 00:00 on the 16th in NY
      row({ id: "y2", seen: "2026-11-17T04:59:00Z", contact: "D" }), // 23:59 on the 16th in NY
      row({ id: "t", seen: "2026-11-17T05:00:00Z", contact: "E" }), // today
      row({ id: "big" }),
      row({ id: "none", segment: null, contact: "F" }),
    ];
    const tasks = [task({ lead_id: "m2", kind: "meeting", due_at: "2026-11-20T15:00:00Z" })];
    const p = buildPlan(input({ rows, tasks, calls: { m: calls({ last: "meeting_booked" }), m2: calls({ last: "meeting_booked" }) } }), { ...DEFAULT_PLAN, counts: { ...DEFAULT_PLAN.counts, review: 10 } }, DEFAULT_HOME_RULE);
    const r = block(p, "review").items;
    expect(r.map((i) => i.key)).toEqual(["review:meet:m", "review:new:2026-11-16", "review:big", "review:notype"]);
    expect(r[0]).toMatchObject({ action: "meeting", href: null, hot: true });
    expect(r.slice(1).map((i) => i.href)).toEqual(["/leads?entered=yesterday", "/leads?segment=large&noName=1", "/leads?segment=none"]);
    expect(r.slice(1).map((i) => i.reason)).toEqual([
      { t: "review", kind: "newYesterday", n: 2 },
      { t: "review", kind: "bigNoContact", n: 1 },
      { t: "review", kind: "noType", n: 1 },
    ]);
  });
  test("only a manual tick marks them done; the count caps the block", () => {
    const rows = [row({ id: "big" }), row({ id: "none", segment: null })];
    const p = buildPlan(input({ rows, marks: ["review:big"] }), { ...DEFAULT_PLAN, counts: { ...DEFAULT_PLAN.counts, review: 1 }, hidden: ["call"] }, DEFAULT_HOME_RULE);
    expect(block(p, "review").items.map((i) => [i.key, i.done, i.real])).toEqual([["review:big", true, false]]);
    expect(block(p, "review").available).toBe(2);
  });
});

describe("the whole plan", () => {
  const rows = [row({ id: "x" }), row({ id: "y" })];
  test("order, hidden blocks and the next item; done counts real actions and manual ticks", () => {
    const plan: DayPlan = { ...DEFAULT_PLAN, order: ["call", "returns", "email", "review"], hidden: ["review"] };
    const p = buildPlan(input({ rows, marks: ["call:x"] }), plan, DEFAULT_HOME_RULE);
    expect(p.blocks.map((b) => [b.id, b.hidden])).toEqual([["call", false], ["returns", false], ["email", false], ["review", true]]);
    expect(p.total).toBe(2);
    expect(p.done).toBe(1);
    expect(p.next?.key).toBe("call:y");
  });
  test("all done: no next item", () => {
    const p = buildPlan(input({ rows, marks: ["call:x", "call:y"] }), { ...DEFAULT_PLAN, hidden: ["review"] }, DEFAULT_HOME_RULE);
    expect([p.done, p.total, p.next]).toEqual([2, 2, null]);
  });
});

describe("review fixes", () => {
  const C = "2026-11-10T12:00:00Z";
  test("the closer gets no e-mail block (she cannot see the blocked addresses): empty and hidden", () => {
    const r = row({ id: "np", phone: null, email: "np@ex.example" });
    const p = buildPlan(input({ rows: [r], sender: false }), DEFAULT_PLAN, DEFAULT_HOME_RULE);
    expect(block(p, "email")).toMatchObject({ hidden: true, items: [], available: 0 });
    expect(blocksFor(false)).toEqual(["returns", "call", "review"]);
    expect(keys(buildPlan(input({ rows: [r] }), DEFAULT_PLAN, DEFAULT_HOME_RULE), "email")).toEqual(["email:np"]);
  });
  test("moving among the shown blocks skips the ones not shown", () => {
    const order = ["returns", "email", "call", "review"] as const;
    expect(moveBlock(order, "call", -1, blocksFor(false))).toEqual(["call", "email", "returns", "review"]);
    expect(moveBlock(order, "returns", 1, blocksFor(false))).toEqual(["call", "email", "returns", "review"]);
  });
  test("at least one block stays: hiding all four is refused on write and falls back on read", () => {
    expect(planSchema.safeParse({ ...DEFAULT_PLAN, hidden: ["returns", "call", "email", "review"] }).success).toBe(false);
    expect(planSchema.safeParse({ ...DEFAULT_PLAN, hidden: ["call", "call"] }).success).toBe(false);
    expect(parsePlan({ hidden: ["returns", "call", "email", "review"] }).hidden).toEqual([]);
  });
  test("Analisar counts take every lead, closed and do-not-call too, like the Leads list the link opens", () => {
    const rows = [row({ id: "w", status: "won", contacted: C }), row({ id: "d", dnc: true }), row({ id: "n", segment: null, status: "lost", contacted: C })];
    const r = block(buildPlan(input({ rows }), { ...DEFAULT_PLAN, hidden: ["call"] }, DEFAULT_HOME_RULE), "review").items;
    expect(r.map((i) => [i.key, i.reason, i.href])).toEqual([
      ["review:big", { t: "review", kind: "bigNoContact", n: 2 }, "/leads?segment=large&noName=1"],
      ["review:notype", { t: "review", kind: "noType", n: 1 }, "/leads?segment=none"],
    ]);
  });
  test("an unread blocked list blocks every lead with an e-mail", () => {
    const rows = [row({ id: "a", email: "x@ex.example" }), row({ id: "b", email: "y@blocked.example" }), row({ id: "c" })];
    expect(suppressedOf(rows, null)).toEqual(["a", "b"]);
    expect(suppressedOf(rows, [{ kind: "domain", value: "Blocked.example " }])).toEqual(["b"]);
  });
});

describe("New York day around the end of daylight saving (1 Nov 2026)", () => {
  test("wall times on the 1st: 00:30 is EDT, 03:00 is EST", () => {
    expect(nyLocalToIso("2026-11-01T00:30")).toBe("2026-11-01T04:30:00.000Z");
    expect(nyLocalToIso("2026-11-01T03:00")).toBe("2026-11-01T08:00:00.000Z");
    expect(nyLocalToIso("2026-03-08T02:30")).toBeNull(); // the spring jump: that time does not exist
  });
  test("on the 2nd, yesterday is the whole 25-hour 1st, and a task due on the 31st is 2 days late", () => {
    const now = "2026-11-02T15:00:00.000Z";
    const rows = [row({ id: "early", seen: "2026-11-01T04:30:00Z" }), row({ id: "late", seen: "2026-11-02T04:59:00Z" }), row({ id: "today", seen: "2026-11-02T05:00:00Z" }), row({ id: "before", seen: "2026-11-01T03:59:00Z" })];
    const p = buildPlan(input({ now, rows, tasks: [task({ lead_id: "early", due_at: "2026-10-31T16:00:00Z" })] }), { ...DEFAULT_PLAN, hidden: ["call"] }, DEFAULT_HOME_RULE);
    expect(block(p, "review").items.find((i) => i.key.startsWith("review:new"))).toMatchObject({ key: "review:new:2026-11-01", reason: { t: "review", kind: "newYesterday", n: 2 } });
    expect(block(p, "returns").items[0].reason).toEqual({ t: "late", days: 2 });
  });
});
