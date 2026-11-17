import { describe, expect, test } from "vitest";
import { dateLineOf, firstNameOf, funnelOf, greetingOf, isReady, parsePeriod, readyLine, todayCounts, topOrigins } from "@/lib/home/view";
import type { HomeRow } from "@/lib/home/rule";

const NOW = new Date("2026-11-17T15:00:00Z"); // 10:00 in New York (EST)

function row(id: string, o: { status?: string; contacted?: boolean; dnc?: boolean; phone?: string | null; seen?: string; segment?: "large" | "residential" | null; origin?: string } = {}): HomeRow {
  return {
    lead: { id, status: (o.status ?? "new") as never, level: 1, origin_kind: "import", origin_agent_id: null, first_contacted_at: o.contacted ? "2026-11-01T00:00:00Z" : null, last_touch_at: null, segment: null, first_seen_at: o.seen ?? "2026-11-16T12:00:00Z", do_not_call: o.dnc ?? false },
    best: null,
    display: { name: `Co ${id}`, city: "Boston", phone: o.phone === undefined ? "(508) 555-0101" : o.phone, website: null, email: null },
    origins: [{ name: o.origin ?? "Lista A", at: "2026-11-01T00:00:00Z", kind: "list" }],
    agentName: null,
    importName: null,
    segment: o.segment === undefined ? null : o.segment,
  };
}

describe("greeting by New York hour", () => {
  const at = (iso: string) => greetingOf(new Date(iso));
  test("morning, afternoon, evening, night", () => {
    expect(at("2026-11-17T15:00:00Z")).toBe("Bom dia"); // 10:00 NY
    expect(at("2026-11-17T16:59:00Z")).toBe("Bom dia"); // 11:59
    expect(at("2026-11-17T17:00:00Z")).toBe("Boa tarde"); // 12:00
    expect(at("2026-11-17T22:59:00Z")).toBe("Boa tarde"); // 17:59
    expect(at("2026-11-17T23:00:00Z")).toBe("Boa noite"); // 18:00
    expect(at("2026-11-18T03:00:00Z")).toBe("Boa noite"); // 22:00
    expect(at("2026-11-18T06:00:00Z")).toBe("Boa noite"); // 01:00 NY is still night
    expect(at("2026-11-18T10:00:00Z")).toBe("Bom dia"); // 05:00
  });
  test("it is the New York hour, not the server's (UTC 03:00 is 22:00 the day before; summer too)", () => {
    expect(at("2026-07-01T03:00:00Z")).toBe("Boa noite"); // 23:00 EDT
    expect(at("2026-07-01T13:00:00Z")).toBe("Bom dia"); // 09:00 EDT
  });
});

test("date line in pt-BR, New York day, upper case", () => {
  expect(dateLineOf(NOW)).toBe("TERÇA, 17 DE NOVEMBRO");
  expect(dateLineOf(new Date("2026-11-18T03:00:00Z"))).toBe("TERÇA, 17 DE NOVEMBRO"); // still the 17th in NY
  expect(dateLineOf(new Date("2026-11-21T15:00:00Z"))).toBe("SÁBADO, 21 DE NOVEMBRO");
});

test("first name: profile name, else the e-mail before the @", () => {
  expect(firstNameOf({ email: "ana.souza@x.example", user_metadata: { full_name: "juan SANCHES" } })).toBe("Juan");
  expect(firstNameOf({ email: "ana.souza@x.example", user_metadata: {} })).toBe("Ana");
  expect(firstNameOf({ email: "carla@x.example" })).toBe("Carla");
  expect(firstNameOf({ email: "bob@x.example", user_metadata: { name: "  " } })).toBe("Bob");
  expect(firstNameOf(null)).toBe("");
});

test("the ready line", () => {
  expect(readyLine(0)).toBe("Nenhuma empresa pronta para ligar hoje.");
  expect(readyLine(1)).toBe("Hoje você tem 1 empresa pronta para ligar.");
  expect(readyLine(1641)).toBe("Hoje você tem 1.641 empresas prontas para ligar.");
});

describe("HOJE counts", () => {
  const rows = [
    row("ready1"), row("ready2"),
    row("nophone", { phone: null }), row("shortphone", { phone: "555-0101" }),
    row("dnc", { dnc: true }), row("contacted", { contacted: true }),
    row("replied", { status: "replied" }), row("replied2", { status: "replied" }),
    row("meeting", { status: "meeting" }), row("closer", { status: "with_closer" }), row("won", { status: "won" }),
  ];
  test("ready = Novo + callable phone + not do-not-call", () => {
    expect(isReady(rows[0])).toBe(true);
    expect(rows.filter(isReady).map((r) => r.lead.id)).toEqual(["ready1", "ready2"]);
  });
  test("counts, and tasks due today or overdue by the New York day", () => {
    const dues = [
      "2026-11-17T04:59:00Z", // 16/11 23:59 NY: overdue
      "2026-11-17T05:00:00Z", // 17/11 00:00 NY: today
      "2026-11-18T04:59:00Z", // 17/11 23:59 NY: today
      "2026-11-18T05:00:00Z", // 18/11 NY: next
    ];
    expect(todayCounts(rows, dues, NOW)).toEqual({ ready: 2, tasks: 3, replied: 2, meetings: 2 });
    expect(todayCounts([], [], NOW)).toEqual({ ready: 0, tasks: 0, replied: 0, meetings: 0 });
  });
});

describe("funnel period", () => {
  const rows = [
    row("n1", { seen: "2026-11-16T12:00:00Z", segment: "large" }),
    row("n2", { seen: "2026-11-01T12:00:00Z", segment: "residential" }),
    row("n3", { seen: "2026-09-01T12:00:00Z", segment: "large" }),
    row("c1", { status: "call_list", contacted: true, seen: "2026-11-14T12:00:00Z" }),
    row("c2", { status: "in_campaign", contacted: true, seen: "2026-10-01T12:00:00Z" }),
    row("r1", { status: "replied", contacted: true, seen: "2026-11-12T12:00:00Z" }),
    row("m1", { status: "meeting", seen: "2026-11-12T12:00:00Z" }),
    row("x1", { status: "won", seen: "2026-11-12T12:00:00Z" }),
    row("x2", { status: "lost", seen: "2026-02-12T12:00:00Z" }),
  ];
  const n = (p: "7" | "30" | "all") => funnelOf(rows, p, NOW).map((t) => t.n);
  test("Tudo counts everyone by stage; 30 and 7 days by entry date (New York midnight)", () => {
    expect(n("all")).toEqual([3, 2, 1, 1, 2]);
    expect(n("30")).toEqual([2, 1, 1, 1, 1]); // n3, c2, x2 entered before 19/10
    expect(n("7")).toEqual([1, 1, 1, 1, 1]); // since 11/11 00:00 NY: n1 (16/11), c1 (14/11), r1, m1, x1 (12/11)
  });
  test("notes: Novo splits by type, the others are a share of the period's leads, never invented", () => {
    const all = funnelOf(rows, "all", NOW);
    expect(all[0].note).toBe("2 grandes · 1 residenciais");
    expect(all[1].note).toBe("22% do total"); // 2 of 9
    expect(all[4].note).toBe("ganhos e perdidos");
    expect(funnelOf([], "all", NOW)[1].note).toBe("—");
  });
  test("period param: anything else is Tudo", () => {
    expect(["7", "30", "all", "90", undefined, ["7"]].map(parsePeriod)).toEqual(["7", "30", "all", "all", "all", "all"]);
  });
});

test("top origins count each lead once per origin and sort by count", () => {
  const rows = [row("a", { origin: "B" }), row("b", { origin: "B" }), row("c", { origin: "A" }), row("d", { origin: "C" })];
  expect(topOrigins(rows)).toEqual([{ name: "B", n: 2 }, { name: "A", n: 1 }, { name: "C", n: 1 }]);
  expect(topOrigins(rows, 1)).toEqual([{ name: "B", n: 2 }]);
});
