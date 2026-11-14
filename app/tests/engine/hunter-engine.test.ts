import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { advance, needsAdvance, type EngineDeps } from "@/lib/research/engine";
import { approvePlan, createRun, submitAnswers } from "@/lib/research/commands";
import { nameKey } from "@/lib/research/dedupe";
import { HunterResearchStore } from "@/lib/hunter/research-store";
import type { RunRow } from "@/lib/research/rows";
import { TestDb, setSchedulerToken, UUID_A } from "../db/helpers";
import { TOKEN } from "../db/scheduler-seed";
import { beginTick, seedHunter } from "../db/hunter-seed";
import { FakeTransport } from "./fake-ai";
import { cand, happyTransport, discoverJson, planJson, questionsJson, verifyJson, secondJson } from "./fake-research";
import { pgRpc } from "./pg-rpc";
import { SqlResearchStore } from "./sql-store";

// F3b Task 3: the unchanged engine, driven with no user session through the hunter path (fake AI, PGlite, real migrations).

const NOW = new Date("2026-11-14T12:00:00Z");
const user = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
const ZERO = "00000000-0000-4000-8000-000000000000";

let db: TestDb;
let nextUser = 500;
const rpc = () => pgRpc(db, TOKEN);
let openTick: string | null = null;

beforeAll(async () => {
  db = await TestDb.create();
  await setSchedulerToken(db, TOKEN);
});
afterEach(async () => {
  if (openTick) await rpc()("hunter_finish_tick", { p_tick: openTick, p_counts: {}, p_error: null });
  openTick = null;
});
afterAll(async () => {
  await db.pg.close();
});

/** A running strict hunter in its own workspace with its first run created by the clock, and an open tick. */
async function hunter(rigor: "quick" | "careful" | "strict" = "strict") {
  const userId = user(nextUser++);
  const seed = await seedHunter(db, { userId, rigor, schedule: "weekly" });
  // the setup plan the runs are copied from (what the AI wrote when Juan approved it)
  await db.admin("update public.research_runs set plan = $2::jsonb where id = $1", [
    seed.setupRun,
    JSON.stringify({ summary: "Construtores ativos", places: ["Worcester County, MA"], sourceTypes: ["Portais de alvarás"], warnings: [] }),
  ]);
  const tick = await beginTick(db);
  openTick = tick;
  await rpc()("hunter_due_work", { p_tick: tick });
  const run = (await db.admin<{ id: string }>("select id from public.research_runs where agent_id = $1", [seed.agent]))[0].id;
  return { ...seed, userId, tick, run };
}

async function drive(deps: EngineDeps, tick: string, runId: string, max = 40): Promise<RunRow> {
  let run = (await deps.store.getRun(runId))!;
  for (let i = 0; i < max && needsAdvance(run); i++) {
    const out = await advance(deps, runId, tick);
    if (out.kind === "busy" || out.kind === "not_found") throw new Error(out.kind);
    run = out.run;
    if (out.kind === "ai_error" && ["not_configured", "daily_cap", "user_cap", "global_cap"].includes(out.code)) break;
  }
  return run;
}

const deps = (store: HunterResearchStore, transport: FakeTransport): EngineDeps => ({ store, transport, now: () => NOW, batchSize: 3 });

/** A verified one-off candidate (so a lead) written by the admin, as an old search would have left it. */
async function seedLead(ws: string, name: string, extra: { website?: string; phone?: string; lastSeen?: string } = {}) {
  const [run] = await db.admin<{ id: string }>(
    "insert into public.research_runs (workspace_id, title, request_text, region_text, rigor) values ($1,'Old search','pedido','Worcester, MA','careful') returning id",
    [ws],
  );
  await db.admin(
    "insert into public.research_candidates (workspace_id, run_id, name, name_key, website, phone, verified_at) values ($1,$2,$3,$4,$5,$6, now())",
    [ws, run.id, name, nameKey(name), extra.website ?? null, extra.phone ?? null],
  );
  if (extra.lastSeen) {
    await db.admin("update public.leads set last_seen_at = $2 where best_candidate_id in (select id from public.research_candidates where run_id = $1)", [run.id, extra.lastSeen]);
  }
}

describe("HunterResearchStore", () => {
  test("a full Caçador run reaches done with no user session, and its verified companies are in LEADS", async () => {
    const h = await hunter("strict");
    const fake = happyTransport();
    const d = deps(new HunterResearchStore(rpc(), h.tick), fake);
    const run = await drive(d, h.tick, h.run);
    expect(run.status).toBe("done");
    expect(run.partial_reason, "partial").toBeNull();
    expect(run.is_partial).toBe(false);
    expect(fake.calls.map((c) => c.task)).toEqual(["research_discover", "research_collect", "research_verify", "research_second_pass"]);

    const cands = await db.admin<{ id: string; name: string; verified_at: string | null; second_pass: string | null }>(
      "select id, name, verified_at, second_pass from public.research_candidates where run_id = $1",
      [h.run],
    );
    expect(cands.map((c) => c.name).sort()).toEqual(["Acme Builders, Inc.", "Beta Homes LLC", "Gamma Construction"]);
    const leads = await db.admin<{ best_candidate_id: string; origin_kind: string; origin_agent_id: string; origin_run_id: string }>(
      "select best_candidate_id, origin_kind, origin_agent_id, origin_run_id from public.leads where workspace_id = $1",
      [h.ws],
    );
    const verified = cands.filter((c) => c.verified_at);
    expect(verified.length).toBeGreaterThan(0);
    expect(leads.map((l) => l.best_candidate_id).sort()).toEqual(verified.map((c) => c.id).sort());
    for (const l of leads) expect(l).toMatchObject({ origin_kind: "agent", origin_agent_id: h.agent, origin_run_id: h.run });
    // every checked company has proof behind it
    const ev = await db.admin<{ n: string }>("select count(*) as n from public.research_evidence e join public.research_checks k on k.id = e.check_id where k.run_id = $1", [h.run]);
    expect(Number(ev[0].n)).toBeGreaterThan(0);

    const calls = await db.admin<{ user_id: string; status: string; task: string }>("select user_id, status, task from public.ai_calls where run_id = $1", [h.run]);
    expect(calls).toHaveLength(4);
    for (const c of calls) expect(c).toMatchObject({ user_id: h.userId, status: "ok" });
    expect(run.spent_cost_usd).toBeGreaterThan(0);
  });

  test("C4 a scheduled run skips companies already in LEADS and says how many; a one-off run does not skip", async () => {
    const h = await hunter("strict");
    await seedLead(h.ws, "Acme Builders", { website: "https://acmebuilders.example" });
    const collect = () => ({
      candidates: [
        cand("ACME BUILDERS, Inc.", "https://acme-new-site.example", "(508) 555-0301"),
        cand("Zeta Mechanical", "https://zeta.example", "(508) 555-0302"),
        cand("Eta Homes", "https://eta.example", "(508) 555-0303"),
      ],
      jobs_without_builder: [],
      sources_tried: [],
      exhausted: true,
    });
    const handlers: ConstructorParameters<typeof FakeTransport>[0] = {
      research_questions: () => ({ json: { ...questionsJson, questions: [] } }),
      research_plan: () => ({ json: planJson }),
      research_discover: () => ({ json: discoverJson }),
      research_collect: () => ({ json: collect() }),
      research_verify: (r) => ({ json: verifyJson(r) }),
      research_second_pass: (r) => ({ json: secondJson(r) }),
    };
    const transport = () => new FakeTransport(handlers);

    const run = await drive(deps(new HunterResearchStore(rpc(), h.tick), transport()), h.tick, h.run);
    expect(run.status).toBe("done");
    const names = (await db.admin<{ name: string }>("select name from public.research_candidates where run_id = $1", [h.run])).map((c) => c.name).sort();
    expect(names).toEqual(["Eta Homes", "Zeta Mechanical"]);
    expect(run.progress.alreadyKnown).toBe(1);
    expect(run.limits_notes.find((n) => n.kind === "merged" && /já estavam em LEADS/.test(n.text))?.text).toBe(
      "1 empresa(s) já estavam em LEADS e foram puladas: este agente só traz empresas novas.",
    );

    // the same fake on a one-off search keeps all three: only agent runs skip
    const store = new SqlResearchStore(db, h.userId);
    const oneOff = await createRun(store, h.ws, { request: "Construtores perto de Worcester", region: "Worcester County, MA", rigor: "strict" });
    const od: EngineDeps = { store, transport: transport(), now: () => NOW, batchSize: 3 };
    let r = (await store.getRun(oneOff))!;
    for (let i = 0; i < 40 && needsAdvance(r); i++) {
      const out = await advance(od, oneOff, `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
      if (out.kind === "busy" || out.kind === "not_found") throw new Error(out.kind);
      r = out.run;
      if (r.status === "questions" && r.questions !== null && r.questions.length) await submitAnswers(store, r, {});
      if (r.status === "plan" && r.plan) await approvePlan(store, r, { rigor: "strict", maxCandidates: 25, maxCostUsd: 4 });
      r = (await store.getRun(oneOff))!;
    }
    expect(r.status).toBe("done");
    expect(r.progress.alreadyKnown).toBeUndefined();
    expect((await store.listCandidates(oneOff)).map((c) => c.name).sort()).toEqual(["ACME BUILDERS, Inc.", "Eta Homes", "Zeta Mechanical"]);
  });

  test("C5 a cap hit pauses the run and spends nothing more", async () => {
    const h = await hunter("strict");
    await db.admin("insert into public.workspace_settings (workspace_id, ai_daily_cap_usd) values ($1, 0.01) on conflict (workspace_id) do update set ai_daily_cap_usd = 0.01", [h.ws]);
    const fake = happyTransport();
    const run = await drive(deps(new HunterResearchStore(rpc(), h.tick), fake), h.tick, h.run);
    expect(run.status).toBe("paused");
    expect(run.progress.pauseReason).toBe("daily_cap");
    expect(fake.calls).toHaveLength(0);
    const pending = await db.admin<{ n: string }>("select count(*) as n from public.ai_calls where run_id = $1 and status = 'pending'", [h.run]);
    expect(Number(pending[0].n)).toBe(0);
    const total = await db.admin<{ n: string }>("select count(*) as n from public.ai_calls where run_id = $1", [h.run]);
    expect(Number(total[0].n)).toBe(0);
  });

  test("the collect prompt lists at most 150 known lead names", async () => {
    const h = await hunter("strict");
    for (let i = 1; i <= 160; i++) {
      const n = String(i).padStart(3, "0");
      // 001 is the newest lead, 160 the oldest
      await seedLead(h.ws, `Known Co ${n}`, { lastSeen: new Date(NOW.getTime() - i * 60_000).toISOString() });
    }
    const fake = new FakeTransport({
      research_discover: () => ({ json: discoverJson }),
      research_collect: () => ({ json: { candidates: [cand("Fresh Own Co", "https://fresh.example", "(508) 555-0401")], jobs_without_builder: [], sources_tried: [], exhausted: true } }),
      research_verify: (r) => ({ json: verifyJson(r) }),
      research_second_pass: (r) => ({ json: secondJson(r) }),
    });
    await drive(deps(new HunterResearchStore(rpc(), h.tick), fake), h.tick, h.run);
    const req = fake.callsFor("research_collect")[0];
    const listed = new Set([...req.user.matchAll(/Known Co (\d{3})/g)].map((m) => m[1]));
    expect(listed.size).toBe(150);
    expect(listed.has("001")).toBe(true);
    expect(listed.has("150")).toBe(true);
    expect(listed.has("151")).toBe(false);
  });

  test("HunterResearchStore refuses what the hunter path does not offer", async () => {
    const h = await hunter("quick");
    const store = new HunterResearchStore(rpc(), h.tick);
    await expect(store.createRun({ workspaceId: h.ws, title: "x", requestText: "x", regionText: "x", rigor: "quick", maxCandidates: 1, maxCostUsd: 1, maxMinutes: 1 })).rejects.toThrow("not_on_hunter_path");
    await expect(store.createList(h.run, "x")).rejects.toThrow("not_on_hunter_path");
    await expect(store.dailyCapUsd(h.ws)).rejects.toThrow("not_on_hunter_path");
    await expect(store.spentTodayUsd(h.ws)).rejects.toThrow("not_on_hunter_path");
    await expect(
      store.record({ workspaceId: h.ws, runId: h.run, task: "research_verify", model: "x" as never, promptVersion: "v", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, webFetches: 0 }, costUsd: 0, status: "ok", error: null, durationMs: 0 }),
    ).rejects.toThrow("not_on_hunter_path");
    await expect(store.claimStep(h.run, ZERO, 60)).rejects.toThrow();
    await expect(store.claimStep(h.run, UUID_A, 60)).rejects.toThrow();
    // a candidate the store never listed or inserted cannot be touched
    await expect(store.updateCandidate(ZERO, {})).rejects.toThrow("unknown_candidate");
    // with its own tick the store can claim
    expect(await store.claimStep(h.run, h.tick, 60)).toBe(true);
    await store.releaseStep(h.run, h.tick);
  });
});
