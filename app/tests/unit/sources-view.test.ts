import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_AGENT_SOURCES, estimateLabel, parseAgentSources, parseApolloForm, parseMapsForm, parseShovelsForm, runStatusLabel, runTitle, todayLine } from "@/lib/sources/view";
import { enqueueApolloCore, enqueueMapsCore, enqueueShovelsCore, saveAgentSourcesCore, type SearchRpc } from "@/lib/sources/search";

const WS = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

describe("F3d view", () => {
  test("estimate shows até US$ 0,50 for 50 places and 0,80 for 200", () => {
    expect(estimateLabel("maps", 50)).toBe("até US$ 0,50");
    expect(estimateLabel("maps", 200)).toBe("até US$ 0,80");
    expect(estimateLabel("maps", 10)).toBe("até US$ 0,50");
    expect(estimateLabel("apollo", 1)).not.toContain("US$ 0");
  });

  test("status labels for queued, running, imported, failed, refused", () => {
    expect(runStatusLabel({ status: "queued", error: null })).toBe("na fila");
    expect(runStatusLabel({ status: "running", error: null })).toBe("rodando");
    expect(runStatusLabel({ status: "imported", error: null })).toBe("importada");
    expect(runStatusLabel({ status: "failed", error: "stale" })).toBe("falhou · demorou demais");
    expect(runStatusLabel({ status: "failed", error: "start_unknown" })).toContain("não sei se começou");
    expect(runStatusLabel({ status: "failed", error: "interrupted" })).toBe("falhou · interrompida");
    expect(runStatusLabel({ status: "failed", error: "not_found" })).toBe("falhou · execução sumiu");
    expect(runStatusLabel({ status: "refused", error: "source_cap" })).toBe("recusada · teto atingido");
    expect(runStatusLabel({ status: "refused", error: "disconnected" })).toBe("recusada · chave desconectada");
    for (const code of ["refused", "import_refused", "start_refused", "start_unrecorded", "timeout", "network", "bad_json", "key_unreadable", "unsupported", "bad_state"]) {
      const label = runStatusLabel({ status: "failed", error: code });
      expect(label, code).toMatch(/^falhou · .+/);
      expect(label, code).not.toBe("falhou · erro");
    }
    expect(runStatusLabel({ status: "refused", error: "refused" })).toBe("recusada · chave recusada");
    expect(runStatusLabel({ status: "failed", error: "http_503" })).toBe("falhou · erro do serviço");
    expect(runStatusLabel({ status: "failed", error: null })).toBe("falhou");
    expect(runStatusLabel({ status: "failed", error: "weird <x>" })).toBe("falhou · erro");
  });

  test("today lines: USD for apify, searches for apollo, ? when unknown", () => {
    expect(todayLine({ provider: "apify", today: 1.2, cap: 2 })).toBe("Hoje: US$ 1,20 de 2,00");
    expect(todayLine({ provider: "apollo", today: 3, cap: 20 })).toBe("Hoje: 3 de 20 buscas");
    expect(todayLine({ provider: "apify", today: null, cap: null })).toContain("?");
  });

  test("run title comes from the label or the query", () => {
    expect(runTitle({ kind: "maps", query: { terms: ["a", "b"], location: "Worcester, MA" } })).toBe("a, b · Worcester, MA");
    expect(runTitle({ kind: "maps", query: { terms: ["a"], location: "X", label: "Meu nome" } })).toBe("Meu nome");
    expect(runTitle({ kind: "apollo", query: { locations: ["MA"], naics: ["2362"] } })).toContain("2362");
  });

  test("form validation: 0 or 6 terms, max 0 or 201, NAICS \"23a\" refused", () => {
    const ok = { terms: "construtora\nempreiteira", location: "Worcester, MA", max: "50" };
    expect(parseMapsForm(ok)).toEqual({ ok: true, value: { query: { terms: ["construtora", "empreiteira"], location: "Worcester, MA" }, max: 50 } });
    expect(parseMapsForm({ ...ok, terms: "  \n " }).ok).toBe(false);
    expect(parseMapsForm({ ...ok, terms: "1\n2\n3\n4\n5\n6" }).ok).toBe(false);
    expect(parseMapsForm({ ...ok, terms: "1\n2\n3\n4\n5" }).ok).toBe(true);
    expect(parseMapsForm({ ...ok, max: "0" }).ok).toBe(false);
    expect(parseMapsForm({ ...ok, max: "201" }).ok).toBe(false);
    expect(parseMapsForm({ ...ok, max: "200" }).ok).toBe(true);
    expect(parseMapsForm({ ...ok, max: "5.5" }).ok).toBe(false);
    expect(parseMapsForm({ ...ok, location: " " }).ok).toBe(false);
    expect(parseMapsForm({ ...ok, terms: "x".repeat(81) }).ok).toBe(false);
    expect(parseMapsForm({ ...ok, label: "n".repeat(61) }).ok).toBe(false);
    const a = { locations: "MA", naics: "2362\n23", pages: "2" };
    expect(parseApolloForm(a)).toEqual({ ok: true, value: { query: { locations: ["MA"], naics: ["2362", "23"], pages: 2 }, max: 50 } });
    expect(parseApolloForm({ ...a, naics: "23a" }).ok).toBe(false);
    expect(parseApolloForm({ ...a, naics: "2" }).ok).toBe(false);
    expect(parseApolloForm({ ...a, naics: "236220" }).ok).toBe(true);
    expect(parseApolloForm({ ...a, naics: "2362201" }).ok).toBe(false);
    // Apollo needs a place or a NAICS code
    expect(parseApolloForm({ locations: "", naics: "236220", pages: "1" }).ok).toBe(true);
    expect(parseApolloForm({ locations: "MA", naics: "", pages: "1" }).ok).toBe(true);
    expect(parseMapsForm({ ...ok, max: "" }).ok).toBe(false);
    expect(parseMapsForm({ ...ok, max: undefined }).ok).toBe(false);
    expect(parseApolloForm({ ...a, naics: "1\n2\n3\n4\n5\n6" }).ok).toBe(false);
    expect(parseApolloForm({ ...a, pages: "5" }).ok).toBe(false);
    expect(parseApolloForm({ ...a, pages: "0" }).ok).toBe(false);
    expect(parseApolloForm({ ...a, locations: "1\n2\n3\n4\n5\n6" }).ok).toBe(false);
    expect(parseApolloForm({ locations: "", naics: "", pages: "1" }).ok).toBe(false);
  });

  test("agent sources: maps needs terms and place when on; nothing else needed when off", () => {
    const base = { agent: AGENT, mapsOn: false, mapsTerms: "", mapsLocation: "", mapsMax: "50", apolloOn: false, apolloLocations: "", apolloNaics: "", apolloPages: "1" };
    expect(parseAgentSources(base).ok).toBe(true);
    expect(parseAgentSources({ ...base, mapsOn: true }).ok).toBe(false);
    const on = parseAgentSources({ ...base, mapsOn: true, mapsTerms: "a\nb", mapsLocation: "Boston, MA" });
    expect(on).toMatchObject({ ok: true, value: { maps_on: true, maps_terms: ["a", "b"], maps_location: "Boston, MA", maps_max: 50, apollo_on: false } });
    expect(parseAgentSources({ ...base, apolloNaics: "23a" }).ok).toBe(false);
    expect(parseAgentSources({ ...base, agent: "nope" }).ok).toBe(false);
    expect(parseAgentSources({ ...base, mapsMax: "" }).ok).toBe(false);
    expect(parseAgentSources({ ...base, maps: false, mapsMax: "" }).ok).toBe(true);
    expect(DEFAULT_AGENT_SOURCES.maps_max).toBe(50);
    // a provider that is not connected is left out of the payload (its saved settings stay)
    const only = parseAgentSources({ ...base, apollo: false, mapsOn: true, mapsTerms: "a", mapsLocation: "Boston, MA" });
    expect(only.ok && Object.keys(only.value).sort()).toEqual(["agent", "maps_location", "maps_max", "maps_on", "maps_terms"]);
  });
});

const recorder = (error: { code?: string; message?: string } | null = null) => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc: SearchRpc = async (fn, args) => {
    calls.push({ fn, args });
    return { error };
  };
  return { calls, rpc };
};
const form = { terms: "construtora", location: "Worcester, MA", max: "50" };

describe("F3d search actions (cores)", () => {
  test("maps: enqueue_source_run gets the exact shape; the workspace is the session's", async () => {
    const r = recorder();
    expect(await enqueueMapsCore({ ws: WS, role: "sdr" }, form, { rpc: r.rpc })).toEqual({ ok: true });
    expect(r.calls).toEqual([{ fn: "enqueue_source_run", args: { p_ws: WS, p_kind: "maps", p_query: { terms: ["construtora"], location: "Worcester, MA" }, p_max: 50 } }]);
  });
  test("apollo shape", async () => {
    const r = recorder();
    await enqueueApolloCore({ ws: WS, role: "owner" }, { locations: "MA", naics: "2362", pages: "1" }, { rpc: r.rpc });
    expect(r.calls[0].args).toEqual({ p_ws: WS, p_kind: "apollo", p_query: { locations: ["MA"], naics: ["2362"], pages: 1 }, p_max: 25 });
  });
  test("the closer is refused before any call; bad input never reaches the database", async () => {
    const r = recorder();
    expect(await enqueueMapsCore({ ws: WS, role: "closer" }, form, { rpc: r.rpc })).toEqual({ error: "notAllowed" });
    expect(await enqueueMapsCore({ ws: WS, role: "owner" }, { ...form, max: "0" }, { rpc: r.rpc })).toEqual({ error: "invalid" });
    expect(r.calls).toEqual([]);
  });
  test("source_cap -> capHit, source_not_connected -> notConnected, 42501 -> notAllowed, other -> generic with no message", async () => {
    const run = async (e: { code?: string; message?: string }) => enqueueMapsCore({ ws: WS, role: "owner" }, form, { rpc: recorder(e).rpc });
    expect(await run({ code: "P0001", message: "source_cap" })).toEqual({ error: "capHit" });
    expect(await run({ code: "22023", message: "source_not_connected" })).toEqual({ error: "notConnected" });
    expect(await run({ code: "42501", message: "not allowed" })).toEqual({ error: "notAllowed" });
    expect(await run({ code: "22023", message: "invalid query" })).toEqual({ error: "invalid" });
    expect(await run({ code: "XX000", message: "apify_api_TESTKEY0000 leaked" })).toEqual({ error: "generic" });
  });
  test("saveAgentSources calls set_agent_source_settings with the 8 known keys only", async () => {
    const r = recorder();
    const res = await saveAgentSourcesCore(
      { ws: WS, role: "sdr" },
      { agent: AGENT, mapsOn: true, mapsTerms: "a", mapsLocation: "Boston, MA", mapsMax: "30", apolloOn: true, apolloLocations: "MA", apolloNaics: "2362", apolloPages: "2" },
      { rpc: r.rpc },
    );
    expect(res).toEqual({ ok: true });
    expect(r.calls[0]).toEqual({
      fn: "set_agent_source_settings",
      args: { p_agent: AGENT, p: { maps_on: true, maps_terms: ["a"], maps_location: "Boston, MA", maps_max: 30, apollo_on: true, apollo_locations: ["MA"], apollo_naics: ["2362"], apollo_pages: 2 } },
    });
    expect(await saveAgentSourcesCore({ ws: WS, role: "closer" }, { agent: AGENT }, { rpc: r.rpc })).toEqual({ error: "notAllowed" });
  });
});

describe("F3d routes", () => {
  test("routes: /leads/buscar is sender-only (page and actions), and the closer never sees the buttons", () => {
    expect(read("src/app/(app)/leads/buscar/page.tsx")).toContain("requireSender()");
    const actions = read("src/app/(app)/leads/buscar/actions.ts");
    expect(actions).toContain('"use server"');
    expect(actions).toContain("isSender");
    const leads = read("src/app/(app)/leads/page.tsx");
    expect(leads).toContain("isSender");
    expect(leads).toContain("connectedSources");
    expect(read("src/components/leads/LeadsTable.tsx")).toContain("t.sources.search.maps");
  });
  test("the agent page embeds AgentSources", () => {
    expect(read("src/app/(app)/agentes/[id]/page.tsx")).toContain("AgentSources");
  });
  test("shovels form: MA place (blank = whole state), preset tag, 1..100 records; month line; enqueue sends kind shovels", async () => {
    expect(parseShovelsForm({ place: " Worcester ", tag: "hvac", max: "25", label: "" })).toEqual({ ok: true, value: { query: { place: "Worcester", tag: "hvac" }, max: 25 } });
    expect(parseShovelsForm({ place: "", tag: "", max: "10" })).toEqual({ ok: true, value: { query: { place: "", tag: "all" }, max: 10 } });
    expect(parseShovelsForm({ place: "90210", tag: "all", max: "10" }).ok).toBe(false);
    expect(parseShovelsForm({ place: "Boston", tag: "solar", max: "10" }).ok).toBe(false);
    expect(parseShovelsForm({ place: "Boston", tag: "all", max: "101" }).ok).toBe(false);
    expect(todayLine({ provider: "shovels", today: 120, cap: 500 })).toBe("120 de 500 usados este mês");
    expect(runTitle({ kind: "shovels", query: { place: "", tag: "new_construction" } })).toBe("MA · Obra nova");
    const calls: unknown[] = [];
    const rpc: SearchRpc = async (fn, args) => (calls.push([fn, args]), { error: null });
    expect(await enqueueShovelsCore({ ws: WS, role: "sdr" }, { place: "01602", tag: "all", max: "5" }, { rpc })).toEqual({ ok: true });
    expect(calls).toEqual([["enqueue_source_run", { p_ws: WS, p_kind: "shovels", p_query: { place: "01602", tag: "all" }, p_max: 5 }]]);
    expect(await enqueueShovelsCore({ ws: WS, role: "closer" }, { place: "01602", tag: "all", max: "5" }, { rpc })).toEqual({ error: "notAllowed" });
  });

  test("no copy or code mentions the banned network name", () => {
    for (const f of ["src/messages/pt/sources.ts", "src/lib/sources/view.ts", "src/lib/sources/search.ts", "src/lib/sources/shovels.ts"]) expect(read(f).toLowerCase(), f).not.toContain("linked" + "in");
  });
});
