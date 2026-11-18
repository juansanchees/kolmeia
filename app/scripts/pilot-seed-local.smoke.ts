// Seeds the LOCAL Supabase for the Falmouth pilot: a test user, the workspace "Air HVAC (local)", the owner membership,
// a company profile and a call agent. Idempotent. Writes {workspace_id, user_email, user_password, agent_id} to
// PILOT_OUT_DIR/local-seed.json (chmod 600, outside the repo). Run: npm run pilot:seed
// Env: PILOT_SEED=1, PILOT_SERVICE_KEY, PILOT_OUT_DIR, optional PILOT_DATA_DIR (pilot/profile.json). Prints no secret.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { adminClient, isLocalUrl, pilotDataDir, pilotOutDir, pilotUrl, writeSeed } from "./pilot-env";

const EMAIL = "pilot-local@example.com";
const WS_NAME = "Air HVAC (local)";
const AGENT_NAME = "Piloto Falmouth (local)";
const PLACEHOLDER = { what_we_do: "HVAC installation (placeholder profile)", service_area: "Massachusetts", wanted_work: ["new_construction"], good_customer: "", not_wanted: "" };

const must = <T>(r: { data: T; error: { message: string } | null }, what: string): NonNullable<T> => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as NonNullable<T>;
};

test.skipIf(process.env.PILOT_SEED !== "1")("seed the local pilot", async () => {
  if (!isLocalUrl(pilotUrl())) throw new Error("pilot:seed runs on the LOCAL Supabase only");
  const db = adminClient();
  const out = pilotOutDir();
  const password = randomBytes(18).toString("base64url");

  // user (created once; the password is regenerated on every run)
  let userId: string | undefined;
  for (let page = 1; !userId; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    userId = data.users.find((u) => u.email === EMAIL)?.id;
    if (data.users.length < 200) break;
  }
  if (userId) {
    const u = await db.auth.admin.updateUserById(userId, { password });
    if (u.error) throw new Error(`updateUser: ${u.error.message}`);
  } else {
    const u = await db.auth.admin.createUser({ email: EMAIL, password, email_confirm: true });
    if (u.error || !u.data.user) throw new Error(`createUser: ${u.error?.message ?? "no user"}`);
    userId = u.data.user.id;
  }
  const uid: string = userId;

  // workspace + owner membership
  let ws = must(await db.from("workspaces").select("id").eq("name", WS_NAME).eq("created_by", uid).limit(1), "workspace read")[0]?.id as string | undefined;
  ws ??= must(await db.from("workspaces").insert({ name: WS_NAME, created_by: uid }).select("id").single(), "workspace insert").id as string;
  must(await db.from("workspace_members").upsert({ workspace_id: ws, user_id: uid, role: "owner" }, { onConflict: "workspace_id,user_id" }), "membership");

  // profile: the real one when PILOT_DATA_DIR/pilot/profile.json exists, else a neutral placeholder
  const pf = path.join(pilotDataDir(), "pilot", "profile.json");
  let profile: Record<string, unknown> = PLACEHOLDER;
  if (existsSync(pf)) {
    const j = JSON.parse(readFileSync(pf, "utf8")) as Record<string, unknown>;
    profile = Object.fromEntries(["what_we_do", "service_area", "wanted_work", "good_customer", "not_wanted"].filter((k) => k in j).map((k) => [k, j[k]]));
  } else console.warn("pilot:seed: no pilot/profile.json, using a placeholder profile");
  must(await db.from("company_profiles").upsert({ workspace_id: ws, ...profile }, { onConflict: "workspace_id" }), "profile");

  // call agent for the call queue (build_call_list needs a running call agent whose caller is a member)
  let agent = must(await db.from("agents").select("id").eq("workspace_id", ws).eq("type", "call").eq("name", AGENT_NAME).limit(1), "agent read")[0]?.id as string | undefined;
  if (!agent) {
    agent = must(await db.from("agents").insert({ workspace_id: ws, type: "call", name: AGENT_NAME, config: { caller_id: uid, min_level: 0, per_day: 25, temperatures: [] } }).select("id").single(), "agent insert").id as string;
    must(await db.from("agents").update({ status: "running" }).eq("id", agent), "agent run");
  }

  writeSeed(out, { workspace_id: ws, user_email: EMAIL, user_password: password, agent_id: agent });
  console.log("pilot:seed ok (workspace, user, membership, profile, call agent); seed file written");
  expect(ws).toBeTruthy();
});
