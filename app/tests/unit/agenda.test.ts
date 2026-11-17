import { describe, expect, test } from "vitest";
import { agendaHref, byDay, filterAgenda, isLate, kindGroup, monthGrid, parseAgenda, shiftMonth, type AgendaItem } from "@/lib/agenda/view";

const NOW = new Date("2026-11-17T15:00:00Z"); // Tue 17 Nov 2026, 10:00 in New York
const ME = "me";

describe("agenda URL", () => {
  test("defaults: this month, today, month view (New York day)", () => {
    expect(parseAgenda({}, NOW)).toEqual({ year: 2026, month: 11, day: "2026-11-17", view: "mes", today: "2026-11-17" });
    // 01:00 UTC on the 1st of December is still 30 November in New York
    expect(parseAgenda({}, new Date("2026-12-01T01:00:00Z")).day).toBe("2026-11-30");
  });
  test("another month opens on the 1st; bad values fall back", () => {
    expect(parseAgenda({ m: "2027-02", v: "lista" }, NOW)).toMatchObject({ year: 2027, month: 2, day: "2027-02-01", view: "lista" });
    expect(parseAgenda({ m: "2027-02", d: "30" }, NOW).day).toBe("2027-02-01");
    expect(parseAgenda({ m: "2026-11", d: "5", v: "semana" }, NOW)).toMatchObject({ day: "2026-11-05", view: "semana" });
    expect(parseAgenda({ m: "2026-13", d: "x", v: "ano" }, NOW)).toMatchObject({ year: 2026, month: 11, day: "2026-11-17", view: "mes" });
    expect(parseAgenda({ m: ["2026-10"] }, NOW).month).toBe(11);
  });
  test("links and month shifts", () => {
    expect(agendaHref("2026-11-05", "semana")).toBe("/inicio/agenda?m=2026-11&d=5&v=semana");
    expect(shiftMonth(2026, 12, 1)).toBe("2027-01");
    expect(shiftMonth(2026, 1, -1)).toBe("2025-12");
  });
});

describe("month grid", () => {
  test("November 2026 starts on a Sunday, has 30 days, 5 full weeks ending in December", () => {
    const g = monthGrid(2026, 11);
    expect(g).toHaveLength(5);
    expect(g.every((w) => w.length === 7)).toBe(true);
    expect(g[0][0]).toBe("2026-11-01");
    expect(g.flat().filter((d) => d.startsWith("2026-11"))).toHaveLength(30);
    expect(g[4]).toEqual(["2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04", "2026-12-05"]);
  });
  test("a month that starts mid-week is padded with the days before", () => {
    const g = monthGrid(2027, 2); // 1 Feb 2027 is a Monday
    expect(g[0][0]).toBe("2027-01-31");
    expect(g[0][1]).toBe("2027-02-01");
  });
});

describe("kinds, filters, late", () => {
  const item = (o: Partial<AgendaItem>): AgendaItem => ({ id: "x", lead_id: "l", kind: "call", title: "", due_at: "2026-11-17T19:00:00Z", done_at: null, assignee_id: ME, ...o });
  const items = [
    item({ id: "1", kind: "call" }),
    item({ id: "2", kind: "follow_up", assignee_id: "ana" }),
    item({ id: "3", kind: "meeting" }),
    item({ id: "4", kind: "email", assignee_id: "ana" }),
  ];
  test("call/follow-up are call-backs, meeting meetings, email e-mails", () => {
    expect(items.map((x) => kindGroup(x.kind))).toEqual(["returns", "returns", "meetings", "emails"]);
  });
  test("kind chips and who", () => {
    const ids = (xs: AgendaItem[]) => xs.map((x) => x.id);
    expect(ids(filterAgenda(items, new Set(["returns"] as const), "all", ME))).toEqual(["1", "2"]);
    expect(ids(filterAgenda(items, new Set(["returns", "meetings", "emails"] as const), "mine", ME))).toEqual(["1", "3"]);
    expect(ids(filterAgenda(items, new Set(["emails"] as const), "ana", ME))).toEqual(["4"]);
  });
  test("late = open and its New York day already passed", () => {
    const today = "2026-11-17";
    expect(isLate(item({ due_at: "2026-11-17T05:00:00Z" }), today)).toBe(false); // 00:00 today
    expect(isLate(item({ due_at: "2026-11-17T04:59:00Z" }), today)).toBe(true); // 23:59 yesterday
    expect(isLate(item({ due_at: "2026-11-16T15:00:00Z", done_at: "2026-11-16T16:00:00Z" }), today)).toBe(false);
  });
  test("grouped by New York day, in due order", () => {
    const m = byDay([item({ id: "b", due_at: "2026-11-18T03:00:00Z" }), item({ id: "a", due_at: "2026-11-17T14:00:00Z" })]);
    expect([...m.entries()].map(([d, xs]) => [d, xs.map((x) => x.id)])).toEqual([["2026-11-17", ["a", "b"]]]);
  });
});
