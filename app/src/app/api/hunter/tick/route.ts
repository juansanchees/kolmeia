import { hasAi } from "@/lib/ai/config";
import { defaultTransport } from "@/lib/ai/gateway";
import { runHunterTick } from "@/lib/hunter/tick";
import { createHunterTickStore } from "@/lib/hunter/tick-store";
import { createQualifierTickStore } from "@/lib/qualifier/store";
import { QUALIFIER_TICK_BUDGET_MS, runQualifierTick } from "@/lib/qualifier/tick";
import { createSourceTickStore } from "@/lib/sources/store";
import { runSourceTick, SOURCE_TICK_BUDGET_MS } from "@/lib/sources/tick";

// The Caçador clock (C7). pg_cron + pg_net post here every 2 minutes with `Authorization: Bearer <64 hex chars>`
// (the same token as /api/scheduler/tick). No session: the token is forwarded to the database, which checks its hash.
// maxDuration 300 needs Fluid compute enabled on the Vercel project (without it the plan cap is lower); fallback in
// supabase/manual/hunter_cron.sql.
export const maxDuration = 300;
/** The whole request (hunter + qualifier + sources) stops starting new work 60 s before maxDuration. */
export const REQUEST_BUDGET_MS = 240_000;
export const dynamic = "force-dynamic";

const BEARER = /^Bearer ([0-9a-f]{64})$/;

type Qualifier = { outcome: string; leads: number; steps: number; paused: number; failed: number };
type Sources = { outcome: string; started: number; polled: number; imported: number; failed: number };

/** The Qualificador tick: runs after the Caçador, always (without an AI key its AI steps say no_ai). Never throws except the 401. */
async function qualifierTick(token: string, budgetMs: number): Promise<Qualifier> {
  const none: Qualifier = { outcome: "error", leads: 0, steps: 0, paused: 0, failed: 0 };
  try {
    const store = createQualifierTickStore(token);
    if (!store) return none;
    const r = await runQualifierTick({ store, transport: hasAi() ? defaultTransport() : null, budgetMs });
    return { outcome: r.outcome, leads: r.leads, steps: r.steps, paused: r.paused, failed: r.failed };
  } catch (e) {
    if (e instanceof Error && e.name === "HunterAuthError") throw e;
    return none; // never echo internals (R10)
  }
}

/** The connected-sources tick (F3d): runs after the Caçador, with or without an AI key. Never throws except the 401. */
async function sourcesTick(token: string, budgetMs: number): Promise<Sources> {
  const none: Sources = { outcome: "error", started: 0, polled: 0, imported: 0, failed: 0 };
  try {
    const store = createSourceTickStore(token);
    if (!store) return none;
    const r = await runSourceTick({ store, budgetMs });
    return { outcome: r.outcome, started: r.started, polled: r.polled, imported: r.imported, failed: r.failed };
  } catch (e) {
    if (e instanceof Error && e.name === "HunterAuthError") throw e;
    return none; // never echo internals (R10)
  }
}

export async function POST(request: Request) {
  const requestStart = Date.now();
  // shape first: nothing is created for a request that cannot hold a token
  const m = BEARER.exec(request.headers.get("authorization") ?? "");
  if (!m) return Response.json({ error: "unauthorized" }, { status: 401 });
  const token = m[1];
  let hunter: Record<string, unknown> | null = null;
  let hunterStatus = 200;
  try {
    if (!hasAi()) {
      // no AI key: no Caçador work and no hunter database call; the sources below still run
      hunter = { outcome: "no_ai" };
    } else {
      const store = createHunterTickStore(token);
      if (!store) {
        hunter = { outcome: "error" };
        hunterStatus = 500;
      } else {
        const r = await runHunterTick({ store, transport: defaultTransport() });
        hunter = { outcome: r.outcome, runs: r.runs, steps: r.steps, paused: r.paused, failed: r.failed };
      }
    }
  } catch (e) {
    if (e instanceof Error && e.name === "HunterAuthError") return Response.json({ error: "unauthorized" }, { status: 401 });
    hunter = { outcome: "error" }; // never echo internals (R10)
    hunterStatus = 500;
  }
  const left = () => Math.max(0, requestStart + REQUEST_BUDGET_MS - Date.now());
  try {
    const qualifier = await qualifierTick(token, Math.min(QUALIFIER_TICK_BUDGET_MS, left()));
    // the sources budget is what is left after the qualifier finished
    const sources = await sourcesTick(token, Math.min(SOURCE_TICK_BUDGET_MS, left()));
    return Response.json({ ...hunter, qualifier, sources }, { status: hunterStatus });
  } catch {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
}
