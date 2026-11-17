import "server-only";
import { AiError, isAiError, type AiErrorCode } from "@/lib/ai/errors";
import { lightQualify, verifyLead } from "@/lib/ai/qualify-tasks";
import type { AiTransport } from "@/lib/ai/types";
import { hostOf, sanitizeUrl } from "@/lib/safe-url";
import { isDirectoryHost } from "@/lib/sources/contact";
import { PLACES_CALL_USD } from "./places";
import type { RawHttp } from "./site/net";
import { cut } from "./site/extract";
import { readSite, SITE_LIMITS, type SiteRead } from "./site/reader";
import { factsToFields, fieldKey, liveFields, liveLevel, siteField } from "./site-facts";
import type { QualifierTickStore } from "./store";
import type { DoneReason, FieldIn, FieldRow, LeadSnapshot, PlaceHit, PlacesClient, QualifierPauseReason, QualifierStep, StepOutcome } from "./types";

// One lead through the cascade, cheapest step first, in one call: P1 juntar, P2 site, P2b contatos (Apify, queued and never waited for), P3 Places, P4 IA leve, P5 IA
// forte. The pages P2 reads stay in memory for P4. Page text is untrusted data: nothing here follows it, it only
// feeds `factsToFields`, which keeps what is literally written on the page. Errors are short codes, never messages.

export type CascadeDeps = {
  store: QualifierTickStore;
  tickId: string;
  transport: AiTransport | null;
  http: RawHttp;
  places: PlacesClient | null;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  gaps: Map<string, number>;
  /** When the request that runs this tick must be over (same clock as `now`). P4 and P5 do not start without time to finish. */
  deadline?: number;
};

/** Time P5 needs (one careful call can take up to 150 s) and P4 (one light call plus margin). */
export const P5_MIN_MS = 150_000;
export const P4_MIN_MS = 40_000;

export type CascadeResult = {
  steps: number;
  result: "done" | "paused" | "requeued";
  pauseReason?: QualifierPauseReason;
  /** The lead was given back because a step failed: the tick keeps it out of the rest of this tick. */
  errored?: boolean;
  /** The lead was given back for lack of time before a paid step: the tick keeps it out of the rest of this tick. */
  deferred?: boolean;
};

/** Imported values a "no" from the decision-maker check may refute (research values follow their own proof in the database). */
const IMPORTED = new Set(["import", "apify_maps", "apollo", "shovels"]);

/** P5 runs for a lead the AI can still raise (level < 4) that was asked for, or contactable and matching the profile with the switch on. */
export function deepEligible(s: LeadSnapshot, aiOn: boolean): boolean {
  return aiOn && s.level < 4 && (s.deepRequested || (s.settings.autoDeep && s.profileMatch && s.level >= 1));
}

/** Today's date (YYYY-MM-DD) in New York, the Qualificador's day. */
const ny = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

const foldName = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The Places hit shares its name, phone or address with something the lead already has. */
function agreesWithLead(hit: PlaceHit, leadName: string, fields: FieldRow[]): boolean {
  const live = fields.filter((f) => f.status !== "refuted");
  const names = [leadName, ...live.filter((f) => f.field === "name").map((f) => f.value)].map(foldName).filter((n) => n.length >= 4);
  const hn = hit.name ? foldName(hit.name) : "";
  if (hn.length >= 4 && names.some((n) => n === hn || n.includes(hn) || hn.includes(n))) return true;
  if (hit.phone && live.some((f) => f.field === "phone" && fieldKey("phone", f.value) === fieldKey("phone", hit.phone!))) return true;
  if (hit.address && live.some((f) => f.field === "address" && fieldKey("address", f.value) === fieldKey("address", hit.address!))) return true;
  return false;
}

const ORDER: QualifierStep[] = ["p1", "p2", "p2b", "p3", "p4", "p5"];
const MAX_STREAK = 3;
/** Fields that count as a way to reach the company. */
const REACH = new Set(["phone", "email"]);

type StepResult = {
  outcome: StepOutcome;
  /** The lead is finished by this step. */
  done?: DoneReason;
  /** The pass restarts from the next claim (fresh snapshot): used when P1 added values. */
  requeue?: boolean;
  /** Stay on this step: the next claim runs it again (a second site is left to read). */
  again?: boolean;
};

/** A cap the database raised: which pause it means (the lead goes back to the queue unchanged). lead_cap ends the lead instead. */
const CAP_PAUSE: Partial<Record<AiErrorCode, QualifierPauseReason>> = {
  qualifier_daily: "daily_cap",
  daily_cap: "workspace_cap",
  user_cap: "user_cap",
  global_cap: "global_cap",
  no_access: "no_access",
};

function isAuthError(e: unknown): boolean {
  return e instanceof Error && e.name === "HunterAuthError";
}

export async function qualifyLead(s: LeadSnapshot, d: CascadeDeps): Promise<CascadeResult> {
  const { store, tickId } = d;
  const leadId = s.leadId;
  let steps = 0;
  // the live view of this lead's values: P2's refutations and additions show to later steps in the same pass
  let fields = s.fields;
  let level = s.level;
  // pages read in this pass (by P2 or by P3's website): the only text P4 reads
  let site: SiteRead | null = null;
  // P2 found the site down and there is no other site left to read
  let siteDown = false;
  // how P2 ended (this pass, else the queue's note from an earlier one): P2b needs the free reader to have read the site
  let p2Outcome: string | undefined = s.notes.p2;
  // what this lead and the Qualificador's day have spent, kept current inside the pass (the snapshot is from the claim)
  let leadSpent = s.spentUsd;
  let daySpent = s.settings.spentToday;
  // one deadline for every site read of this lead (P2 and the Places website), and the hosts already read in this pass
  const leadStart = d.now();
  const readHosts = new Set<string>();
  const siteDeps = () => ({ http: d.http, sleep: d.sleep, now: d.now, gaps: d.gaps, totalMs: SITE_LIMITS.totalMs - (d.now() - leadStart) });
  const left = () => (d.deadline === undefined ? Infinity : d.deadline - d.now());
  const aiMs = () => (d.deadline === undefined ? undefined : Math.max(1, left()));
  const otherSite = () => fields.some((f) => f.field === "website" && f.status !== "refuted");
  const reach = () => fields.some((f) => REACH.has(f.field) && f.status !== "refuted");

  const run = async (step: QualifierStep): Promise<StepResult> => {
    switch (step) {
      case "p1": {
        const n = await store.merge(tickId, leadId);
        return n > 0 ? { outcome: "ok", requeue: true } : { outcome: "skipped" };
      }
      case "p2": {
        const w = siteField({ ...s, fields });
        if (!w) return { outcome: "no_site" };
        const confirmed = (f: string) => fields.some((x) => x.field === f && x.status === "confirmed");
        if (confirmed("phone") && confirmed("email") && confirmed("address")) return { outcome: "skipped" };
        const read = await readSite(w.value, siteDeps());
        readHosts.add(hostOf(w.value) ?? w.value);
        if (read.finalHome) readHosts.add(hostOf(read.finalHome) ?? read.finalHome);
        site = read;
        const { add, refute } = factsToFields(read, { ...s, fields });
        if (add.length) await store.addFields(tickId, leadId, add);
        if (refute.length) await store.refute(tickId, leadId, refute);
        fields = liveFields({ ...s, fields }, add, refute);
        level = liveLevel(level, fields);
        if (read.outcome === "site_down") {
          siteDown = true;
          // another site is left after the refutation: read it on the next claim (only when this one was really refuted)
          if (otherSite() && refute.length) return { outcome: "site_down", again: true };
          // nothing left to reach and no other site: dead (K-3). With Places on, P3 gets its say first: Places can only save a lead.
          if (!reach() && !otherSite() && d.places === null) return { outcome: "site_down", done: "dead" };
        }
        return { outcome: read.outcome === "ok" ? "ok" : read.outcome };
      }
      case "p2b": {
        // the free reader got through (or was only blocked) and found no e-mail: ask the contact scraper, without waiting for it
        if (p2Outcome !== "ok" && p2Outcome !== "site_blocked") return { outcome: "skipped" };
        if (fields.some((f) => f.field === "email" && f.status !== "refuted")) return { outcome: "skipped" };
        const w = siteField({ ...s, fields });
        const url = w ? sanitizeUrl(w.value) : null;
        const host = url ? hostOf(url) : null;
        // a social or directory page is not the company's own site: nothing worth a paid scrape
        if (!url || !host || isDirectoryHost(host)) return { outcome: "skipped" };
        // Known gap: a run refused when the sources clock starts it (cap, disconnected) leaves this step logged as "queued"
        // and the lead is not asked again until a new pass; the lead itself is never blocked by it.
        return { outcome: (await store.requestContacts(tickId, leadId, url)) ? "queued" : "no_source" };
      }
      case "p3": {
        if (resumedPastP3) return { outcome: "skipped" }; // Places already ran in an earlier pass: a resume at p2 must not pay again
        if (level >= 2) return { outcome: "skipped" }; // what P2 just wrote counts (level is live)
        if (!d.places) return { outcome: "places_off" };
        const name = s.best?.name?.trim();
        if (!name) return siteDown && !reach() && !otherSite() ? { outcome: "skipped", done: "dead" } : { outcome: "skipped" };
        const id = await store.reservePlaces(tickId, leadId, PLACES_CALL_USD);
        let hit: PlaceHit | null;
        try {
          hit = await d.places.search({ name, city: s.best?.city ?? null, state: s.best?.state ?? null });
        } catch (e) {
          // a definite non-200 answer is free; a network failure, a timeout or a bad body may still have been billed (outcome unknown)
          const status = e && typeof e === "object" && "status" in e ? Number((e as { status: unknown }).status) : NaN;
          const free = Number.isFinite(status) && status !== 0 && status !== 200;
          const cost = free ? 0 : PLACES_CALL_USD;
          await store.settlePlaces(tickId, leadId, id, cost, false).catch(() => undefined);
          if (!free) {
            leadSpent += cost;
            daySpent += cost;
          }
          throw e;
        }
        leadSpent += PLACES_CALL_USD;
        daySpent += PLACES_CALL_USD;
        try {
          await store.settlePlaces(tickId, leadId, id, PLACES_CALL_USD, true);
        } catch (e) {
          if (isAuthError(e)) throw e;
          // the call is made and paid for: never ask Places again for it, record the step as failed and move on
          return { outcome: "error" };
        }
        const closed = hit?.status === "CLOSED_PERMANENTLY";
        // "closed" is trusted only when the place's name, phone or address agrees with something the lead already has
        const trusted = !!hit && closed && agreesWithLead(hit, name, fields);
        if (!hit) return siteDown && !reach() && !otherSite() ? { outcome: "ok", done: "dead" } : { outcome: "ok" };
        const rows: FieldIn[] = [{ field: "place_id", value: hit.placeId, source: "places", status: "unverified", excerpt: "Google Places" }];
        // K-5: a Places value is kept only when another source already holds the same value
        const agrees = (field: string, value: string | null) => !!value && fields.some((f) => f.field === field && f.status !== "refuted" && fieldKey(field, f.value) === fieldKey(field, value));
        for (const [field, value] of [["phone", hit.phone], ["address", hit.address], ["website", hit.website]] as const) {
          if (value && agrees(field, value)) rows.push({ field, value, source: "places", status: "confirmed", excerpt: "Google Places" });
        }
        // a website nobody gave us: read in this same pass, in memory only (the website itself is not stored)
        const found = !closed && !siteField({ ...s, fields }) ? sanitizeUrl(hit.website ?? "") : null;
        const foundHost = found ? (hostOf(found) ?? found) : null;
        if (found && foundHost && !readHosts.has(foundHost) && SITE_LIMITS.totalMs - (d.now() - leadStart) > 0) {
          const read = await readSite(found, siteDeps());
          readHosts.add(foundHost);
          site = read;
          rows.push(...factsToFields(read, { ...s, fields }).add.filter((a) => a.field !== "website"));
        }
        await store.addFields(tickId, leadId, rows);
        fields = liveFields({ ...s, fields }, rows, []);
        level = liveLevel(level, fields);
        // Places "closed" alone never kills a lead: it must be trusted AND nothing else is left to reach or read
        if (trusted && !reach() && !otherSite()) return { outcome: "closed", done: "dead" };
        if (siteDown && !reach() && !otherSite() && !closed) return { outcome: "ok", done: "dead" };
        return { outcome: closed ? "closed" : "ok" };
      }
      case "p4": {
        if (!d.transport) return { outcome: "no_ai" };
        const pages = (site?.pages ?? []).filter((p) => p.text.trim()).map((p) => ({ url: p.url, text: p.text }));
        if (pages.length === 0) return { outcome: "skipped" }; // only pages read in this pass
        if (left() < P4_MIN_MS) return { outcome: "deadline", again: true };
        const r = await lightQualify({ workspaceId: s.workspaceId, runId: null, ledger: store.ledger(tickId, leadId), transport: d.transport, deadlineMs: aiMs() }, { pages });
        leadSpent += r.costUsd;
        daySpent += r.costUsd;
        const held = new Set(fields.map((f) => `${f.field}:${fieldKey(f.field, f.value)}`));
        const rows: FieldIn[] = [];
        // I-1: the page's text can say anything, and the model may obey it. An e-mail or a phone is kept only when the
        // deterministic reader also found it on that same page (tel:/mailto:/structured data); everything else is dropped.
        const readerHas = (field: string, value: string, url: string) =>
          (site?.pages ?? []).some((pg) => pg.url === url && (field === "email" ? pg.facts.emails : pg.facts.phones).some((f) => fieldKey(field, f.value) === fieldKey(field, value)));
        for (const v of r.data.values) {
          if ((v.field === "email" || v.field === "phone") && !readerHas(v.field, v.value, v.url)) continue;
          const k = `${v.field}:${fieldKey(v.field, v.value)}`;
          if (held.has(k)) continue;
          held.add(k);
          rows.push({ field: v.field, value: v.value, source: "ai", source_ref: v.url, status: "unverified", excerpt: v.excerpt });
        }
        if (r.data.companyType && !fields.some((f) => f.field === "company_type")) {
          rows.push({ field: "company_type", value: r.data.companyType, source: "ai", source_ref: pages[0].url, status: "unverified" });
        }
        if (rows.length) {
          await store.addFields(tickId, leadId, rows);
          fields = liveFields({ ...s, fields }, rows, []);
        }
        return { outcome: "ok" };
      }
      case "p5": {
        if (!d.transport) return { outcome: "no_ai" };
        if (!deepEligible({ ...s, level }, true)) return { outcome: "skipped" };
        if (left() < P5_MIN_MS) return { outcome: "deadline", again: true }; // not enough time to finish a careful call: nothing paid, same step next time
        const { leadCapUsd, dailyCapUsd } = s.settings;
        // the call shrinks to what is left of the lead's cap and of the day; the gateway raises run_cap when even the smallest does not fit
        const runBudget = { spentUsd: leadSpent, maxUsd: Math.min(leadCapUsd, leadSpent + (dailyCapUsd - daySpent)) };
        let r;
        try {
          r = await verifyLead({ workspaceId: s.workspaceId, runId: null, ledger: store.ledger(tickId, leadId), transport: d.transport, runBudget, deadlineMs: aiMs() }, { ...s, fields }, ny(d.now()));
        } catch (e) {
          if (isAiError(e) && e.code === "run_cap") {
            // not even the smallest call fits: the lead's cap if that is the tighter limit, else the day's
            if (leadCapUsd - leadSpent <= dailyCapUsd - daySpent) throw new AiError("lead_cap");
            // the day's money is short for this one call: only this lead's P5 ends (the others keep running; the database's own daily cap still pauses)
            return { outcome: "day_cap" };
          }
          throw e;
        }
        const c = r.data[0];
        if (!c) return { outcome: "ok" };
        const check = (kind: string) => c.checks.find((k) => k.kind === kind);
        const proved = (kind: string) => {
          const k = check(kind);
          return k && k.result === "ok" && k.evidence.length > 0 ? k : null;
        };
        const no = (kind: string) => {
          const k = check(kind);
          return k && k.result === "no" && k.evidence.length > 0 ? k : null;
        };
        // a closed company: nothing else is worth writing
        // (dead only when nothing else is left to reach or read: an AI "no" alone never kills a lead, as in P2 and P3)
        if (no("exists_active")) return !reach() && !otherSite() ? { outcome: "ok", done: "dead" } : { outcome: "closed" };
        const held = new Set(fields.filter((f) => f.status === "confirmed").map((f) => `${f.field}:${fieldKey(f.field, f.value)}`));
        const rows: FieldIn[] = [];
        const push = (row: FieldIn) => {
          const k = `${row.field}:${fieldKey(row.field, row.value)}`;
          if (held.has(k) || [...row.value].length > 1000) return;
          held.add(k);
          rows.push(row);
        };
        const dm = proved("decision_maker");
        if (dm && c.askForName && c.nameSourceUrl) {
          const ev = dm.evidence[0];
          const base = { source: "ai" as const, source_ref: c.nameSourceUrl, status: "confirmed" as const, excerpt: cut(ev.excerpt, 300), seen_at: ev.seenAt };
          push({ field: "contact_name", value: c.askForName, ...base });
          if (c.askForTitle) push({ field: "contact_title", value: c.askForTitle, ...base });
        }
        const work = proved("has_work");
        if (work) {
          const ev = work.evidence[0];
          const value = cut(work.summary.trim() || c.signalMatch || ev.title, 300);
          if (value) push({ field: "active_project", value, source: "ai", source_ref: ev.url, status: "confirmed", excerpt: cut(ev.excerpt, 300), seen_at: ev.seenAt });
        }
        if (c.phone && c.phoneSourceUrl) push({ field: "phone", value: c.phone, source: "ai", source_ref: c.phoneSourceUrl, status: "confirmed" });
        if (c.publicEmail && c.emailSourceUrl) push({ field: "email", value: c.publicEmail.toLowerCase(), source: "ai", source_ref: c.emailSourceUrl, status: "confirmed" });
        // nobody decides there, with proof: an imported contact nobody confirmed is refuted
        const refute = no("decision_maker") ? fields.filter((f) => (f.field === "contact_name" || f.field === "contact_title") && f.status === "unverified" && IMPORTED.has(f.source)).map((f) => f.id) : [];
        if (rows.length) await store.addFields(tickId, leadId, rows);
        if (refute.length) await store.refute(tickId, leadId, refute);
        fields = liveFields({ ...s, fields }, rows, refute);
        level = liveLevel(level, fields);
        return { outcome: "ok" };
      }
    }
  };

  // a resume at p4 has no pages in memory: go back to p2 (it re-reads the site) but never pay Places again.
  // A resume at p5 needs no pages: it goes straight on (P4 is not paid again).
  let first = ORDER.indexOf(s.nextStep);
  const resumedPastP3 = first > ORDER.indexOf("p3");
  if (first === ORDER.indexOf("p4") && siteField(s)) first = ORDER.indexOf("p2");
  for (let i = first; i < ORDER.length; i++) {
    const step = ORDER[i];
    const next = (ORDER[i + 1] ?? "done") as QualifierStep | "done";
    let streak = s.failStep === step ? s.failStreak : 0;
    let r: StepResult;
    try {
      r = await run(step);
      if (step === "p2") p2Outcome = r.outcome;
    } catch (e) {
      if (isAuthError(e)) throw e;
      if (isAiError(e)) {
        const reason = CAP_PAUSE[e.code];
        // the Qualificador's day, the workspace, the user or the key is out of budget: nothing written, the lead waits
        if (reason) return { steps, result: "paused", pauseReason: reason };
        if (e.code === "lead_cap") {
          await store.stepDone(tickId, leadId, step, "lead_cap", "done", "lead_cap");
          return { steps: steps + 1, result: "done" };
        }
      }
      streak++;
      if (streak >= MAX_STREAK) {
        // third error in a row on this step: skip it and go on
        await store.stepDone(tickId, leadId, step, "error", next, next === "done" ? "complete" : null);
        steps++;
        if (next === "done") return { steps, result: "done" };
        continue;
      }
      await store.stepDone(tickId, leadId, step, "error", step, null); // counts the failure, stays on this step
      return { steps: steps + 1, result: "requeued", errored: true };
    }
    if (r.done) {
      await store.stepDone(tickId, leadId, step, r.outcome, "done", r.done);
      return { steps: steps + 1, result: "done" };
    }
    if (r.requeue || r.again) {
      await store.stepDone(tickId, leadId, step, r.outcome, r.again ? step : next, null);
      return { steps: steps + 1, result: "requeued", ...(r.outcome === "deadline" ? { deferred: true } : {}) };
    }
    await store.stepDone(tickId, leadId, step, r.outcome, next, next === "done" ? "complete" : null);
    steps++;
    if (next === "done") return { steps, result: "done" };
  }
  return { steps, result: "done" };
}
