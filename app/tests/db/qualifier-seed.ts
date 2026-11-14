import { randomUUID } from "node:crypto";
import { anonWithToken, as, setSchedulerToken, type TestDb } from "./helpers";
import { TOKEN } from "./scheduler-seed";

// Seeds for the Qualificador path tests (0014 part 2): an owner with a workspace and one lead, fictional data only.

/** The public key plus the scheduler token header, as the Qualificador tick calls the database. */
export const qclock = anonWithToken(TOKEN);

/**
 * A new owner (on the AI allowlist) with a workspace and one lead. Its queue row and the workspace's Qualificador are
 * born with them, by the database. `fields` are imported values (status unverified unless given).
 */
export async function seedQualifierLead(
  db: TestDb,
  opts: { fields?: { field: string; value: string; source?: string; status?: string }[]; origin?: "import" | "agent" } = {},
): Promise<{ ws: string; owner: string; lead: string }> {
  const owner = randomUUID();
  await db.addUser(owner);
  const ws = (await db.query<{ id: string }>(as(owner), "select public.create_workspace('Empresa Qualificador') as id"))[0].id;
  const lead = (
    await db.admin<{ id: string }>("insert into public.leads (workspace_id, origin_kind) values ($1,$2) returning id", [ws, opts.origin ?? "import"])
  )[0].id;
  let i = 0;
  for (const f of opts.fields ?? []) {
    await db.admin(
      "insert into public.lead_fields (workspace_id, lead_id, field, value, source, source_ref, status) values ($1,$2,$3,$4,$5,$6,$7)",
      [ws, lead, f.field, f.value, f.source ?? "import", `seed-${i++}`, f.status ?? "unverified"],
    );
  }
  return { ws, owner, lead };
}

/** Opens a Qualificador tick as the clock (sets the scheduler token first). */
export async function beginQualifierTick(db: TestDb): Promise<string> {
  await setSchedulerToken(db, TOKEN);
  const r = await db.query<{ r: { tick_id: string; busy: boolean } }>(qclock, "select public.qualifier_begin_tick() as r");
  if (r[0].r.busy) throw new Error("beginQualifierTick: another tick is open");
  return r[0].r.tick_id;
}
