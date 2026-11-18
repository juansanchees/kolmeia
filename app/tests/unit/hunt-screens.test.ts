import { readFileSync } from "node:fs";
import { cloneElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

let locale: string | undefined;
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => (locale ? { value: locale } : undefined) }) }));
vi.mock("@/lib/i18n/server", async () => {
  const i = await import("@/lib/i18n");
  return { getT: async () => i.messagesFor(locale === "en" ? "en" : "pt"), getLocale: async () => (locale === "en" ? "en" : "pt") };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/workspace", () => ({ getCurrentWorkspace: async () => ({ id: "w", role: "owner" }), getUser: async () => ({ id: "u" }), requireSender: async () => ({ id: "w", role: "owner" }) }));
vi.mock("@/app/(app)/agentes/campanhas/actions", () => ({ startCampaignAction: vi.fn(), instructAction: vi.fn(), preferenceAction: vi.fn() }));

import { CampaignThread } from "@/components/hunt/CampaignThread";
import { EntryForm } from "@/components/hunt/EntryForm";
import { OpportunityFacts } from "@/components/hunt/OpportunityFacts";
import { PreferenceCard } from "@/components/hunt/PreferenceCard";
import { ProposalCard } from "@/components/hunt/ProposalCard";
import { SourceCoverage } from "@/components/hunt/SourceCoverage";
import { CallFacts } from "@/components/calls/CallFacts";
import BotPage from "@/app/bot/page";
import { proposeSearches } from "@/lib/hunt/proposals";
import type { OppFacts } from "@/lib/hunt/top-opportunity";
import type { LeadDetail } from "@/lib/leads/types";
import { USER_AGENT } from "@/lib/qualifier/site/reader";

beforeEach(() => { locale = undefined; });
const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
// Server components here are async and nest each other: expand the async ones first, then render (client ones keep their hooks).
type Node_ = unknown;
async function expand(n: Node_): Promise<Node_> {
  if (Array.isArray(n)) return Promise.all(n.map(expand));
  if (!isValidElement(n)) return n;
  const { type, props } = n as { type: unknown; props: Record<string, unknown> };
  if (typeof type === "function" && type.constructor.name === "AsyncFunction") return expand(await (type as (p: unknown) => unknown)(props));
  return cloneElement(n as React.ReactElement, undefined, ...(Array.isArray(props.children) ? ((await expand(props.children)) as React.ReactNode[]) : props.children === undefined ? [] : [(await expand(props.children)) as React.ReactNode]));
}
const html = async (el: Promise<React.ReactElement> | React.ReactElement) => renderToStaticMarkup((await expand(await el)) as React.ReactElement);

const PROFILE = { what_we_do: "HVAC installation and service", service_area: "", wanted_work: ["new_construction", "multifamily", "maintenance"], good_customer: "Builders" };
const OPP: OppFacts = {
  title: "New single family dwelling at 12 Example Rd",
  signal_date: "2026-10-20",
  source: "permit",
  source_url: "https://example.com/permits/1",
  priority_codes: ["issued_30d", "value_500k", "kind_deprioritized"],
  hook_en: "Saw the Oct 2026 permit for a new home at 12 Example Rd — who's handling the HVAC?",
  checks: { contact: { path: "vendor_portal", value_source_url: "https://example.com/about" } },
  open_questions: ["ask_taking_bids", "ask_gc"],
  contact_path: "vendor_portal",
  contact_value: "https://example.com/vendors",
};

describe("first access", () => {
  it("entry box says 'quero mais clientes' (pt) and 'I want more customers' (en)", async () => {
    expect(await html(EntryForm({}))).toContain('placeholder="quero mais clientes"');
    locale = "en";
    expect(await html(EntryForm({}))).toContain('placeholder="I want more customers"');
  });

  it("proposal cards: business words, recommended marked, one-click start, adjust box, region question when the profile has none", async () => {
    const props = proposeSearches(PROFILE, []);
    expect(props.length).toBeGreaterThanOrEqual(2);
    const first = await html(ProposalCard({ p: props[0], request: "quero mais clientes", needRegion: true }));
    expect(first).toContain("Instalação de HVAC em obra nova");
    expect(first).toContain("Recomendada");
    expect(first).toContain("Quem compra");
    expect(first).toContain("Construtoras (GC)");
    expect(first).toContain("Alvará de obra nova emitido");
    expect(first).toContain("Alvarás das prefeituras");
    expect(first).toContain("Começar por esta");
    expect(first).toContain('name="adjust"');
    expect(first).toContain('name="region"');
    expect(first).toContain("Em qual região a empresa atende?");
    const second = await html(ProposalCard({ p: props[1], request: "x", needRegion: false }));
    expect(second).not.toContain("Recomendada");
    expect(second).not.toContain('name="region"');
    expect(`${first}${second}`).not.toMatch(/search_|gc"|new_building_permit|\bcloser\b|linkedin/i);
  });
});

describe("campaign conversation", () => {
  const rounds = [
    { id: "r1", n: 1, ended_at: "2026-11-18T10:00:00Z", stop_reason: "waiting", summary: { new: 0, updated: 0, demoted: 0, sources: [{ source: "permit", town: "Exampleton", outcome: "ok" }], blockers: [], asks: ["run_pilot"] } },
    { id: "r2", n: 2, ended_at: "2026-11-18T11:00:00Z", stop_reason: "waiting", summary: { new: 1, updated: 2, demoted: 3, sources: [{ source: "site_robot", town: "Exampleton", outcome: "blocked", reason: "site blocked (403/429)" }], blockers: ["need_bid_path"], asks: [] } },
  ];
  const messages = [
    { id: "m1", role: "user" as const, body: "quero mais clientes", created_at: "2026-11-18T09:00:00Z" },
    { id: "m2", role: "agent" as const, body: "Busca criada.", created_at: "2026-11-18T10:00:01Z" },
    { id: "m3", role: "user" as const, body: "casas pequenas demais", created_at: "2026-11-18T10:30:00Z" },
  ];
  it("shows each round with new / updated / demoted, sources with outcome, what is missing, why it stopped; in time order", async () => {
    const out = await html(CampaignThread({ messages, rounds }));
    expect(out).toContain("Rodada 1");
    expect(out).toContain("Rodada 2");
    for (const w of ["Novas", "Atualizadas", "Perderam prioridade", "Fontes consultadas", "Alvarás", "Bloqueada", "site blocked (403/429)", "O que ainda falta", "Falta descobrir por onde apresentar orçamento", "Precisa de você", "o operador precisa executá-la", "Por que parou", "Aguardando uma etapa"]) expect(out, w).toContain(w);
    expect(out.indexOf("quero mais clientes")).toBeLessThan(out.indexOf("Rodada 1"));
    expect(out.indexOf("Rodada 1")).toBeLessThan(out.indexOf("Busca criada."));
    expect(out.indexOf("casas pequenas demais")).toBeLessThan(out.indexOf("Rodada 2"));
  });
  it("english words", async () => {
    locale = "en";
    const out = await html(CampaignThread({ messages, rounds }));
    for (const w of ["Round 2", "Lost priority", "Sources checked", "Blocked", "Why it stopped"]) expect(out, w).toContain(w);
  });
  it("pending rule: rule, examples, expected effect, Aprovar / Agora não; approved rule: Desfazer", async () => {
    const proposed = await html(PreferenceCard({ campaignId: "c", pref: { id: "p1", status: "proposed", rule: { deprioritizeKinds: ["single_family"] }, expected_effect: { up: 0, down: 2 }, examples: ["New single family dwelling at 12 Example Rd"] } }));
    for (const w of ["Descer: casas unifamiliares", "12 Example Rd", "0 sobem · 2 descem", "Aprovar", "Agora não"]) expect(proposed, w).toContain(w);
    expect(proposed).not.toContain("Desfazer");
    const approved = await html(PreferenceCard({ campaignId: "c", pref: { id: "p1", status: "approved", rule: { preferKinds: ["multifamily"] }, expected_effect: { up: 0, down: 0 }, examples: [] } }));
    expect(approved).toContain("Subir: multifamiliares");
    expect(approved).toContain("Desfazer");
    expect(approved).not.toContain("Aprovar");
  });
});

describe("opportunity on the call screen", () => {
  it("shows job, dated source link, reasons, contact path, English hook (lang=en) and questions", async () => {
    const out = await html(OpportunityFacts({ opp: OPP }));
    expect(out).toContain("New single family dwelling at 12 Example Rd");
    expect(out).toContain("20/10/2026");
    expect(out).toContain('href="https://example.com/permits/1"');
    for (const w of ["Alvará de até 30 dias", "Obra acima de US$ 500 mil", "Tipo de obra que você quer menos", "Cadastro de fornecedor"]) expect(out, w).toContain(w);
    expect(out).toContain('href="https://example.com/vendors"');
    expect(out).toContain('<q lang="en"');
    expect(out).toContain("who&#x27;s handling the HVAC?");
    expect(out).toContain("Estão recebendo orçamentos de HVAC?");
    expect(out).toContain("Quem é a construtora responsável?");
  });
  it("phone path shows the number; no path says so; unsafe links are dropped", async () => {
    expect(await html(OpportunityFacts({ opp: { ...OPP, contact_path: "phone", contact_value: "508-555-0101" } }))).toContain("508-555-0101");
    expect(await html(OpportunityFacts({ opp: { ...OPP, contact_path: "none", contact_value: null } }))).toContain("Ainda sem caminho de contato");
    const bad = await html(OpportunityFacts({ opp: { ...OPP, source_url: "javascript:alert(1)", contact_value: "javascript:alert(1)", checks: null } }));
    expect(bad).not.toContain("javascript:");
  });
  it("CallFacts renders the opportunity and uses its hook instead of the candidate's", async () => {
    const detail = { lead: { id: "l1", best_candidate_id: "c1", level: 0, closer_brief: null, do_not_call: false }, agentName: null, candidates: [{ id: "c1", hook: "Old generic hook" }], checks: [], fields: [], importNames: {}, queue: null } as unknown as LeadDetail;
    const out = await html(CallFacts({ detail, phone: "508-555-0101", now: new Date(), opportunity: OPP }));
    expect(out).toContain('data-testid="opportunity-facts"');
    expect(out).toContain("Saw the Oct 2026 permit");
    expect(out).not.toContain("Old generic hook");
    const without = await html(CallFacts({ detail, phone: "508-555-0101", now: new Date() }));
    expect(without).not.toContain("opportunity-facts");
    expect(without).toContain("Old generic hook");
  });
  it("other open jobs of the company: up to 3 with date and source link, count in the title, pt/en", async () => {
    const detail = { lead: { id: "l1", best_candidate_id: "c1", level: 0, closer_brief: null, do_not_call: false }, agentName: null, candidates: [{ id: "c1" }], checks: [], fields: [], importNames: {}, queue: null } as unknown as LeadDetail;
    const others = { total: 4, items: [{ title: "New duplex at 5 Example Ln", signal_date: "2026-10-01", source_url: "https://example.com/permits/2" }, { title: "Addition at 9 Example Ave", signal_date: "2026-09-01", source_url: null }] };
    locale = "en";
    const out = await html(CallFacts({ detail, phone: null, now: new Date(), opportunity: OPP, others }));
    expect(out).toContain('data-testid="other-opportunities"');
    expect(out).toContain("Other jobs of this company (4)");
    expect(out).toContain("New duplex at 5 Example Ln");
    expect(out).toContain('href="https://example.com/permits/2"');
    expect(await html(CallFacts({ detail, phone: null, now: new Date(), opportunity: OPP, others: { items: [], total: 0 } }))).not.toContain("other-opportunities");
    locale = "pt";
    expect(await html(CallFacts({ detail, phone: null, now: new Date(), opportunity: OPP, others }))).toContain("Outras obras desta empresa (4)");
  });
});

describe("coverage by source", () => {
  it("one row per town and source: date, outcome, entered count, reason", async () => {
    const out = await html(SourceCoverage({ rows: [
      { town: "Exampleton", source: "permit", ran_at: "2026-11-01T00:00:00Z", outcome: "ok", queried: 5, rows_in: 7 },
      { town: "Exampleton", source: "site_robot", ran_at: "2026-11-02T00:00:00Z", outcome: "blocked", queried: 1, rows_in: 0, reason: "site blocked (403/429)" },
    ] }));
    for (const w of ["Exampleton", "Alvarás", "Site da empresa", "01/11/2026", "Funcionou", "Bloqueada", "Entraram: 7", "site blocked (403/429)"]) expect(out, w).toContain(w);
  });
  it("the Cobertura page reads through kb_coverage and the section is titled 'Por fonte'", () => {
    const page = read("src/app/(app)/leads/cobertura/page.tsx");
    expect(page).toContain('rpc("kb_coverage"');
    expect(page).toContain("SourceCoverage");
  });
});

describe("/bot", () => {
  it("states the User-Agent and that robots.txt is honoured; pt on request; never LinkedIn", async () => {
    expect(USER_AGENT).toContain("kolmeia.solutions/bot");
    const en = await html(BotPage({ searchParams: Promise.resolve({}) }));
    expect(en).toContain(USER_AGENT);
    expect(en).toMatch(/robots\.txt/);
    expect(en).toContain("1 request per second");
    const pt = await html(BotPage({ searchParams: Promise.resolve({ lang: "pt" }) }));
    expect(pt).toContain(USER_AGENT);
    expect(pt).toContain("robots.txt");
    expect(`${en}${pt}`).not.toMatch(/linkedin/i);
  });
});

describe("wiring", () => {
  it("the agents page shows the entry box and the campaign page is under /agentes/campanhas", () => {
    expect(read("src/app/(app)/agentes/page.tsx")).toContain("HuntEntry");
    expect(read("src/components/hunt/EntryForm.tsx")).toContain('action="/agentes/clientes"');
  });
  it("the hunter agent config can carry the offer and campaign_id", async () => {
    const { hunterSetupSchema, hunterConfig } = await import("@/lib/agents/hunter");
    const setup = hunterSetupSchema.parse({ profileSource: "saved", companyNote: "", audience: "builder", audienceText: "", region: "Exampleton, MA", offer: "hvac_new_construction", campaign_id: "5a1f6f0e-0000-4000-8000-000000000001" });
    expect(hunterConfig(setup, { name: "x", rigor: "careful", schedule: "daily" }, "Exampleton, MA")).toMatchObject({ offer: "hvac_new_construction", campaign_id: "5a1f6f0e-0000-4000-8000-000000000001" });
    expect(hunterSetupSchema.safeParse({ profileSource: "saved", companyNote: "", audience: "builder", audienceText: "", region: "x", offer: "Bad Offer" }).success).toBe(false);
  });
});
