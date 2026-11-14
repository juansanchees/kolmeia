import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CAMPAIGN_TABS, LEADS_TABS, MAIN_AREAS, SETTINGS_HREF, SETTINGS_TABS, activeHref, areasFor } from "@/lib/nav";
import { isSender } from "@/lib/roles";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = join(dir, n);
    return statSync(f).isDirectory() ? walk(f) : [f];
  });
}

describe("F1 nav", () => {
  test("the campaign tabs are Campanhas and Respostas only", () => {
    expect(CAMPAIGN_TABS.map((i) => [i.label, i.href])).toEqual([["Campanhas", "/campanhas"], ["Respostas", "/campanhas/respostas"]]);
  });
  test("the longest matching tab wins", () => {
    const camp = ["/campanhas", "/campanhas/respostas"];
    expect(activeHref("/campanhas/respostas", camp)).toBe("/campanhas/respostas");
    expect(activeHref("/campanhas/123/revisar", camp)).toBe("/campanhas");
    expect(activeHref("/leads/closer", ["/leads", "/leads/closer"])).toBe("/leads/closer");
    expect(activeHref("/agentes/pesquisa/abc", ["/agentes", "/leads", "/campanhas"])).toBe("/agentes");
  });
  test("a prefix without a slash does not match", () => {
    expect(activeHref("/campanhasx", ["/campanhas"])).toBeNull();
  });
  test("settings pages light no main area", () => {
    expect(activeHref("/configuracoes/caixas", ["/agentes", "/leads", "/campanhas"])).toBeNull();
    expect(SETTINGS_TABS.map((i) => [i.label, i.href])).toEqual([
      ["Sua empresa", "/configuracoes/empresa"],
      ["Caixas de e-mail", "/configuracoes/caixas"],
      ["Bloqueados", "/configuracoes/bloqueados"],
    ]);
  });
  test("the LEADS tabs are Todos and Com a closer", () => {
    expect(LEADS_TABS.map((i) => [i.label, i.href])).toEqual([
      ["Todos", "/leads"],
      ["Com a closer", "/leads/closer"],
    ]);
  });
});

describe("F1 shell", () => {
  test("the menu has exactly the 3 areas, in order", () => {
    expect(MAIN_AREAS.map((i) => [i.label, i.href])).toEqual([
      ["Agentes", "/agentes"],
      ["Leads", "/leads"],
      ["Campanhas de e-mail", "/campanhas"],
    ]);
    expect(MAIN_AREAS.some((i) => i.href.startsWith(SETTINGS_HREF))).toBe(false);
  });
  test("the header links ⚙ to Configurações", () => {
    const src = read("src/components/Header.tsx");
    expect(src).toContain("SETTINGS_HREF");
    expect(src).toContain("t.nav.settings");
  });
  test("the bottom bar is phone-only and the page leaves room for it", () => {
    const nav = read("src/components/NavLinks.tsx");
    expect(nav).toContain("md:hidden");
    expect(nav).toContain("fixed");
    expect(nav).toContain("hidden md:flex");
    const layout = read("src/app/(app)/layout.tsx");
    expect(layout).toContain('variant="bottom"');
    expect(layout).toContain("pb-24");
    expect(layout).toContain("md:pb-8");
  });
  test("no screen says pearchat", () => {
    const hits = walk(join(process.cwd(), "src")).filter((f) => /pearchat/i.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});

describe("F2 roles", () => {
  test("J2 the closer's menu is LEADS only; owner and sdr see the 3 areas", () => {
    expect(areasFor("closer").map((i) => i.href)).toEqual(["/leads"]);
    expect(areasFor("owner")).toEqual(MAIN_AREAS);
    expect(areasFor("sdr")).toEqual(MAIN_AREAS);
    expect([isSender("owner"), isSender("sdr"), isSender("closer")]).toEqual([true, true, false]);
  });
  test("J2 AGENTES and CAMPANHAS send the closer to LEADS", () => {
    const SENDER_ONLY = ["src/app/(app)/campanhas/layout.tsx", "src/app/(app)/agentes/page.tsx", "src/app/(app)/agentes/novo/page.tsx", "src/app/(app)/agentes/[id]/page.tsx", "src/app/(app)/agentes/pesquisa/layout.tsx"];
    for (const f of SENDER_ONLY) expect(read(f), f).toContain("requireSender()");
    expect(read("src/lib/workspace.ts")).toContain('redirect("/leads")');
  });
  test("J2 the closer notice replaces the old read-only copy", () => {
    expect(read("src/messages/pt/email.ts")).not.toContain("readOnly");
    const hits = walk(join(process.cwd(), "src")).filter((f) => readFileSync(f, "utf8").includes("t.email.readOnly"));
    expect(hits).toEqual([]);
    expect(read("src/app/(app)/leads/layout.tsx")).toContain("t.roles.closerNotice");
    expect(read("src/app/(app)/configuracoes/layout.tsx")).toContain("t.roles.closerNotice");
    expect(read("src/app/(app)/campanhas/layout.tsx")).not.toContain("Notice");
  });
  test("J2 Sua empresa is read-only for the closer, and the bottom bar fits any number of areas", () => {
    expect(read("src/app/(app)/configuracoes/empresa/page.tsx")).toContain("isSender(");
    expect(read("src/app/(app)/configuracoes/empresa/ProfileForm.tsx")).toContain("disabled={readOnly}");
    const nav = read("src/components/NavLinks.tsx");
    expect(nav).toContain("areasFor(role)");
    expect(nav).toContain("auto-cols-fr");
    expect(nav).not.toContain("grid-cols-3");
    expect(read("src/components/Header.tsx")).toContain("role=");
    expect(read("src/app/(app)/layout.tsx")).toContain("role=");
  });
});

describe("F2 setup chat", () => {
  test("the setup chat never shows the approve-and-search card", () => {
    const page = read("src/app/(app)/agentes/[id]/page.tsx");
    for (const needle of ["hunterStep(", "QuestionsForm", "RunDriver", "HunterReviewCard"]) expect(page, needle).toContain(needle);
    expect(page).not.toContain("PlanCard");
    expect(page).not.toContain("Conversation");
    expect(read("src/components/agents/HunterReviewCard.tsx")).not.toContain("approveResearch");
  });
  test("/agentes/pesquisa/<setup run> opens the agent instead; answers refresh the agent chat", () => {
    const page = read("src/app/(app)/agentes/pesquisa/[id]/page.tsx");
    expect(page).toContain("run.setup_agent_id");
    expect(page).toContain("redirect(`/agentes/${run.setup_agent_id}`)");
    const actions = read("src/app/(app)/agentes/actions.ts");
    for (const fn of ["answerQuestions", "adjustResearch"]) {
      const start = actions.indexOf(`export async function ${fn}`);
      const end = actions.indexOf("\nexport async function", start + 1);
      expect(actions.slice(start, end), fn).toContain('revalidatePath("/agentes", "layout")');
    }
  });
});

describe("F3a LEADS", () => {
  test("LEADS lists leads, not searches", () => {
    const page = read("src/app/(app)/leads/page.tsx");
    expect(page).toContain("listLeads(");
    expect(page).not.toContain("research_runs");
    const detail = read("src/app/(app)/leads/[id]/page.tsx");
    expect(detail).toContain("getLead(");
    expect(detail).toContain("[0-9a-f-]{36}");
    expect(detail).toContain("notFound()");
  });
  test("the lead page renders import-only leads with their sources", () => {
    const detail = read("src/app/(app)/leads/[id]/page.tsx");
    expect(detail).toContain("FieldList");
    expect(detail).not.toContain("if (!best) notFound()");
    expect(read("src/components/leads/FieldList.tsx")).toContain("sanitizeUrl(");
  });
  test("the closer is not sent to agent screens from LEADS", () => {
    const table = read("src/components/leads/LeadsTable.tsx");
    expect(table).toMatch(/canCreate\s*&&[\s\S]*\/agentes\/novo|canCreate\s*\?[\s\S]*\/agentes\/novo/);
    expect(table.match(/\/agentes\/novo/g)?.length).toBe(1);
    expect(read("src/app/(app)/leads/page.tsx")).toContain("canCreate={isSender(");
    expect(read("src/app/(app)/agentes/pesquisa/layout.tsx")).toContain("requireSender()");
  });
  test("the proof list is shared and marks stale proof", () => {
    const proof = read("src/components/research/proof.tsx");
    expect(proof).toContain("export function ProofList");
    expect(proof).toContain("isStaleProof(");
    const results = read("src/components/research/Results.tsx");
    expect(results).toContain('from "./proof"');
    expect(results).not.toContain("function ProofList");
  });
  test("the old LEADS placeholder is gone", () => {
    const hits = walk(join(process.cwd(), "src")).filter((f) => /t\.leads\.(soon|none|start)\b/.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});

describe("F3b agent screens", () => {
  test("agent runs open read-only: no RunDriver for run.agent_id, AutoRefresh instead", () => {
    const src = read("src/app/(app)/agentes/pesquisa/[id]/page.tsx");
    expect(src).toContain("run.agent_id");
    expect(src).toContain("AutoRefresh");
    expect(src).toContain("!run.agent_id");
    expect(src).toMatch(/!run\.agent_id[^\n]*RunDriver/);
  });
  test("the agent page can turn on, pause and confirm archiving", () => {
    expect(read("src/components/agents/AgentDetail.tsx")).toContain("AgentPowerButton");
    expect(read("src/components/agents/AgentDetail.tsx")).not.toContain("turnOnSoon");
    expect(read("src/components/agents/ArchiveButton.tsx")).toContain("archiveConfirm");
    const hits = walk(join(process.cwd(), "src")).filter((f) => readFileSync(f, "utf8").includes("turnOnSoon"));
    expect(hits).toEqual([]);
  });
});
