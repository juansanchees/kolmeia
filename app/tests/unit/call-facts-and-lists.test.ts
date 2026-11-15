import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/workspace", () => ({
  getCurrentWorkspace: async () => ({ id: "w", role: "owner" }),
  getUser: () => getUser(),
}));

import { removeMemberAction } from "@/app/(app)/configuracoes/equipe/actions";
import { CallFacts } from "@/components/calls/CallFacts";
import { nextInList } from "@/lib/calls/call-queries";
import { listLeads } from "@/lib/leads/queries";
import type { LeadDetail } from "@/lib/leads/types";

const detail = (over: Record<string, unknown> = {}) =>
  ({
    lead: { id: "l1", best_candidate_id: null, level: 0, closer_brief: null, do_not_call: false, ...over },
    agentName: null, candidates: [], checks: [], fields: [], importNames: {}, queue: null,
  }) as unknown as LeadDetail;

describe("CallFacts", () => {
  it("shows the tel: link for a normal lead", () => {
    const html = renderToStaticMarkup(createElement(CallFacts, { detail: detail(), phone: "508-555-0101", now: new Date() }));
    expect(html).toContain('href="tel:+15085550101"');
  });

  it("hides the tel: link when blocked (do_not_call)", () => {
    const html = renderToStaticMarkup(createElement(CallFacts, { detail: detail({ do_not_call: true }), phone: "508-555-0101", now: new Date(), blocked: true }));
    expect(html).not.toContain("tel:");
    expect(html).toContain("Bloqueado: não ligar");
  });

  it("drops proof links that are not safe http(s) URLs", () => {
    const d = detail({ best_candidate_id: "c" });
    d.checks = [{ candidate_id: "c", evidence: [{ url: "javascript:alert(1)", title: "bad", excerpt: null, seen_at: null }, { url: "https://ok.example.com/x", title: "good", excerpt: null, seen_at: null }] }] as never;
    const html = renderToStaticMarkup(createElement(CallFacts, { detail: d, phone: null, now: new Date() }));
    expect(html).not.toContain("javascript:");
    expect(html).toContain("https://ok.example.com/x");
  });
});

/** Fake chain: records every call; resolves with the rows given per table. */
function fakeDb(tables: Record<string, unknown[]>, log: [string, string, unknown[]][] = []) {
  return {
    log,
    from(table: string) {
      const rows = tables[table] ?? [];
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "not", "in", "order", "limit", "range", "gte"]) {
        q[m] = (...a: unknown[]) => {
          log.push([table, m, a]);
          return q;
        };
      }
      q.then = (res: (v: unknown) => unknown) => res({ data: rows, error: null });
      return q;
    },
  };
}
const lead = (id: string) => ({ id, workspace_id: "w", best_candidate_id: null, status: "with_closer", owner_id: "u", last_seen_at: "2026-11-01T00:00:00Z" });

describe("listLeads filters", () => {
  it("{ids}: loads only those ids, no paging", async () => {
    const log: [string, string, unknown[]][] = [];
    const db = fakeDb({ leads: [lead("a")] }, log);
    const out = await listLeads(db as never, "w", { ids: ["a", "b"] });
    expect(out.map((i) => i.lead.id)).toEqual(["a"]);
    expect(log.some(([t, m, a]) => t === "leads" && m === "in" && a[0] === "id" && JSON.stringify(a[1]) === '["a","b"]')).toBe(true);
    expect(log.some(([t, m]) => t === "leads" && m === "range")).toBe(false);
  });

  it("{statuses, ownerNotNull}: applied server-side on the paged query", async () => {
    const log: [string, string, unknown[]][] = [];
    const db = fakeDb({ leads: [lead("a")] }, log);
    await listLeads(db as never, "w", { statuses: ["with_closer", "meeting"], ownerNotNull: true });
    expect(log).toContainEqual(["leads", "in", ["status", ["with_closer", "meeting"]]]);
    expect(log).toContainEqual(["leads", "not", ["owner_id", "is", null]]);
  });
});

describe("nextInList", () => {
  const items = ["a", "b", "c", "d"].map((id, i) => ({ lead_id: id, agent_id: "ag", position: i }));
  const run = (after: string, called: string[]) => {
    const calledAt = new Date().toISOString();
    return nextInList(fakeDb({ call_list_items: items, call_logs: called.map((lead_id) => ({ lead_id, called_at: calledAt })) }) as never, "u", after);
  };
  it("returns the next lead", async () => expect(await run("a", [])).toBe("b"));
  it("returns null at the end of the list", async () => expect(await run("d", [])).toBeNull());
  it("skips leads already called today", async () => expect(await run("a", ["b", "c"])).toBe("d"));
  it("a lead not in the list gives the first uncalled item", async () => expect(await run("zzz", [])).toBe("a"));
});

describe("removeMemberAction", () => {
  it("rejects a non-uuid id", async () => {
    getUser.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111" });
    expect((await removeMemberAction("nope")).status).toBe("error");
  });
  it("rejects removing yourself", async () => {
    getUser.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111" });
    const r = await removeMemberAction("11111111-1111-4111-8111-111111111111");
    expect(r.status).toBe("error");
  });
});
