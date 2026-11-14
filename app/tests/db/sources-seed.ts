import { randomUUID } from "node:crypto";
import { as, type TestDb } from "./helpers";

// Seed for the connected-sources tests (0013): everything goes through the real RPCs as the logged-in owner.
// The "ciphertext" is a dummy of the right shape; no real key exists anywhere in tests.

export const SOURCE_CIPHER = "v1:" + "Z".repeat(60);

export async function seedSources(
  db: TestDb,
  opts: { apifyCap?: number; apolloCalls?: number } = {},
): Promise<{ ws: string; owner: string; sdr: string; closer: string }> {
  const [owner, sdr, closer] = [randomUUID(), randomUUID(), randomUUID()];
  for (const u of [owner, sdr, closer]) await db.addUser(u);
  const ws = (await db.query<{ id: string }>(as(owner), "select public.create_workspace('Empresa Fontes') as id"))[0].id;
  await db.admin("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'sdr'), ($1,$3,'closer')", [ws, sdr, closer]);
  await db.query(as(owner), "select public.set_source_connection($1,'apify',$2,'AB12',$3)", [ws, SOURCE_CIPHER, opts.apifyCap ?? null]);
  await db.query(as(owner), "select public.set_source_connection($1,'apollo',$2,'CD34',$3)", [ws, SOURCE_CIPHER, opts.apolloCalls ?? null]);
  return { ws, owner, sdr, closer };
}

export const MAPS_QUERY = { terms: ["general contractor"], location: "Worcester, MA", label: "GCs Worcester" };
