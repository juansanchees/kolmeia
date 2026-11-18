// Falmouth pilot round runner (LOCAL Supabase). One run = one NEW round of one campaign (it opens its own: the app closes
// every round it opens). Run: npm run pilot:round
// Env: PILOT_RUN=1, PILOT_CAMPAIGN_ID, PILOT_SERVICE_KEY, PILOT_ANON_KEY, PILOT_OUT_DIR (needs local-seed.json from pilot:seed),
//      optional PILOT_WORKSPACE_ID, PILOT_DATA_DIR, PILOT_LIVE=1 (real site reads through readSite; off = recorded as `live off`).
// No paid AI: the offer rule, gap lookups and hook are deterministic. The gold list is never read here. Prints counts only.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reduceCoverage, type CoverageRow } from "@/lib/kb/coverage";
import { resolveGaps, type GapDeps, type GapOpp } from "@/lib/kb/gaps";
import { falmouthPermitItems, mapsItems, massbuildsProjectItems, type PermitMemo } from "@/lib/kb/load";
import type { KbItem } from "@/lib/kb/types";
import { supabaseHuntDb } from "@/lib/hunt/db";
import { effectiveParams, rescore } from "@/lib/hunt/rescore";
import { openRunnerRound } from "@/lib/hunt/flow";
import { runnerBlockers, stopReason, summarizeRound } from "@/lib/hunt/rounds";
import { agentReply } from "@/lib/hunt/text";
import { fill } from "@/messages/fill";
import { pt } from "@/messages/pt";
import { classifyBuilding } from "@/lib/offers/hvac-new-construction";
import { getOffer, toOpportunityRow, type CampaignParams, type OfferInput, type OfferSignal } from "@/lib/offers";
import { nameKey } from "@/lib/research/dedupe";
import { nodeRawHttp } from "@/lib/qualifier/site/net";
import { readSite } from "@/lib/qualifier/site/reader";
import { adminClient, need, pilotDataDir, pilotOutDir, readSeed, userClient } from "./pilot-env";
import { ingestLinks, linkItem, permitNoHits, type KbHit } from "./pilot-link";

const TOWN = "Falmouth";
const LIST_NAME = "Piloto Falmouth · HVAC obra nova";
type Co = { id: string; name: string; name_key: string; domain: string | null; phone: string | null; address: string | null; city: string | null; state: string | null; zip: string | null; company_type: string | null };
type Sig = { id: string; company_id: string | null; kind: "permit" | "project"; source: string; source_ref: string; address: string | null; town: string | null; value_usd: number | string | null; work_class: string | null; use: string | null; issued_on: string | null; description: string | null; source_url: string | null; applicant_name: string | null; permit_no: string | null; link_status: "confirmed" | "pending" | "none" };

const must = <T>(r: { data: T; error: { message: string } | null }, what: string): NonNullable<T> => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as NonNullable<T>;
};
const chunks = <T>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));
const nn = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "")) as T;

async function readAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, what: string): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += 1000) {
    const rows = must(await page(from, from + 999), what) ?? [];
    all.push(...rows);
    if (rows.length < 1000) return all;
  }
}

function noteOf(sigs: Sig[]): string {
  const dmy = (d: string | null) => (d ? d.slice(0, 10).split("-").reverse().join("/") : "?");
  const lines = [...sigs].sort((a, b) => (b.issued_on ?? "").localeCompare(a.issued_on ?? "")).slice(0, 3).map((s) =>
    `${s.kind === "permit" ? "Alvará" : "Projeto"} ${dmy(s.issued_on)} · ${[s.address, s.town].filter(Boolean).join(", ")}${s.value_usd != null ? ` · US$ ${Math.round(Number(s.value_usd)).toLocaleString("pt-BR")}` : ""} · ${[s.work_class, s.use].filter(Boolean).join("/")}`);
  return [...lines, "Fonte: base Kolmeia (alvarás e projetos públicos)"].join("\n").slice(0, 1000);
}

test.skipIf(process.env.PILOT_RUN !== "1")("pilot round", async () => {
  const t0 = Date.now();
  const now = new Date();
  const seenAt = now.toISOString();
  const live = process.env.PILOT_LIVE === "1";
  const data = pilotDataDir();
  const out = pilotOutDir();
  const seed = readSeed(out);
  const ws = process.env.PILOT_WORKSPACE_ID || seed.workspace_id;
  const campaignId = need("PILOT_CAMPAIGN_ID");
  const svc = adminClient();
  const user = await userClient(seed.user_email, seed.user_password);
  const hunt = supabaseHuntDb(user);

  const camp = must(await user.from("hunt_campaigns").select("id, workspace_id, offer, params").eq("id", campaignId).single(), "campaign") as { id: string; workspace_id: string; offer: string; params: CampaignParams };
  if (camp.workspace_id !== ws) throw new Error("campaign does not belong to PILOT_WORKSPACE_ID");
  const offer = getOffer(camp.offer);
  const round = await openRunnerRound(hunt, campaignId);
  const approved = await hunt.approvedRules(ws, camp.offer);
  const params = effectiveParams(camp.params, approved);
  const before = await hunt.campaignOpps(campaignId);

  // 1. load Falmouth rows from the private CSVs (coverage row per source)
  const cov: CoverageRow[] = [];
  const addCov = (source: string, outcome: CoverageRow["outcome"], queried: number, rows_in: number, reason?: string) =>
    cov.push({ town: TOWN, source, ran_at: new Date().toISOString(), outcome, queried, rows_in, ...(reason ? { reason } : {}) });
  const readOpt = (rel: string) => (existsSync(path.join(data, rel)) ? readFileSync(path.join(data, rel), "utf8") : null);
  const items: KbItem[] = [];
  const mapsCsv = readOpt("ma_sweep/maps/universe.csv");
  if (mapsCsv) {
    // whole statewide builder universe: firms work across towns (mapsItems keeps only builder categories)
    const m = mapsItems(mapsCsv, seenAt);
    items.push(...m.items);
    addCov("maps_robot", m.items.length ? "ok" : "empty", m.items.length + Object.values(m.skipped).reduce((a, b) => a + b, 0), m.items.length);
  } else addCov("maps_robot", "skipped", 0, 0, "no maps file");
  const projCsv = readOpt("ma_sweep/projects/projects_massbuilds.csv");
  if (projCsv) {
    const p = massbuildsProjectItems(projCsv, TOWN);
    items.push(...p.items);
    addCov("project", p.items.length ? "ok" : "empty", p.items.length, p.items.length);
  } else addCov("project", "skipped", 0, 0, "no projects file");
  let memo: Record<string, PermitMemo> = {};
  const permitCsv = readOpt("permits_2026/falmouth.csv");
  if (permitCsv) {
    const p = falmouthPermitItems(permitCsv);
    memo = p.memo;
    // the file has every trade: only permits the offer rule does not reject enter the base
    const kept = p.items.filter((it) => {
      const s = it.signals?.[0];
      return s && offer.evaluate({ signal: s as OfferSignal, company: null, link_status: "none", contacts: {} }, now, params).fit !== "no";
    });
    items.push(...kept);
    addCov("permit", kept.length ? "ok" : "empty", p.items.length, kept.length);
  } else addCov("permit", "skipped", 0, 0, "no permit file");
  if (!live) addCov("permit_portal", "skipped", 0, 0, "live off");

  // 2. kb_ingest (<= 500 per call)
  const ing = { created: 0, matched: 0, signals: 0, signals_unlinked: 0, signals_pending: 0 };
  for (const b of chunks(items, 500)) {
    const r = must(await svc.rpc("kb_ingest", { p_items: b }), "kb_ingest") as Record<string, number>;
    for (const k of Object.keys(ing) as (keyof typeof ing)[]) ing[k] += Number(r[k] ?? 0);
  }

  // 3. read back Falmouth signals and their companies
  const sigs = await readAll<Sig>((a, z) => svc.from("kb_signals").select("id, company_id, kind, source, source_ref, address, town, value_usd, work_class, use, issued_on, description, source_url, applicant_name, permit_no, link_status").ilike("town", TOWN).order("id").range(a, z), "signals");
  const coIds = [...new Set(sigs.map((s) => s.company_id).filter((x): x is string => !!x))];
  const cos = new Map<string, Co>();
  for (const part of chunks(coIds, 200)) for (const c of must(await svc.from("kb_companies").select("id, name, name_key, domain, phone, address, city, state, zip, company_type").in("id", part), "companies") as Co[]) cos.set(c.id, c);

  // 4. gaps: lookups against the base; the site read only when PILOT_LIVE=1
  const hitOf = (c: Co): KbHit => nn({ id: c.id, name: c.name, phone: c.phone ?? undefined, website: c.domain ? `https://${c.domain}` : undefined }) as KbHit;
  const known = new Map<string, Co>(cos);
  const lookup = async (q: (db: SupabaseClient) => PromiseLike<{ data: Co[] | null; error: { message: string } | null }>) => must(await q(svc), "lookup").map((c) => (known.set(c.id, c), hitOf(c)));
  const cols = "id, name, name_key, domain, phone, address, city, state, zip, company_type";
  const siteDeps = { http: nodeRawHttp, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), now: () => Date.now(), gaps: new Map<string, number>() };
  const deps: GapDeps = {
    live,
    now: () => new Date(),
    readSite: (website) => readSite(website, siteDeps),
    byPermitNo: (no, town) => permitNoHits({
      signalCompanyIds: async (n, t) => must(await svc.from("kb_signals").select("company_id").eq("permit_no", n).ilike("town", t).not("company_id", "is", null).limit(10), "permit no lookup").map((r) => r.company_id as string),
      companies: (ids) => lookup((db) => db.from("kb_companies").select(cols).in("id", ids).is("removed_at", null) as never),
    }, no, town),
    byPhone: (k) => lookup((db) => db.from("kb_companies").select(cols).eq("phone_key", k).is("removed_at", null).limit(5) as never),
    byNameStatewide: (k) => lookup((db) => db.from("kb_companies").select(cols).eq("name_key", k).is("removed_at", null).limit(5) as never),
    byNameTown: (k, town) => lookup((db) => db.from("kb_companies").select(cols).eq("name_key", k).ilike("city", town).is("removed_at", null).limit(5) as never),
  };
  type Done = { sig: Sig; co: Co | null; input: OfferInput; row: ReturnType<typeof toOpportunityRow>; v: ReturnType<typeof offer.evaluate>; linkVia?: string; pending: number };
  const links: ReturnType<typeof linkItem>[] = [];
  const done: Done[] = [];
  let noFit = 0;
  for (const s of sigs) {
    const co = (s.company_id && cos.get(s.company_id)) || null;
    const sig = nn({ kind: s.kind, source: s.source, source_ref: s.source_ref, address: s.address, town: s.town, value_usd: s.value_usd == null ? null : Number(s.value_usd), work_class: s.work_class, use: s.use, issued_on: s.issued_on, description: s.description, source_url: s.source_url }) as OfferSignal;
    const m = memo[s.source_ref];
    const opp: GapOpp = { signal: { ...sig, permit_no: s.permit_no }, company: co ? hitOf(co) : null, link_status: s.link_status, contacts: {}, applicant: nn({ name: m?.applicantName ?? s.applicant_name ?? undefined, contractor: m?.contractorName, phone: m?.applicantPhone }) };
    const g = await resolveGaps(opp, deps, params);
    cov.push(...g.coverage);
    const linked = g.link?.status === "confirmed" ? (g.company as KbHit | null) : co ? hitOf(co) : null;
    const input: OfferInput = { signal: sig, company: g.company ? nn({ name: g.company.name, phone: g.company.phone, website: g.company.website }) as OfferInput["company"] : null, link_status: g.link?.status ?? s.link_status, contacts: g.contacts, ...(g.link?.note ? { link_note: g.link.note } : {}) };
    const v = offer.evaluate(input, now, params);
    if (v.fit === "no") { noFit++; continue; }
    const linkedCo = linked ? known.get(linked.id) ?? ({ id: linked.id, name: linked.name, name_key: nameKey(linked.name), domain: null, phone: linked.phone ?? null, address: null, city: null, state: null, zip: null, company_type: null } as Co) : null;
    // a unique company found by the gap lookups is written back, so the signal is confirmed and the next round reuses it
    if (g.link?.status === "confirmed" && linkedCo && s.link_status !== "confirmed") links.push(linkItem(s, linkedCo));
    done.push({ sig: s, co: linkedCo, input, row: { ...toOpportunityRow(v, offer.id, input, params, s.id), campaign_id: campaignId } as never, v, pending: g.link?.status === "pending" ? (g.link.candidates?.length ?? 0) : 0 });
  }

  if (!sigs.some((s) => s.permit_no)) cov.push({ town: TOWN, source: "kb_match:permit_no", ran_at: new Date().toISOString(), outcome: "skipped", queried: 0, rows_in: 0, reason: "no signal carries a permit number" });
  const linksWritten = await ingestLinks(async (b) => must(await svc.rpc("kb_ingest", { p_items: b }), "kb_ingest links"), links);

  // 5-6. deliver into the workspace (company-less signals stay in the report: kb_deliver needs a company)
  const byCo = new Map<string, Done[]>();
  for (const d of done) if (d.co) byCo.set(d.co.id, [...(byCo.get(d.co.id) ?? []), d]);
  const rows = [...byCo.values()].map((ds, i) => {
    const c = ds[0].co!;
    return nn({ row: i + 1, kb_company_id: c.id, name: c.name, name_key: c.name_key, website: c.domain ? `https://${c.domain}` : undefined, phone: c.phone ?? undefined, address: c.address, city: c.city, state: c.state, zip: c.zip, company_type: c.company_type, note: noteOf(ds.map((d) => d.sig)), opportunities: ds.slice(0, 20).map((d) => d.row) });
  });
  if (rows.length > 5000) throw new Error("too many companies for one import (5000)");
  const dl = { new: 0, merged: 0, errors: 0, skipped_linked: 0 };
  let importId: string | null = null;
  for (const b of chunks(rows, 500)) {
    const r = must(await svc.rpc("kb_deliver", { p_ws: ws, p_import: importId, p_list_name: LIST_NAME, p_rows: b }), "kb_deliver") as Record<string, unknown>;
    importId = r.import_id as string;
    for (const k of Object.keys(dl) as (keyof typeof dl)[]) dl[k] += Number(r[k] ?? 0);
  }
  if (importId) must(await svc.rpc("kb_deliver_finish", { p_import: importId }), "kb_deliver_finish");

  // relevant work with no confirmed company: not deliverable (a lead needs a company), but never silent: the round file, the eval and the round blockers carry it
  const noCo = done.filter((d) => !d.co);
  const dbCand = new Map<string, number>();
  for (const part of chunks(noCo.map((d) => d.sig.id), 200)) for (const r of must(await svc.from("kb_signal_candidates").select("signal_id").in("signal_id", part), "candidates")) dbCand.set(r.signal_id as string, (dbCand.get(r.signal_id as string) ?? 0) + 1);
  const unlinked = noCo.map((d) => ({
    signal_ref: `${d.sig.source}:${d.sig.source_ref}`, source_url: d.sig.source_url ?? undefined, issued_on: d.sig.issued_on ?? undefined, work: classifyBuilding(d.input.signal), work_class: d.sig.work_class ?? undefined,
    fit: d.v.fit, link_status: d.sig.link_status, candidates: Math.max(d.pending, dbCand.get(d.sig.id) ?? 0), priority: d.v.priority,
    open_questions: [...new Set(["ask_gc", ...d.v.openQuestions])],
  }));

  // 7. rescore this campaign's opportunities (campaign params + approved preferences), then finish the round
  const stored = await hunt.campaignOpps(campaignId);
  const scores = rescore(stored, camp.offer, camp.params, approved, now);
  const rc = reduceCoverage(cov);
  const blockers = runnerBlockers(rc, unlinked.length);
  const summary = summarizeRound(before, scores.map((s) => ({ id: s.opportunity_id, priority: s.priority })), rc, blockers);
  // a single deterministic pass is the whole round: nothing more to run, so it ends waiting (live steps skipped) or exhausted
  const stop = stopReason({ fulfilled: false, spentUsd: 0, limitUsd: 1, elapsedMs: Date.now() - t0, limitMs: 15 * 60_000, newEvidence: false, waitingSteps: rc.filter((c) => c.reason?.includes("live off")).length }) ?? "exhausted";
  must(await user.rpc("hunt_round_finish", { p_round: round.id, p_scores: scores.map((s) => ({ opportunity_id: s.opportunity_id, priority: s.priority, priority_codes: s.priority_codes, open_questions: s.open_questions })), p_summary: summary, p_stop_reason: stop }), "hunt_round_finish");
  await hunt.rpc("hunt_message_add", { p_campaign: campaignId, p_role: "agent", p_body: agentReply(pt.hunt, { understood: [], unknown: [], summary, stop, head: fill(pt.hunt.campaign.round, { n: round.n }) }), p_round: round.id });

  // 8. coverage rows in kb_jobs (what kb_coverage shows on the screen)
  const fin = new Date().toISOString();
  if (rc.length) must(await svc.from("kb_jobs").insert(rc.map((c) => ({ kind: "pilot", source: c.source, city: c.town, workspace_id: ws, status: "done", finished_at: fin, created_at: c.ran_at, outcome: c.outcome, queried: c.queried, rows_in: c.rows_in, reason: c.reason ?? null, progress: { round: round.n } }))), "kb_jobs");

  // 9. the round file: the queue as stored after the round (private; outside the repo)
  const final = must(await user.from("lead_opportunities").select("id, priority, priority_codes, open_questions, hook_en, checks, contact_path, source_url, previous_priority, facts").eq("campaign_id", campaignId).eq("status", "open").limit(2000), "final queue") as { id: string; priority: number; priority_codes: string[]; open_questions: string[]; hook_en: string | null; checks: Record<string, { state: string }> & { contact?: { value_source_url?: string | null } }; contact_path: string; source_url: string | null; previous_priority: number | null; facts: OfferInput | null }[];
  const queue = final.filter((f) => f.facts).map((f) => {
    const v = offer.evaluate(f.facts!, now, params);
    return { opportunity_id: f.id, company: nn({ name: f.facts!.company?.name ?? "", phone: f.facts!.company?.phone, website: f.facts!.company?.website }), signal: nn({ ref: `${f.facts!.signal.source}:${f.facts!.signal.source_ref}`, kind: f.facts!.signal.kind, issued_on: f.facts!.signal.issued_on, value_usd: f.facts!.signal.value_usd, source_url: f.source_url ?? undefined }), fit: v.fit, checks: Object.fromEntries(Object.entries(v.checks).map(([k, c]) => [k, c.state])), priority: f.priority, previous_priority: f.previous_priority, codes: f.priority_codes, open_questions: f.open_questions, contact_path: f.contact_path, contact_source_url: f.checks.contact?.value_source_url ?? undefined, hook_en: f.hook_en, link_status: f.facts!.link_status };
  }).filter((q) => q.fit !== "no").sort((a, b) => b.priority - a.priority);
  const counts = { items_loaded: items.length, ingest: ing, signals_read: sigs.length, no_fit: noFit, evaluated_kept: done.length, no_company: unlinked.length, links_written: linksWritten, delivered: dl, queue: queue.length, summary: { new: summary.new, updated: summary.updated, demoted: summary.demoted }, stop };
  writeFileSync(path.join(out, `pilot-round-${round.n}.json`), JSON.stringify({ round: round.n, campaign_id: campaignId, ran_at: fin, live, counts, coverage: rc, unlinked, queue }, null, 2));
  console.log(`pilot round ${round.n}: ${JSON.stringify(counts)}`);
  expect(queue.length).toBeGreaterThanOrEqual(0);
}, 900_000);
