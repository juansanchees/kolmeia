// Real-API smoke test of the research AI gateway (Falmouth, MA): questions -> plan -> discover -> one collect batch
// (<= 5) -> verify (<= 2). Run: npm run smoke (needs SMOKE_ENV_FILE pointing at an env file with the key, and
// SMOKE_LOG for the report). Never prints env values.
//
// Spend: HARD limit US$ 0.80. Before every call the wrapper transport computes the call's worst case with the
// smoke's lowered limits and refuses it when spend so far + worst case would pass the limit; no stage starts once
// spend is above US$ 0.60. Every AI call still goes through the real gateway (reserve -> call -> settle).
import { appendFileSync, writeFileSync } from "node:fs";
import { test } from "vitest";
import { AnthropicTransport } from "@/lib/ai/anthropic-transport";
import { AiTransportFailure, isAiError } from "@/lib/ai/errors";
import type { AiCallRecord, AiContext, AiReservation } from "@/lib/ai/gateway";
import { worstCaseUsd } from "@/lib/ai/pricing";
import { askQuestions, collectCandidates, discoverSources, verifyCompanies, writePlan } from "@/lib/ai/tasks";
import type { AiRequest, AiResponse, AiTransport } from "@/lib/ai/types";
import { CHECKS_BY_RIGOR, type Answers } from "@/lib/research/types";
import { loadSmokeEnv, redact } from "./smoke-env";

loadSmokeEnv();
const LOG = process.env.SMOKE_LOG ?? "smoke-ai.log";
writeFileSync(LOG, "");
const log = (...a: unknown[]) => appendFileSync(LOG, a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n");

const HARD_LIMIT = 0.8;
const NO_START_ABOVE = 0.6;
let total = 0;
const rows: string[][] = [];
let lastSeen: { seen: number; fetched: number; tried: number } = { seen: 0, fetched: 0, tried: 0 };

/** The smoke's own lower limits (one request per call, fewer web uses, shorter output). */
function lowered(req: AiRequest): AiRequest {
  return {
    ...req,
    maxTokens: Math.min(req.maxTokens, req.web ? 10_000 : 8_000),
    maxContinuations: 0,
    web: req.web && {
      ...(req.web.search ? { search: { maxUses: Math.min(req.web.search.maxUses, 2) } } : {}),
      ...(req.web.fetch ? { fetch: { maxUses: Math.min(req.web.fetch.maxUses, 3) } } : {}),
    },
  };
}

const real = new AnthropicTransport(process.env.ANTHROPIC_API_KEY ?? "");
const guarded: AiTransport = {
  async send(req: AiRequest): Promise<AiResponse> {
    const r = lowered(req);
    const worst = worstCaseUsd(r.model, r.maxTokens, r.web, 0);
    if (total + worst > HARD_LIMIT) throw new AiTransportFailure(`smoke hard limit: ${total.toFixed(3)} + worst ${worst} > ${HARD_LIMIT}`);
    const res = await real.send(r);
    lastSeen = { seen: res.seenUrls?.length ?? 0, fetched: res.fetchedUrls?.length ?? 0, tried: res.triedUrls?.length ?? 0 };
    return res;
  },
};

// In-memory ledger with the same reserve/settle contract as the database (no Supabase in the smoke).
const pending = new Map<string, number>();
const ledger: AiContext["ledger"] = {
  dailyCapUsd: async () => HARD_LIMIT,
  spentTodayUsd: async () => total,
  reserve: async (r: AiReservation) => {
    const id = `smoke-${pending.size + rows.length}`;
    pending.set(id, r.reserveUsd);
    return id;
  },
  settle: async (id: string, r: AiCallRecord) => {
    pending.delete(id);
    total += r.costUsd;
    const u = r.usage;
    log(
      `[${r.task}] status=${r.status} err=${r.error ? redact(r.error) : "-"} in=${u.inputTokens} out=${u.outputTokens} cacheR=${u.cacheReadTokens} ` +
        `searches=${u.webSearches} fetches=${u.webFetches} cost=$${r.costUsd.toFixed(4)} total=$${total.toFixed(4)} ${(r.durationMs / 1000).toFixed(1)}s ` +
        `seenUrls=${lastSeen.seen} fetched=${lastSeen.fetched} tried=${lastSeen.tried}`,
    );
  },
  record: async () => {
    throw new Error("smoke: the gateway must use reserve/settle");
  },
};
const ctx = (): AiContext => ({ workspaceId: "smoke", runId: null, ledger, transport: guarded });

async function stage<T>(name: string, fn: () => Promise<{ data: T; costUsd: number; droppedUrls?: number }>, note: (d: T) => string = () => ""): Promise<T | null> {
  if (total > NO_START_ABOVE) {
    rows.push([name, "skipped", "-", `spend ${total.toFixed(3)} > ${NO_START_ABOVE}`]);
    return null;
  }
  const before = total;
  const t = Date.now();
  try {
    const r = await fn();
    rows.push([name, "ok", `$${(total - before).toFixed(4)}`, `${((Date.now() - t) / 1000).toFixed(0)}s; dropped URLs ${r.droppedUrls ?? 0}; ${note(r.data)}`]);
    return r.data;
  } catch (e) {
    const msg = isAiError(e) ? `${e.code}: ${redact(e.message)}` : redact(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    rows.push([name, "FAIL", `$${(total - before).toFixed(4)}`, msg]);
    return null;
  }
}

test("smoke ai", async () => {
  const profile = {
    what_we_do: "Small HVAC contractor in Massachusetts (heat pumps, mini-splits, ductwork) that wants new-construction and multifamily jobs.",
    service_area: "Massachusetts (Worcester County, Cape Cod)",
    wanted_work: ["new construction", "multifamily"],
    good_customer: "Builders and developers with active projects that need HVAC subcontractors",
    not_wanted: "single-room repairs",
  };
  const request = "small home builders with active permits in Falmouth, MA";
  const region = "Falmouth, MA";

  const q = await stage("questions", () => askQuestions(ctx(), { profile, request, region }), (d) => `${d.questions.length} questions`);
  if (!q) return finish();
  const answers: Answers = {};
  for (const x of q.questions) answers[x.id] = { choices: x.options.slice(0, 1), text: "" };

  const plan = await stage("plan", () => writePlan(ctx(), { profile, request, region, rigor: "careful", questions: q.questions, answers, adjustments: [] }), (d) => `${d.places.length} places`);
  if (!plan) return finish();

  const sources = await stage("discover_sources", () => discoverSources(ctx(), { request, region, plan }), (d) => {
    const by: Record<string, number> = {};
    for (const s of d) by[s.status] = (by[s.status] ?? 0) + 1;
    return `sources by status ${JSON.stringify(by)}`;
  });
  if (!sources) return finish();

  const cand = await stage(
    "collect(<=5)",
    () =>
      collectCandidates(ctx(), {
        profile,
        request,
        region,
        plan,
        sources: sources.map((s) => ({ title: s.title, url: s.url, status: s.status, note: s.note })),
        knownNames: [],
        want: 5,
      }),
    (d) => `${d.candidates.length} companies (found_at kept ${d.candidates.filter((c) => c.foundAt).length}); ${d.jobs.length} jobs without builder`,
  );
  let ver: Awaited<ReturnType<typeof verifyCompanies>>["data"] | null = null;
  if (cand && cand.candidates.length) {
    const two = cand.candidates.slice(0, 2);
    ver = await stage(
      "verify(<=2)",
      () =>
        verifyCompanies(ctx(), {
          rigor: "careful",
          kinds: CHECKS_BY_RIGOR.careful,
          profile,
          request,
          today: new Date().toISOString().slice(0, 10),
          companies: two.map((c, i) => ({ ref: `c${i + 1}`, name: c.name, city: c.city, state: c.state, website: c.website, phone: c.phone })),
        }),
      (d) => `refs returned ${d.length}/${Math.min(2, cand.candidates.length)}; results ${d.map((v) => v.checks.map((k) => `${k.kind}=${k.result}`).join(",")).join(" | ")}`,
    );
  }

  log("\n===== SAMPLE =====");
  log("PLAN:", JSON.stringify(plan, null, 1));
  log("SOURCES:\n" + sources.map((s) => `- (${s.kind}/${s.status}) ${s.title} ${s.url ?? "(no url)"} :: ${s.note}`).join("\n"));
  if (cand) {
    log("COMPANIES (exhausted=" + cand.exhausted + "):\n" + cand.candidates.map((c) => `- ${c.name} | ${c.city ?? ""} | ${c.entryPath} | site=${c.website ?? "-"} | found=${c.foundAt?.url ?? "NONE"}`).join("\n"));
    log("JOBS:\n" + cand.jobs.map((j) => `- ${j.address ?? j.projectName} | ${j.jobType ?? ""} | ${j.declaredValueUsd ?? "?"} | ${j.sourceUrl}`).join("\n"));
  }
  if (ver) {
    for (const v of ver) {
      log(`VERIFY ${v.ref}: hook="${v.hook}" permits=${v.permitCount} job=${v.biggestJobAddress} askFor=${v.askForName} (${v.nameConfidence}) phone=${v.phone} phoneSource=${v.phoneSourceUrl} tried=${v.urlsTried.join(" ")}`);
      for (const c of v.checks) log(`   ${c.kind}: ${c.result} - ${c.summary} | evidence=${JSON.stringify(c.evidence).slice(0, 400)}`);
    }
  }
  finish();
});

function finish() {
  log("\n===== TABLE (stage | result | cost | notes) =====");
  for (const r of rows) log(r.join(" | "));
  log(`TOTAL COST: $${total.toFixed(4)} (hard limit ${HARD_LIMIT})`);
  if (pending.size) log(`UNSETTLED RESERVATIONS: ${pending.size}`);
}
