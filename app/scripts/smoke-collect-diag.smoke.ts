// Real-API diagnosis of "0 companies" (Falmouth, MA, careful): discover -> one collect, with the PRODUCTION web limits
// and continuations, logging the raw content blocks of every request, the model's raw JSON, the URLs the tools
// returned, and for each cited URL whether the seen-URL filter kept or dropped it.
// Run: SMOKE_ENV_FILE=<path> SMOKE_LOG=<file> npx vitest run --config scripts/vitest.smoke.config.mts smoke-collect-diag
// Spend: no call starts once the total is above DIAG_STOP_USD (default 0.45).
import { writeFileSync } from "node:fs";
import { test } from "vitest";
import { AnthropicTransport } from "@/lib/ai/anthropic-transport";
import { AiTransportFailure, isAiError } from "@/lib/ai/errors";
import type { AiCallRecord, AiContext } from "@/lib/ai/gateway";
import { collectCandidates, discoverSources } from "@/lib/ai/tasks";
import type { AiRequest, AiResponse, AiTransport } from "@/lib/ai/types";
import { sanitizeUrl, urlKey } from "@/lib/safe-url";
import { loadSmokeEnv, redact } from "./smoke-env";
import { logger, recordingClient } from "./smoke-recorder";

loadSmokeEnv();
const LOG = process.env.SMOKE_LOG ?? "smoke-collect-diag.log";
writeFileSync(LOG, "");
const log = logger(LOG);
const STOP = Number(process.env.DIAG_STOP_USD ?? 0.45);

let total = 0;
let task = "";
let last: AiResponse | null = null;
const real = new AnthropicTransport(recordingClient(process.env.ANTHROPIC_API_KEY ?? "", log, () => task));
const transport: AiTransport = {
  async send(req: AiRequest) {
    if (total > STOP) throw new AiTransportFailure(`diag stop: spent ${total.toFixed(3)}`);
    task = req.task;
    log(`\n=== ${req.task} web=${JSON.stringify(req.web)} continuations=${req.maxContinuations} maxTokens=${req.maxTokens}`);
    last = await real.send(req);
    return last;
  },
};
const ledger: AiContext["ledger"] = {
  dailyCapUsd: async () => 5,
  spentTodayUsd: async () => total,
  reserve: async (r) => {
    log(`  reserve ${r.task} = $${r.reserveUsd}`);
    return `diag-${r.task}`;
  },
  settle: async (_id: string, r: AiCallRecord) => {
    total += r.costUsd;
    log(`  settle ${r.task} status=${r.status} err=${r.error ? redact(r.error) : "-"} cost=$${r.costUsd.toFixed(4)} total=$${total.toFixed(4)} ${JSON.stringify(r.usage)}`);
  },
  record: async () => {
    throw new Error("diag: reserve/settle only");
  },
};
const ctx = (): AiContext => ({ workspaceId: "diag", runId: null, ledger, transport });

function urlReport(label: string, cited: string[], res: AiResponse | null) {
  const seen = new Set(res?.seenUrls ?? []);
  const fetched = new Set(res?.fetchedUrls ?? []);
  const tried = new Set(res?.triedUrls ?? []);
  log(`  ${label}: tool returned ${seen.size} urls (fetched ${fetched.size}, tried ${tried.size})`);
  for (const u of [...seen].slice(0, 40)) log(`     seen ${u}`);
  for (const raw of cited) {
    const safe = sanitizeUrl(raw);
    const k = safe ? urlKey(safe) : null;
    const verdict = !raw ? "EMPTY" : !safe ? "UNSAFE" : seen.has(k!) ? "kept(seen)" : tried.has(k!) ? "kept(tried)" : "DROPPED(not seen)";
    log(`     cited ${verdict} ${raw}`);
  }
}

const profile = {
  what_we_do: "Small HVAC contractor in Massachusetts (heat pumps, mini-splits, ductwork) that wants new-construction and multifamily jobs.",
  service_area: "Massachusetts (Worcester County, Cape Cod)",
  wanted_work: ["new construction", "multifamily"],
  good_customer: "Builders and developers with active projects that need HVAC subcontractors",
  not_wanted: "single-room repairs",
};
const request =
  "Construtores pequenos e ativos, com obra nova residencial ou multifamiliar acontecendo agora, que ainda podem precisar de uma empresa de HVAC";
const region = "Falmouth, MA";
const plan = {
  summary: "Construtores pequenos com obra nova residencial ou multifamiliar ativa em Falmouth, MA e vilas, achados por alvarás, registros e associações.",
  places: ["Falmouth, MA", "East Falmouth, MA", "North Falmouth, MA", "Woods Hole, MA", "Teaticket, MA", "Mashpee, MA", "Barnstable County, MA"],
  sourceTypes: [
    "Alvarás de construção de Falmouth (portal ou relatórios mensais)",
    "Registro de empresas de MA (Secretary of the Commonwealth)",
    "Licenças de construtor de MA (CSL / HIC)",
    "Associação de construtores de Cape Cod (HBRACC)",
    "Notícias locais (Falmouth Enterprise, Cape Cod Times)",
    "Diretórios e mapas (Google Maps, Houzz)",
  ],
  warnings: ["Falmouth pode não publicar alvarás com o nome da construtora."],
};

test("diag collect", async () => {
  // ---- discover (production limits)
  let sources: Awaited<ReturnType<typeof discoverSources>>["data"] = [];
  try {
    const r = await discoverSources(ctx(), { request, region, plan });
    sources = r.data;
    log(`  discover kept ${r.data.length} sources, dropped ${r.droppedUrls}`);
  } catch (e) {
    log(`  discover FAILED ${isAiError(e) ? e.code : ""} ${redact(String(e))}`);
  }
  log(`  discover RAW JSON: ${last?.text.slice(0, 4000)}`);
  try {
    const raw = JSON.parse(last?.text ?? "{}") as { sources?: { url: string }[] };
    urlReport("discover", (raw.sources ?? []).map((s) => s.url), last);
  } catch {
    log("  discover raw text is not JSON");
  }
  for (const s of sources) log(`     KEPT (${s.kind}/${s.status}) ${s.title} ${s.url ?? "(no url)"} :: ${s.note}`);

  // ---- one collect (production limits)
  last = null;
  try {
    const r = await collectCandidates(ctx(), {
      profile,
      request,
      region,
      plan,
      sources: sources.map((s) => ({ title: s.title, url: s.url, status: s.status, note: s.note })),
      knownNames: [],
      want: 10,
    });
    log(`  collect kept ${r.data.candidates.length} candidates, exhausted=${r.data.exhausted}, dropped ${r.droppedUrls}`);
    for (const c of r.data.candidates) log(`     CAND ${c.name} | site=${c.website ?? "-"} | found=${c.foundAt?.url ?? "NONE"}`);
    for (const s of r.data.sourcesTried) log(`     TRIED (${s.status}) ${s.title} ${s.url ?? "-"} :: ${s.note}`);
  } catch (e) {
    log(`  collect FAILED ${isAiError(e) ? e.code : ""} ${redact(String(e))}`);
  }
  log(`  collect RAW JSON: ${last ? (last as AiResponse).text.slice(0, 5000) : "(none)"}`);
  try {
    const raw = JSON.parse((last as AiResponse | null)?.text ?? "{}") as { candidates?: { found_at: { url: string } }[]; sources_tried?: { url: string }[] };
    urlReport("collect", [...(raw.candidates ?? []).map((c) => c.found_at.url), ...(raw.sources_tried ?? []).map((s) => s.url)], last);
  } catch {
    log("  collect raw text is not JSON");
  }
  log(`\nTOTAL $${total.toFixed(4)}`);
});
