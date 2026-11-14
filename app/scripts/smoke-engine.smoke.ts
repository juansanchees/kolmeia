// Real-API run of the WHOLE research engine, as production runs it: the real engine (advance, one step per call),
// the real gateway and transport, the real migrations in PGlite (RLS, triggers, reserve_ai_call / settle_ai_call).
// Scenario: the production request of 10/11/2026 that returned 0 companies (Falmouth, MA, careful, US$ 3).
// questions -> plan -> approve -> discover -> collect rounds -> verify, stopped once 5 companies are verified.
// Run: SMOKE_ENV_FILE=<path> SMOKE_LOG=<file> npx vitest run --config scripts/vitest.smoke.config.mts smoke-engine
// Spend: SMOKE_PRIOR_USD (spent earlier in the same investigation) + this run; no call starts once that total is
// above SMOKE_STOP_USD (default 1.20), nor when it plus SMOKE_CALL_ALLOWANCE (0.30) would pass SMOKE_HARD_USD (1.50).
import { writeFileSync } from "node:fs";
import { test } from "vitest";
import { AnthropicTransport } from "@/lib/ai/anthropic-transport";
import { AiTransportFailure } from "@/lib/ai/errors";
import type { AiRequest, AiResponse, AiTransport } from "@/lib/ai/types";
import { approvePlan, createRun, submitAnswers } from "@/lib/research/commands";
import { advance, limitsFromProgress, limitsFromSources, needsAdvance, type EngineDeps } from "@/lib/research/engine";
import type { Answers } from "@/lib/research/types";
import { TestDb, as } from "../tests/db/helpers";
import { SqlResearchStore } from "../tests/engine/sql-store";
import { loadSmokeEnv, redact } from "./smoke-env";
import { logger, recordingClient } from "./smoke-recorder";

loadSmokeEnv();
const LOG = process.env.SMOKE_LOG ?? "smoke-engine.log";
writeFileSync(LOG, "");
const log = logger(LOG);
const PRIOR = Number(process.env.SMOKE_PRIOR_USD ?? 0);
const STOP = Number(process.env.SMOKE_STOP_USD ?? 1.2);
const HARD = Number(process.env.SMOKE_HARD_USD ?? 1.5);
const ALLOWANCE = Number(process.env.SMOKE_CALL_ALLOWANCE ?? 0.3);
const VERIFY_UP_TO = 5;
const USER = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";

test("smoke engine (Falmouth, careful)", async () => {
  const db = await TestDb.create();
  await db.addUser(USER);
  const ws = (await db.query<{ id: string }>(as(USER), "select public.create_workspace('Smoke') as id"))[0].id;
  await db.query(
    as(USER),
    `insert into public.company_profiles (workspace_id, what_we_do, service_area, wanted_work, good_customer, not_wanted)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      ws,
      "Small HVAC contractor in Massachusetts (heat pumps, mini-splits, ductwork) that wants new-construction and multifamily jobs.",
      "Massachusetts (Worcester County, Cape Cod)",
      "{new_construction,multifamily}",
      "Builders and developers with active projects that need HVAC subcontractors",
      "single-room repairs",
    ],
  );
  const store = new SqlResearchStore(db, USER);
  const spent = async () =>
    Number((await db.query<{ s: string }>(as(USER), "select coalesce(sum(cost_usd),0) as s from public.ai_calls where workspace_id = $1", [ws]))[0].s);

  let task = "";
  let last: AiResponse | null = null;
  const real = new AnthropicTransport(recordingClient(process.env.ANTHROPIC_API_KEY ?? "", log, () => task));
  const guarded: AiTransport = {
    async send(req: AiRequest) {
      const total = PRIOR + (await spent());
      if (total > STOP || total + ALLOWANCE > HARD) throw new AiTransportFailure(`smoke stop: total ${total.toFixed(3)}`);
      task = req.task;
      log(`\n=== ${req.task} web=${JSON.stringify(req.web ?? null)} maxTokens=${req.maxTokens}`);
      last = await real.send(req);
      log(`  toolErrors=${JSON.stringify(last.toolErrors)} queries=${JSON.stringify(last.searchQueries)}`);
      return last;
    },
  };
  const deps: EngineDeps = { store, transport: guarded, batchSize: 3 };

  const runId = await createRun(store, ws, {
    request:
      "Construtores pequenos e ativos, com obra nova residencial ou multifamiliar acontecendo agora, que ainda podem precisar de uma empresa de HVAC",
    region: "Falmouth, MA",
    rigor: "careful",
  });

  let i = 0;
  const holder = () => `00000000-0000-4000-8000-${String(i++).padStart(12, "0")}`;
  const step = async () => {
    const before = await spent();
    const prev = (await store.getRun(runId))!;
    const out = await advance(deps, runId, holder());
    const run = (await store.getRun(runId))!;
    const cost = (await spent()) - before;
    const dropped = (run.progress.droppedUrls ?? 0) - (prev.progress.droppedUrls ?? 0);
    log(
      `STEP ${prev.status}/${prev.progress.stage ?? "-"} -> ${out.kind}${out.kind === "ai_error" ? `(${out.code})` : ""} ` +
        `now ${run.status}/${run.progress.stage ?? "-"} rounds=${run.progress.collectRounds ?? 0} empty=${run.progress.emptyRounds ?? 0} ` +
        `cost=$${cost.toFixed(4)} droppedUrls+${dropped} budgetHits=${JSON.stringify(run.progress.budgetHits ?? {})} lastError=${run.progress.lastError ?? "-"}`,
    );
    return { out, run };
  };

  // questions -> answers (first option each) -> plan -> approve
  let { run } = await step();
  if (run.status === "questions" && run.questions?.length) {
    const answers: Answers = {};
    for (const q of run.questions) answers[q.id] = { choices: q.options.slice(0, 1), text: "" };
    log("QUESTIONS", JSON.stringify(run.questions.map((q) => [q.text, q.options[0]])));
    await submitAnswers(store, run, answers);
  }
  ({ run } = await step());
  log("PLAN", JSON.stringify(run.plan));
  await approvePlan(store, run, { rigor: "careful", maxCandidates: 20, maxCostUsd: 3 });

  for (let n = 0; n < 30; n++) {
    run = (await store.getRun(runId))!;
    if (!needsAdvance(run)) break;
    const verified = (await store.listCandidates(runId)).filter((c) => c.verified_at).length;
    if (run.progress.stage === "verify" && verified >= VERIFY_UP_TO) break;
    // production batch is 3; the last batch is trimmed so no more than VERIFY_UP_TO companies are checked
    if (run.progress.stage === "verify") deps.batchSize = Math.min(3, VERIFY_UP_TO - verified);
    const r = await step();
    if (r.out.kind === "ai_error" && /smoke stop/.test(r.run.progress.lastError ?? "")) break;
    if (r.run.progress.lastError === "transport" && (await spent()) + PRIOR > STOP) break;
  }

  // ---- report
  run = (await store.getRun(runId))!;
  const calls = await db.query<Record<string, unknown>>(
    as(USER),
    `select task, status, error, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, web_searches, web_fetches, cost_usd
       from public.ai_calls where workspace_id = $1 order by created_at`,
    [ws],
  );
  log("\n===== CALLS (task | status | in | out | cacheR | cacheW | searches | fetches | cost | error)");
  for (const c of calls) {
    log([c.task, c.status, c.input_tokens, c.output_tokens, c.cache_read_tokens, c.cache_write_tokens, c.web_searches, c.web_fetches, Number(c.cost_usd).toFixed(4), c.error ? redact(String(c.error)) : "-"].join(" | "));
  }
  const sources = await store.listSources(runId);
  log(`\n===== SOURCES (${sources.length})`);
  for (const s of sources) log(`- (${s.kind}/${s.status}) ${s.title} ${s.url ?? "(no url)"} :: ${s.note}`);
  const cands = await store.listCandidates(runId);
  log(`\n===== CANDIDATES (${cands.length})`);
  for (const c of cands) log(`- ${c.name} | ${c.city ?? ""} | ${c.entry_path} | site=${c.website ?? "-"} | found=${c.found_at_url ?? "NONE"} | verified=${Boolean(c.verified_at)} temp=${c.temperature ?? "-"} hook=${c.hook ?? "-"}`);
  const checks = await store.listChecks(runId);
  log(`\n===== CHECKS`);
  for (const c of cands.filter((x) => x.verified_at)) {
    for (const k of checks.filter((x) => x.candidate_id === c.id && x.pass === 1)) {
      log(`- ${c.name} ${k.kind}=${k.result} :: ${k.summary} | evidence=${k.evidence.map((e) => e.url).join(" ")}`);
    }
  }
  const jobs = await store.listJobs(runId);
  log(`\n===== JOBS WITHOUT BUILDER (${jobs.length})`);
  for (const j of jobs) log(`- ${j.address ?? j.project_name} | ${j.job_type ?? ""} | ${j.declared_value_usd ?? "?"} | ${j.source_url}`);
  log(`\n===== PROGRESS ${JSON.stringify({ ...run.progress, seen: undefined })}`);
  log(`===== LIMIT NOTES (preview) ${JSON.stringify([...limitsFromSources(sources).filter((n) => n.kind !== "unverified"), ...limitsFromProgress(run.progress)])}`);
  log(`\nRUN TOTAL $${(await spent()).toFixed(4)}; with prior $${(PRIOR + (await spent())).toFixed(4)}`);
  await db.pg.close();
});
