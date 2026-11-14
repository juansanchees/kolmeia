import { hasAi } from "@/lib/ai/config";
import { defaultTransport } from "@/lib/ai/gateway";
import { runHunterTick } from "@/lib/hunter/tick";
import { createHunterTickStore } from "@/lib/hunter/tick-store";
import { createSourceTickStore } from "@/lib/sources/store";
import { runSourceTick } from "@/lib/sources/tick";

// The Caçador clock (C7). pg_cron + pg_net post here every 2 minutes with `Authorization: Bearer <64 hex chars>`
// (the same token as /api/scheduler/tick). No session: the token is forwarded to the database, which checks its hash.
// maxDuration 300 needs a plan that allows it (Hobby with Fluid compute: ? verify on the project); fallback in
// supabase/manual/hunter_cron.sql.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const BEARER = /^Bearer ([0-9a-f]{64})$/;

type Sources = { outcome: string; started: number; polled: number; imported: number; failed: number };

/** The connected-sources tick (F3d): runs after the Caçador, with or without an AI key. Never throws except the 401. */
async function sourcesTick(token: string): Promise<Sources> {
  const none: Sources = { outcome: "error", started: 0, polled: 0, imported: 0, failed: 0 };
  try {
    const store = createSourceTickStore(token);
    if (!store) return none;
    const r = await runSourceTick({ store });
    return { outcome: r.outcome, started: r.started, polled: r.polled, imported: r.imported, failed: r.failed };
  } catch (e) {
    if (e instanceof Error && e.name === "HunterAuthError") throw e;
    return none; // never echo internals (R10)
  }
}

export async function POST(request: Request) {
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
  try {
    const sources = await sourcesTick(token);
    return Response.json({ ...hunter, sources }, { status: hunterStatus });
  } catch {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
}
