import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { DEFAULT_PLAN, type PlanInput } from "@/lib/home/plan";
import { DEFAULT_HOME_RULE, type HomeRow } from "@/lib/home/rule";
import { monthGrid, parseAgenda } from "@/lib/agenda/view";

// Smoke render of the two Início screens (server markup, fictional data): the approved copy is there, no greeting, no crash.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/(app)/inicio/actions", () => ({ markItemAction: vi.fn(), saveDayPlanAction: vi.fn() }));
vi.mock("@/app/(app)/inicio/agenda/actions", () => ({ createTaskAction: vi.fn(), rescheduleTaskAction: vi.fn(), setTaskDoneAction: vi.fn() }));

const { DayPlan } = await import("@/components/home/DayPlan");
const { AgendaView } = await import("@/components/tasks/AgendaView");

const NOW = "2026-11-17T15:00:00.000Z";
const row = (id: string): HomeRow => ({
  lead: { id, status: "new", level: 1, origin_kind: "import", origin_agent_id: null, first_contacted_at: null, last_touch_at: null, segment: null, first_seen_at: "2026-11-01T00:00:00Z", do_not_call: false },
  best: null,
  display: { name: `Construtora ${id}`, city: "Salem", phone: "(508) 555-0101", website: null, email: null },
  origins: [],
  agentName: null,
  importName: null,
  segment: "large",
});
const input: PlanInput = { now: NOW, userId: "me", sender: true, rows: [row("a"), row("b")], tasks: [], calls: {}, emailedToday: [], suppressed: [], marks: [] };

describe("Início screens render", () => {
  test("Plano de hoje: hero, blocks in order, next step, the empty-block hint", () => {
    const html = renderToStaticMarkup(createElement(DayPlan, { input, plan: DEFAULT_PLAN, rule: DEFAULT_HOME_RULE, dateLine: "TERÇA, 17 DE NOVEMBRO", cities: [], origins: [], people: null }));
    expect(html).toContain("SEU PLANO DE HOJE · TERÇA, 17 DE NOVEMBRO");
    expect(html).toContain("de 2 feitos");
    expect(html).toContain("Ligar para Construtora a (grande · nunca contatado).");
    expect(html.indexOf('id="blk-returns"')).toBeLessThan(html.indexOf('id="blk-call"'));
    expect(html).toContain("Sem retornos para hoje. Comece pelo bloco Ligar agora.");
    expect(html).toContain('aria-label="Marcar como feito: Construtora a"');
    expect(html).not.toMatch(/Bom dia|Boa tarde|Boa noite/);
  });
  test("Agenda: month grid with today, chips with counts, the chosen day", () => {
    const state = parseAgenda({}, new Date(NOW));
    const items = [{ id: "t1", lead_id: "a", kind: "meeting" as const, title: "Visita à obra", due_at: "2026-11-17T19:00:00Z", done_at: null, assignee_id: "me", name: "Construtora a" }];
    const html = renderToStaticMarkup(createElement(AgendaView, { state, grid: monthGrid(2026, 11), items, people: null, me: "me", leads: [] }));
    expect(html).toContain("Novembro de 2026");
    expect(html).toContain('aria-current="date"');
    expect(html).toContain("Reunião");
    expect(html).toContain("Visita à obra · Você");
    expect(html).toContain("Marcar retorno ou reunião");
    expect(html).not.toContain("De quem"); // the closer (no people list) has no "De quem"
  });
});
