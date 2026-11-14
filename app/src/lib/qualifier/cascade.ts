import "server-only";
import type { AiTransport } from "@/lib/ai/types";
import type { RawHttp } from "./site/net";
import { readSite, type SiteRead } from "./site/reader";
import { factsToFields, siteField } from "./site-facts";
import type { QualifierTickStore } from "./store";
import type { DoneReason, LeadSnapshot, PlacesClient, QualifierPauseReason, QualifierStep, StepOutcome } from "./types";

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

export type CascadeResult = { steps: number; result: "done" | "paused" | "requeued"; pauseReason?: QualifierPauseReason };

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
  let site: SiteRead | null = null;

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
        if (refute.length) {
          await store.refute(tickId, leadId, refute);
          fields = fields.map((f) => (refute.includes(f.id) ? { ...f, status: "refuted" as const } : f));
        }
        if (read.outcome === "site_down") {
          // nothing left to reach and no Places to ask: the lead is dead (K-3)
          const reach = fields.some((f) => REACH.has(f.field) && f.status !== "refuted");
          if (!reach && d.places === null) return { outcome: "site_down", done: "dead" };
        }
        return { outcome: read.outcome === "ok" ? "ok" : read.outcome };
      }
      case "p3":
        return { outcome: "places_off" }; // Task 6 replaces this
      case "p4":
      case "p5":
        return { outcome: d.transport ? "skipped" : "no_ai" }; // Tasks 6-7 replace these
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
      streak++;
      if (streak >= MAX_STREAK) {
        // third error in a row on this step: skip it and go on
        await store.stepDone(tickId, leadId, step, "error", next, next === "done" ? "complete" : null);
        steps++;
        if (next === "done") return { steps, result: "done" };
        continue;
      }
      await store.stepDone(tickId, leadId, step, "error", step, null); // counts the failure, stays on this step
      return { steps: steps + 1, result: "requeued" };
    }
    if (r.done) {
      await store.stepDone(tickId, leadId, step, r.outcome, "done", r.done);
      return { steps: steps + 1, result: "done" };
    }
    if (r.requeue) {
      await store.stepDone(tickId, leadId, step, r.outcome, next, null);
      return { steps: steps + 1, result: "requeued" };
    }
    await store.stepDone(tickId, leadId, step, r.outcome, next, next === "done" ? "complete" : null);
    steps++;
    if (next === "done") return { steps, result: "done" };
  }
  return { steps, result: "done" };
}
