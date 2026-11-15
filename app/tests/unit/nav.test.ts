import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CAMPAIGN_TABS, LEADS_TABS, MAIN_AREAS, SETTINGS_HREF, SETTINGS_TABS, activeHref, areasFor, leadsTabsFor, settingsTabsFor } from "@/lib/nav";
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
      ["Fontes conectadas", "/configuracoes/fontes"],
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

describe("F3d fontes conectadas nav", () => {
  test("the settings nav lists Fontes conectadas for owner and sdr, not closer", () => {
    for (const role of ["owner", "sdr"] as const) expect(settingsTabsFor(role).map((i) => i.href)).toContain("/configuracoes/fontes");
    expect(settingsTabsFor("closer").map((i) => i.href)).not.toContain("/configuracoes/fontes");
    expect(read("src/app/(app)/configuracoes/layout.tsx")).toContain("settingsTabsFor(");
  });
  test("the page is not found for a closer and read-only for the sdr", () => {
    const page = read("src/app/(app)/configuracoes/fontes/page.tsx");
    expect(page).toContain("isSender(workspace.role)");
    expect(page).toContain("notFound()");
    expect(page).toContain('isOwner={workspace.role === "owner"}');
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
    const SENDER_ONLY = ["src/app/(app)/campanhas/layout.tsx", "src/app/(app)/agentes/page.tsx", "src/app/(app)/agentes/novo/page.tsx", "src/app/(app)/agentes/[id]/page.tsx", "src/app/(app)/agentes/pesquisa/layout.tsx", "src/app/(app)/leads/subir/page.tsx"];
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

describe("F3c-1 upload screen", () => {
  test("the upload screen is sender-only and batches of 500 go through server actions", () => {
    expect(read("src/app/(app)/leads/subir/page.tsx")).toContain("requireSender");
    const actions = read("src/app/(app)/leads/subir/actions.ts");
    expect(actions).toContain('"use server"');
    expect(actions).toContain("requireSender");
    expect(actions).toContain("IMPORT_LIMITS.batch");
    expect(actions).toContain("revalidateRow");
    const table = read("src/components/leads/LeadsTable.tsx");
    const uses = table.split("t.imports.button").length - 1;
    expect(uses).toBeGreaterThan(0);
    expect(table.match(/canCreate && \([\s\S]{0,500}?t\.imports\.button/g)?.length).toBe(uses);
    const hits = walk(join(process.cwd(), "src")).filter((f) => /file\.text\(\)|read-excel-file/.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => f.replace(process.cwd() + "/", ""))).toEqual(["src/lib/imports/parse.ts"]);
  });
  test("the history lists incomplete imports with undo", () => {
    const h = read("src/components/imports/ImportHistory.tsx");
    expect(h).toContain("statuses");
    expect(h).toContain("undoConfirm");
    expect(read("src/messages/pt/imports.ts")).toContain("leads já trabalhados ou com a closer ficam");
  });
  test("the wizard numbers rows from the data, not through its own counter", () => {
    expect(read("src/components/imports/ImportWizard.tsx")).toContain("mapGrid(");
  });
  test("the wizard locks list name and training once the import exists, and Back after batches were sent", () => {
    const w = read("src/components/imports/ImportWizard.tsx");
    expect(w).toContain("readOnly={locked}");
    expect(w).toContain("disabled={locked}");
    expect(w).toContain("busy || sent > 0");
    expect(w).not.toMatch(/setError\(e instanceof Error \? e\.message/);
  });
});

describe("F3c-2 qualifier screens", () => {
  test("the lead page shows the level drop until ok", () => {
    expect(read("src/app/(app)/leads/[id]/page.tsx")).toContain("LevelNote");
    const note = read("src/components/qualifier/LevelNote.tsx");
    expect(note).toContain("ackLevelNoteAction");
    expect(note).toContain("levelDrop");
  });
  test("the Qualificador card is on AGENTES with Pausar and Ver gastos", () => {
    expect(read("src/app/(app)/agentes/page.tsx")).toContain("QualifierCard");
    const card = read("src/components/qualifier/QualifierCard.tsx");
    expect(card).toContain("seeSpend");
    expect(card).toContain("lines.warning");
    expect(read("src/lib/qualifier/view.ts")).toContain("placesOff");
    expect(card).toContain("Q.pause");
  });
  test("the Qualificador settings are written only by a sender, on the server", () => {
    const a = read("src/app/(app)/agentes/qualifier-actions.ts");
    expect(a).toContain('"use server"');
    expect(a).toContain("requireSender");
    expect(a).toContain("strict()");
  });
  test("no copy names the forbidden site", () => {
    expect(read("src/messages/pt/qualifier.ts").toLowerCase()).not.toContain("linked" + "in");
  });
  test("Gastos is sender-only and linked from the Qualificador card", () => {
    const page = read("src/app/(app)/agentes/gastos/page.tsx");
    expect(page).toContain("requireSender");
    expect(page).toContain("QualifierCapForm");
    expect(read("src/components/qualifier/QualifierCard.tsx")).toContain("/agentes/gastos");
    expect(read("src/components/qualifier/QualifierCard.tsx")).toContain("QualifierCapForm");
    const form = read("src/components/qualifier/QualifierCapForm.tsx");
    expect(form).toContain("setQualifierAction");
    expect(form).toContain("useState");
    expect(read("src/messages/pt/spend.ts").toLowerCase()).not.toContain("linked" + "in");
  });
  test("LEADS asks to confirm the estimate before qualifying", () => {
    const q = read("src/components/qualifier/QualifyControls.tsx");
    for (const w of ["estimateQualifyAction", "estimate", "overDay", "requestQualifyAction"]) expect(q).toContain(w);
    // the request lives in the confirm handler only
    expect(q.split("requestQualifyAction(").length - 1).toBe(1);
    expect(q.indexOf("requestQualifyAction(")).toBeGreaterThan(q.indexOf("const confirm"));
    expect(read("src/components/leads/LeadsTable.tsx")).toContain("QualifyControls");
  });
});

describe("F3c-3 profile card", () => {
  test("approving needs a click; nothing is applied from a page load", () => {
    expect(read("src/app/(app)/leads/perfil/[id]/page.tsx")).not.toContain("approveProfileAction");
    const card = read("src/components/profile/ProfileCard.tsx");
    expect(card).toMatch(/const approve = \(\) =>[\s\S]*approveProfileAction\(/);
    expect(card).toContain('onClick={approve}');
    expect(card).not.toMatch(/useEffect[\s\S]*approveProfileAction/);
  });
  test("the training button shows the estimate", () => {
    const src = read("src/components/profile/TrainButton.tsx");
    expect(src).toContain("t.profile.train");
    expect(src).toContain("estimateUsd");
  });
});

describe("F3c-3 Cobertura tab", () => {
  test("Cobertura is an owner/sdr tab and [Caçar ▸] opens the Caçador with the region filled", () => {
    expect(leadsTabsFor("closer").some((i) => i.href === "/leads/cobertura")).toBe(false);
    expect(leadsTabsFor("closer")).toEqual(LEADS_TABS);
    for (const role of ["owner", "sdr"] as const) expect(leadsTabsFor(role).map((i) => [i.label, i.href])).toContainEqual(["Cobertura", "/leads/cobertura"]);
    expect(read("src/app/(app)/leads/cobertura/page.tsx")).toContain("requireSender");
    expect(read("src/app/(app)/leads/cobertura/actions.ts")).toContain("requireSender");
    expect(read("src/app/(app)/agentes/novo/page.tsx")).toContain("regiao");
    expect(read("src/components/agents/HunterStartForm.tsx")).toContain("defaultRegion");
  });
});
