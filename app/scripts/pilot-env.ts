// Shared guards and clients for the Falmouth pilot scripts (pilot-seed-local, pilot-falmouth, eval-falmouth).
// Rules: local Supabase only (the dev project needs PILOT_ALLOW_DEV=1, prod is always refused); private inputs and
// outputs live OUTSIDE this public repo; keys come from the env (or the macOS Keychain) and are never printed or written.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseCsv } from "@/lib/leads/baseline";

export const PROD_REF = "qkrlfmtmvllugkgvafxt";
export const DEV_REF = "drkonindwshyyaemkcod";
export const LOCAL_URL = "http://127.0.0.1:54321";
type Env = Record<string, string | undefined>;
const REPO = path.resolve(import.meta.dirname, "..", "..");
/** This checkout and, when it is a git worktree, the main checkout too: both are the public repo. */
export const REPO_ROOTS: string[] = [...new Set([REPO, mainCheckout(REPO)])];
function mainCheckout(repo: string): string {
  try {
    return path.dirname(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    // no git: a worktree made by Claude Code lives at <main>/.claude/worktrees/<name>
    return repo.split(`${path.sep}.claude${path.sep}worktrees${path.sep}`)[0];
  }
}
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function assertOutsideRepo(dir: string, name: string, repo: string | string[] = REPO_ROOTS): string {
  const p = path.resolve(dir);
  if ([repo].flat().some((r) => p === r || p.startsWith(r + path.sep))) throw new Error(`${name} must be outside kolmeia/ (public repo)`);
  return p;
}

/** PILOT_DATA_DIR: private inputs, must exist and be outside the repo. */
export function pilotDataDir(env: Env = process.env, repo: string | string[] = REPO_ROOTS): string {
  const p = assertOutsideRepo(env.PILOT_DATA_DIR || path.join(os.homedir(), "Documents", "Hvac - Project", "data"), "PILOT_DATA_DIR", repo);
  if (!existsSync(p)) throw new Error("PILOT_DATA_DIR does not exist");
  return p;
}

/** PILOT_OUT_DIR: reports and the local seed file, outside the repo; created when missing. */
export function pilotOutDir(env: Env = process.env, repo: string | string[] = REPO_ROOTS): string {
  const p = assertOutsideRepo(env.PILOT_OUT_DIR || path.join(os.homedir(), "kolmeia-pilot-out"), "PILOT_OUT_DIR", repo);
  mkdirSync(p, { recursive: true });
  return p;
}

export function isDevUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname === `${DEV_REF}.supabase.co`;
  } catch {
    return false;
  }
}

export function isLocalUrl(raw: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/** The API URL the pilot may touch: local always; the dev ref only with PILOT_ALLOW_DEV=1; the prod ref never. */
export function pilotUrl(env: Env = process.env): string {
  const raw = env.PILOT_SUPABASE_URL || LOCAL_URL;
  if (raw.includes(PROD_REF)) throw new Error("PILOT_SUPABASE_URL points at production: refused");
  if (isLocalUrl(raw)) return raw;
  // by parsed hostname: a dev ref in the path or query of another host never qualifies
  if (env.PILOT_ALLOW_DEV === "1" && isDevUrl(raw)) return raw;
  throw new Error("PILOT_SUPABASE_URL must be local (or the dev project with PILOT_ALLOW_DEV=1)");
}

function keychain(service: string): string {
  try {
    return execFileSync("security", ["find-generic-password", "-a", "kolmeia-pilot", "-s", service, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** Local admin key: env PILOT_SERVICE_KEY, else the Keychain item `kolmeia-pilot-local`. Never logged. */
export function pilotAdminKey(env: Env = process.env): string {
  const k = env.PILOT_SERVICE_KEY || keychain("kolmeia-pilot-local");
  if (!k) throw new Error("PILOT_SERVICE_KEY is not set (export it from `npx supabase status -o env`)");
  return k;
}
export function pilotAnonKey(env: Env = process.env): string {
  if (!env.PILOT_ANON_KEY) throw new Error("PILOT_ANON_KEY is not set");
  return env.PILOT_ANON_KEY;
}

const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false } } as const;
/** kb_* functions and the seed: the local admin key. */
export const adminClient = (env: Env = process.env): SupabaseClient => createClient(pilotUrl(env), pilotAdminKey(env), NO_SESSION);
/** hunt_* functions are member-only: a local test user, anon key + password sign-in. */
export async function userClient(email: string, password: string, env: Env = process.env): Promise<SupabaseClient> {
  const c = createClient(pilotUrl(env), pilotAnonKey(env), NO_SESSION);
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error("pilot user sign-in failed (run pilot:seed again)");
  return c;
}

export type LocalSeed = { workspace_id: string; user_email: string; user_password: string; agent_id: string | null };
export const seedPath = (out: string) => path.join(out, "local-seed.json");
export function writeSeed(out: string, s: LocalSeed): void {
  const f = seedPath(out);
  writeFileSync(f, JSON.stringify(s, null, 2), { mode: 0o600 });
  chmodSync(f, 0o600);
}
export function readSeed(out: string): LocalSeed {
  if (!existsSync(seedPath(out))) throw new Error("local-seed.json not found in PILOT_OUT_DIR (run pilot:seed first)");
  return JSON.parse(readFileSync(seedPath(out), "utf8")) as LocalSeed;
}

const quote = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
/** Keeps the data rows `keep` accepts (rows are objects by header name); the header stays. */
export function filterCsv(csv: string, keep: (r: Record<string, string>) => boolean): string {
  const [head, ...rows] = parseCsv(csv);
  if (!head) return "";
  const h = head.map((x) => x.trim());
  const kept = rows.filter((r) => keep(Object.fromEntries(h.map((k, i) => [k, (r[i] ?? "").trim()]))));
  return [head, ...kept].map((r) => r.map(quote).join(",")).join("\n") + "\n";
}

export const need = (name: string, env: Env = process.env): string => {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};
