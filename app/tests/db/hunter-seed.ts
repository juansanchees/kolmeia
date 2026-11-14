import type { Rigor } from "@/lib/research/types";
import { anonWithToken, as, setSchedulerToken, UUID_A, type TestDb } from "./helpers";
import { TOKEN, createOwner } from "./scheduler-seed";

// Seeds for the hunter-path tests (0010): everything goes through the real functions as the logged-in owner,
// fictional data only.

export type Schedule = "once" | "weekly" | "daily";
/** The public key plus the scheduler token header, as the hunter tick calls the database. */
export const clock = anonWithToken(TOKEN);

/**
 * A hunter with a setup run that has a plan, paused by the owner (A3) and then turned on (Ligar), unless `ligar: false`.
 * `ws`: seed another agent into an existing workspace (at most 3 running hunters per workspace). Without it the owner
 * gets a new workspace (`userId` must be a new user then).
 */
export async function seedHunter(
  db: TestDb,
  opts: { schedule?: Schedule; rigor?: Rigor; userId?: string; ws?: string; ligar?: boolean } = {},
): Promise<{ ws: string; agent: string; setupRun: string }> {
  const { schedule = "weekly", rigor = "careful", userId = UUID_A, ligar = true } = opts;
  const ws = opts.ws ?? (await createOwner(db, userId));
  const agent = (
    await db.query<{ id: string }>(
      as(userId),
      "insert into public.agents (workspace_id, type, name, schedule, config) values ($1,'hunter','Caçador de prédios',$2,$3::jsonb) returning id",
      [ws, schedule, JSON.stringify({ rigor })],
    )
  )[0].id;
  const setupRun = (
    await db.query<{ id: string }>(
      as(userId),
      "insert into public.research_runs (workspace_id, title, request_text, region_text, rigor, setup_agent_id) values ($1,'Setup','Construtoras de prédios multifamiliares','Worcester, MA',$2,$3) returning id",
      [ws, rigor, agent],
    )
  )[0].id;
  await db.admin("update public.research_runs set status = 'plan', plan = '{\"steps\":[\"collect\"]}'::jsonb, answers = '{\"q1\":\"sim\"}'::jsonb where id = $1", [setupRun]);
  await db.query(as(userId), "update public.agents set status = 'paused' where id = $1", [agent]);
  if (ligar) await db.query(as(userId), "update public.agents set status = 'running' where id = $1", [agent]);
  return { ws, agent, setupRun };
}

/** Opens a tick as the clock (sets the scheduler token first). */
export async function beginTick(db: TestDb): Promise<string> {
  await setSchedulerToken(db, TOKEN);
  const r = await db.query<{ r: { tick_id: string; busy: boolean } }>(clock, "select public.hunter_begin_tick() as r");
  if (r[0].r.busy) throw new Error("beginTick: another tick is open");
  return r[0].r.tick_id;
}
