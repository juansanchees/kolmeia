import "server-only";
import { isAiError, type AiErrorCode } from "@/lib/ai/errors";
import { lightQualify } from "@/lib/ai/qualify-tasks";
import type { AiTransport } from "@/lib/ai/types";
import { sanitizeUrl } from "@/lib/safe-url";
import { PLACES_CALL_USD } from "./places";
import type { RawHttp } from "./site/net";
import { readSite, type SiteRead } from "./site/reader";
import { factsToFields, fieldKey, liveFields, liveLevel, siteField } from "./site-facts";
import type { QualifierTickStore } from "./store";
import type { DoneReason, FieldIn, LeadSnapshot, PlaceHit, PlacesClient, QualifierPauseReason, QualifierStep, StepOutcome } from "./types";

// One lead through the cascade, cheapest step first, in one call: P1 juntar, P2 site, P3 Places, P4 IA leve, P5 IA
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
};

export type CascadeResult = {
  steps: number;
  result: "done" | "paused" | "requeued";
  pauseReason?: QualifierPauseReason;
  /** The lead was given back because a step failed: the tick keeps it out of the rest of this tick. */
  errored?: boolean;
};

const ORDER: QualifierStep[] = ["p1", "p2", "p3", "p4", "p5"];
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
        const read = await readSite(w.value, { http: d.http, sleep: d.sleep, now: d.now, gaps: d.gaps });
        site = read;
        const { add, refute } = factsToFields(read, { ...s, fields });
        if (add.length) await store.addFields(tickId, leadId, add);
        if (refute.length) await store.refute(tickId, leadId, refute);
        fields = liveFields({ ...s, fields }, add, refute);
        level = liveLevel(level, fields);
        if (read.outcome === "site_down") {
          siteDown = true;
          const otherSite = fields.some((f) => f.field === "website" && f.status !== "refuted");
          // another site is left after the refutation: read it on the next claim (only when this one was really refuted)
          if (otherSite && refute.length) return { outcome: "site_down", again: true };
          // nothing left to reach, no other site and no Places to ask: the lead is dead (K-3)
          if (!reach() && !otherSite && d.places === null) return { outcome: "site_down", done: "dead" };
        }
        return { outcome: read.outcome === "ok" ? "ok" : read.outcome };
      }
      case "p3": {
        if (level >= 2) return { outcome: "skipped" }; // what P2 just wrote counts (level is live)
        if (!d.places) return { outcome: "places_off" };
        const name = s.best?.name?.trim();
        if (!name) return siteDown && !reach() ? { outcome: "skipped", done: "dead" } : { outcome: "skipped" };
        const id = await store.reservePlaces(tickId, leadId, PLACES_CALL_USD);
        let hit: PlaceHit | null;
        try {
          hit = await d.places.search({ name, city: s.best?.city ?? null, state: s.best?.state ?? null });
        } catch (e) {
          await store.settlePlaces(tickId, leadId, id, 0, false).catch(() => undefined); // a failed call costs nothing
          throw e;
        }
        await store.settlePlaces(tickId, leadId, id, PLACES_CALL_USD, true);
        // the place said nothing, or the site was already down and Places has nobody to reach: dead
        if (!hit) return siteDown && !reach() ? { outcome: "ok", done: "dead" } : { outcome: "ok" };
        const rows: FieldIn[] = [{ field: "place_id", value: hit.placeId, source: "places", status: "unverified", excerpt: "Google Places" }];
        // K-5: a Places value is kept only when another source already holds the same value
        const agrees = (field: string, value: string | null) => !!value && fields.some((f) => f.field === field && f.status !== "refuted" && fieldKey(field, f.value) === fieldKey(field, value));
        for (const [field, value] of [["phone", hit.phone], ["address", hit.address], ["website", hit.website]] as const) {
          if (value && agrees(field, value)) rows.push({ field, value, source: "places", status: "confirmed", excerpt: "Google Places" });
        }
        const closed = hit.status === "CLOSED_PERMANENTLY";
        // a website nobody gave us: read in this same pass, in memory only (the website itself is not stored)
        const found = !closed && !siteField({ ...s, fields }) ? sanitizeUrl(hit.website ?? "") : null;
        if (found) {
          const read = await readSite(found, { http: d.http, sleep: d.sleep, now: d.now, gaps: d.gaps });
          site = read;
          rows.push(...factsToFields(read, { ...s, fields }).add.filter((a) => a.field !== "website"));
        }
        await store.addFields(tickId, leadId, rows);
        fields = liveFields({ ...s, fields }, rows, []);
        level = liveLevel(level, fields);
        if ((closed || siteDown) && !reach()) return { outcome: closed ? "closed" : "ok", done: "dead" };
        return { outcome: closed ? "closed" : "ok" };
      }
      case "p4": {
        if (!d.transport) return { outcome: "no_ai" };
        const pages = (site?.pages ?? []).filter((p) => p.text.trim()).map((p) => ({ url: p.url, text: p.text }));
        if (pages.length === 0) return { outcome: "skipped" }; // only pages read in this pass
        const r = await lightQualify({ workspaceId: s.workspaceId, runId: null, ledger: store.ledger(tickId, leadId), transport: d.transport }, { pages });
        const held = new Set(fields.map((f) => `${f.field}:${fieldKey(f.field, f.value)}`));
        const rows: FieldIn[] = [];
        for (const v of r.data.values) {
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
      case "p5":
        return { outcome: d.transport ? "skipped" : "no_ai" }; // Task 7 replaces this
    }
  };

  for (let i = ORDER.indexOf(s.nextStep); i < ORDER.length; i++) {
    const step = ORDER[i];
    const next = (ORDER[i + 1] ?? "done") as QualifierStep | "done";
    let streak = s.failStep === step ? s.failStreak : 0;
    let r: StepResult;
    try {
      r = await run(step);
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
      return { steps: steps + 1, result: "requeued" };
    }
    await store.stepDone(tickId, leadId, step, r.outcome, next, next === "done" ? "complete" : null);
    steps++;
    if (next === "done") return { steps, result: "done" };
  }
  return { steps, result: "done" };
}
