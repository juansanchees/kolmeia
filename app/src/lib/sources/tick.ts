import "server-only";
import { hostOf } from "@/lib/safe-url";
import { apifyClient, ApifyError } from "./apify";
import { apolloClient, ApolloError, ApolloKeyError, ApolloPlanError, mapOrg } from "./apollo";
import { openKey } from "./connections";
import { CONTACT_ACTOR, CONTACT_MAX_ITEMS, contactInput, keepEmails } from "./contact";
import { fetchHttpJson, SourceHttpError, type HttpJson } from "./http";
import { MAPS_ACTOR, mapPlace, mapsInput } from "./maps";
import { mapDecisionMaker, rapidApiClient, RapidApiError, siteEmails } from "./rapidapi";
import { mapContractor, permitWindow, shovelsClient, ShovelsError, shovelsSize, SHOVELS_TAGS, type ShovelsTag } from "./shovels";
import type { SourceCounts, SourceRunRow, SourceTickStore } from "./store";
import type { ImportRowIn } from "./types";
import { B2B_STATES, parseB2bForm, type B2bState } from "./view";

// The sources clock (F3d): begin -> enqueue Caçador searches -> start queued runs -> poll running ones -> finish.
// One run failing never stops the others, and finishTick always runs. The plaintext key lives only inside a run's
// handler; no error, count or log line ever carries it (errors are reduced to short codes first).

export const SOURCE_TICK_BUDGET_MS = 30_000;
export const SOURCE_STALE_MS = 15 * 60_000;
const ZERO: SourceCounts = { started: 0, polled: 0, imported: 0, failed: 0 };

export type SourceTickResult = { outcome: "ok" | "busy" | "error" } & SourceCounts;

/** A short code for any failure: never a message (it could echo a request, a URL or a key). */
function codeOf(e: unknown): string {
  if (e instanceof ApifyError) return e.code;
  if (e instanceof SourceHttpError) return e.code;
  if (e instanceof ApolloPlanError) return "plan";
  if (e instanceof ApolloKeyError) return "key";
  if (e instanceof ApolloError) return e.status ? `http_${e.status}` : "network";
  if (e instanceof ShovelsError) return e.code;
  if (e instanceof RapidApiError) return e.code;
  if (e instanceof Error && e.name === "SecretError") return "key_unreadable";
  return "failed";
}

/** Failures that say nothing about the run itself (the network blinked, Apify had a bad minute): try again next tick. */
function isTransient(e: unknown): boolean {
  if (e instanceof SourceHttpError) return true;
  if (e instanceof ApifyError) return /^http_5\d\d$/.test(e.code) || e.code === "http_429";
  return false;
}

const ID_OK = /^[A-Za-z0-9]{1,100}$/;
const clampUsd = (n: number | null): number | null => (n === null ? null : Math.min(1000, Math.max(0, Number.isFinite(n) ? n : 0)));

/** A start that Apify definitely did not take: 401/403 or another 4xx except 429. */
function isDefiniteRefusal(e: unknown): boolean {
  return e instanceof ApifyError && (e.code === "refused" || (/^http_4\d\d$/.test(e.code) && e.code !== "http_429"));
}

const isAlreadyHandled = (e: unknown) => (e as { code?: string } | null)?.code === "22023";
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export async function runSourceTick(opts: { store: SourceTickStore; http?: HttpJson; now?: () => number; budgetMs?: number }): Promise<SourceTickResult> {
  const { store } = opts;
  const http = opts.http ?? fetchHttpJson;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? SOURCE_TICK_BUDGET_MS);
  const counts: SourceCounts = { ...ZERO };

  const begun = await store.beginTick();
  if (begun.busy) return { outcome: "busy", ...ZERO };
  const tick = begun.tickId;
  let error: string | null = null;

  const fail = async (run: SourceRunRow, code: string, cost: number | null) => {
    try {
      await store.markFailed(tick, run.id, code, clampUsd(cost));
      counts.failed++;
    } catch (e) {
      if (!isAlreadyHandled(e)) throw e;
    }
  };

  /** Imports. A 22023 is a refusal by the database: the run fails 'import_refused' (fail() swallows its own 22023, the real "already handled" case). */
  const importRun = async (run: SourceRunRow, rows: ImportRowIn[], found: number, cost: number | null) => {
    try {
      // validate our own inputs first: the database refuses out-of-range values with 22023, which must not pass for "already imported"
      const kept = rows.slice(0, run.max_results + 20);
      const f = Math.min(10_000, found);
      await store.importRows(tick, run.id, kept, f, Math.max(0, f - kept.length), clampUsd(cost));
      counts.imported++;
    } catch (e) {
      if (!isAlreadyHandled(e)) throw e;
      await fail(run, "import_refused", cost);
    }
  };

  const startRun = async (run: SourceRunRow) => {
    let key: string | null = null;
    try {
      key = openKey(run.workspace_id, run.provider, run.ciphertext);
      if (run.provider === "rapidapi" && run.kind === "contact") {
        // RapidAPI reads one site per call and answers right away: every site of the run is read in this tick. A site
        // that fails is skipped (its lead gets nothing); the plan's own counter, when it says 0 left, stops the run.
        const leads = await store.contactLeads(tick, run.id);
        if (leads.length === 0) {
          await fail(run, "no_leads", 0);
          return;
        }
        await store.markStarted(tick, run.id, "rapidapi", "rapidapi");
        counts.started++;
        const client = rapidApiClient(key, http);
        const found: { leadId: string; value: string; url: string }[] = [];
        let asked = 0;
        let refused = false;
        for (const l of leads) {
          if (now() >= deadline) break; // the leads not reached leave the run (source_add_contacts) and can be asked again
          asked++;
          try {
            const r = await client.siteContacts(l.startUrl);
            found.push(...siteEmails(r.json, l.startUrl).map((e) => ({ leadId: l.leadId, ...e })));
            if (r.left === 0) break;
          } catch (e) {
            if (e instanceof RapidApiError && (e.code === "key" || e.code === "http_429")) {
              refused = e.code === "key";
              break; // the key or the plan is out: the rest would fail the same way
            }
          }
        }
        if (refused && found.length === 0) {
          await fail(run, "key", 0); // shows "chave recusada"; 'key' neither counts against the cap nor marks the leads as read
          return;
        }
        try {
          await store.addContacts(tick, run.id, found, asked, 0);
          counts.imported++;
        } catch (e) {
          if (!isAlreadyHandled(e)) throw e;
          await fail(run, "import_refused", 0);
        }
      } else if (run.kind === "b2b") {
        // B2B answers right away (about 10 s): one page per run, the page number set by the database at enqueue.
        const q = parseB2bForm(run.query);
        const state = run.query.state as B2bState;
        if (!q.ok || !B2B_STATES.includes(state)) {
          await fail(run, "bad_state", 0);
          return;
        }
        await store.markStarted(tick, run.id, "rapidapi", "");
        counts.started++;
        let items: unknown[];
        try {
          items = await rapidApiClient(key, http).decisionMakers(q.value.query, Number(run.query.page) || 1);
        } catch (e) {
          await fail(run, codeOf(e), 0);
          return;
        }
        const rows: ImportRowIn[] = [];
        for (const it of items) {
          const row = mapDecisionMaker(it, state, rows.length + 1);
          if (row) rows.push(row);
        }
        // found = people RapidAPI returned (outside the US or the state are dropped)
        await importRun(run, rows, items.length, 0);
      } else if (run.kind === "maps" || run.kind === "contact") {
        const client = apifyClient(key, http);
        let actor: string;
        let input: object;
        if (run.kind === "maps") {
          const q = run.query;
          actor = MAPS_ACTOR;
          input = mapsInput({ terms: strs(q.terms), location: String(q.location ?? ""), max: run.max_results });
        } else {
          // the sites the Qualificador asked about, read from the ledger (not from the run's own query)
          const urls = (await store.contactLeads(tick, run.id)).map((l) => l.startUrl);
          if (urls.length === 0) {
            await fail(run, "no_leads", 0);
            return;
          }
          actor = CONTACT_ACTOR;
          input = contactInput(urls);
        }
        let r: { runId: string; datasetId: string };
        try {
          r = await client.start(actor, input, run.reserve_usd);
        } catch (e) {
          // only a definite refusal costs nothing; a timeout, network error, 5xx, 429 or unreadable answer may have started a billed run
          await fail(run, codeOf(e), isDefiniteRefusal(e) ? 0 : run.reserve_usd);
          return;
        }
        // from here Apify has a run: anything that goes wrong aborts it (best effort) and settles at the reserve
        const abortAndFail = async (code: string) => {
          try {
            await client.abort(r.runId);
          } catch {
            // best effort
          }
          await fail(run, code, run.reserve_usd);
        };
        if (!ID_OK.test(r.runId) || !ID_OK.test(r.datasetId)) {
          await abortAndFail("bad_response");
          return;
        }
        try {
          await store.markStarted(tick, run.id, r.runId, r.datasetId);
        } catch (e) {
          await abortAndFail(isAlreadyHandled(e) ? "start_refused" : "start_unrecorded");
          return;
        }
        counts.started++;
      } else if (run.kind === "apollo") {
        // Apollo answers right away: mark it running, look up the pages, import in this same tick.
        await store.markStarted(tick, run.id, "apollo", "");
        counts.started++;
        const client = apolloClient(key, http);
        const pages = Math.min(4, Math.max(1, Number(run.query.pages) || 1));
        let found = 0;
        const rows: ImportRowIn[] = [];
        try {
          for (let page = 1; page <= pages; page++) {
            const items = await client.lookup({ locations: strs(run.query.locations), naics: strs(run.query.naics), page });
            found += items.length;
            for (const it of items) {
              const row = mapOrg(it, rows.length + 1);
              if (row) rows.push(row);
            }
            if (items.length === 0) break;
          }
        } catch (e) {
          await fail(run, codeOf(e), 0);
          return;
        }
        // zero results is a real answer, shown as found=0 (not an error)
        await importRun(run, rows, found, 0);
      } else if (run.kind === "shovels") {
        // Shovels answers right away, like Apollo. Every record returned costs 1 credit: the page size never goes past
        // what Shovels itself says is left (run.max_results already fits the workspace's own monthly cap).
        await store.markStarted(tick, run.id, "shovels", "");
        counts.started++;
        const client = shovelsClient(key, http);
        const tag: ShovelsTag = SHOVELS_TAGS.includes(run.query.tag as ShovelsTag) ? (run.query.tag as ShovelsTag) : "all";
        let items: unknown[];
        try {
          const geoId = await client.resolvePlace(typeof run.query.place === "string" ? run.query.place : "");
          if (!geoId) {
            await fail(run, "place_not_found", 0);
            return;
          }
          const size = shovelsSize(run.max_results, await client.usage());
          if (size < 1) {
            await fail(run, "credits", 0);
            return;
          }
          items = await client.contractors({ geoId, tag, size, ...permitWindow(now()) });
        } catch (e) {
          await fail(run, codeOf(e), 0);
          return;
        }
        const rows: ImportRowIn[] = [];
        for (const it of items) {
          const row = mapContractor(it, rows.length + 1);
          if (row) rows.push(row);
        }
        // found = records Shovels returned = credits spent; the ledger counts it against the monthly cap
        await importRun(run, rows, items.length, 0);
      } else {
        await fail(run, "unsupported", 0);
      }
    } catch (e) {
      if (isAlreadyHandled(e)) return;
      await fail(run, codeOf(e), 0);
    } finally {
      key = null;
    }
  };

  const pollRun = async (run: SourceRunRow) => {
    if (run.kind === "apollo" || run.kind === "shovels" || run.provider === "rapidapi") {
      // an Apollo, Shovels or RapidAPI run is finished inside its own tick; one still running was cut off by a crash
      await fail(run, "interrupted", 0);
      return;
    }
    let key: string | null = null;
    try {
      key = openKey(run.workspace_id, run.provider, run.ciphertext);
      const client = apifyClient(key, http);
      const extId = run.external_run_id;
      if (!extId || !run.dataset_id) {
        await fail(run, "bad_state", null);
        return;
      }
      counts.polled++;
      const st = await client.status(extId);
      if (st.status === "SUCCEEDED") {
        if (run.kind === "contact") {
          const items = await client.items(run.dataset_id, CONTACT_MAX_ITEMS);
          const leads = (await store.contactLeads(tick, run.id)).flatMap((l) => {
            const host = hostOf(l.startUrl);
            return host ? [{ leadId: l.leadId, host }] : [];
          });
          try {
            await store.addContacts(tick, run.id, keepEmails(items, leads), Math.min(10_000, items.length), clampUsd(st.usageUsd ?? run.reserve_usd));
            counts.imported++;
          } catch (e) {
            if (!isAlreadyHandled(e)) throw e;
            await fail(run, "import_refused", st.usageUsd ?? run.reserve_usd);
          }
          return;
        }
        const items = await client.items(run.dataset_id, run.max_results);
        const rows: ImportRowIn[] = [];
        items.forEach((it) => {
          const r = mapPlace(it, rows.length + 1);
          if (r) rows.push(r);
        });
        await importRun(run, rows, items.length, st.usageUsd ?? run.reserve_usd);
      } else if (st.status === "FAILED" || st.status === "ABORTED" || st.status === "TIMED-OUT") {
        await fail(run, st.status.toLowerCase().replace("-", "_"), st.usageUsd);
      } else {
        const started = run.started_at ? Date.parse(run.started_at) : NaN;
        if (Number.isFinite(started) && now() - started > SOURCE_STALE_MS) {
          try {
            await client.abort(extId);
          } catch {
            // the abort is best effort: the run is settled either way
          }
          await fail(run, "stale", null);
        }
        // else: still running, left for the next tick
      }
    } catch (e) {
      if (isAlreadyHandled(e)) return;
      if (isTransient(e)) {
        // next tick tries again, but not forever
        const started = run.started_at ? Date.parse(run.started_at) : NaN;
        if (Number.isFinite(started) && now() - started > 2 * SOURCE_STALE_MS) await fail(run, "stale", null);
        return;
      }
      if (e instanceof ApifyError && e.code === "http_404") {
        await fail(run, "not_found", null); // the run is gone on Apify (key rotated, run deleted)
        return;
      }
      await fail(run, codeOf(e), null);
    } finally {
      key = null;
    }
  };

  /** One handler failing for a reason of its own (the database itself) must not stop the rest. */
  const guarded = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      error = codeOf(e);
    }
  };

  try {
    await store.enqueueAgentRuns(tick);
    const work = await store.nextWork(tick);
    // claimed start rows are never returned again, so every one runs; only polls obey the budget
    for (const run of work.start) {
      await guarded(() => startRun(run));
    }
    for (const run of work.poll) {
      if (now() >= deadline) break;
      await guarded(() => pollRun(run));
    }
  } catch (e) {
    error = codeOf(e);
  } finally {
    try {
      await store.finishTick(tick, counts, error);
    } catch (e) {
      if ((e as { name?: string } | null)?.name === "HunterAuthError") throw e;
      error = error ?? "finish_failed";
    }
  }
  return { outcome: error ? "error" : "ok", ...counts };
}
