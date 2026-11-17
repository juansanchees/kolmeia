import "server-only";
import { MailboxKeyError } from "@/lib/email/config";
import { decryptSecret, encryptSecret, sourceAad } from "@/lib/email/crypto";
import type { Role } from "@/lib/roles";
import { apifyClient } from "./apify";
import { apolloClient, ApolloKeyError, ApolloPlanError } from "./apollo";
import type { HttpJson } from "./http";
import { shovelsClient } from "./shovels";

// Connected sources: keys are encrypted here, on the server, and stored by the owner-only RPC set_source_connection.
// A key never leaves in a result, a log line or an error; clients only ever see the last 4 characters.

export type Provider = "apify" | "apollo" | "shovels" | "rapidapi";
export const PROVIDERS: readonly Provider[] = ["apify", "apollo", "shovels", "rapidapi"];
export const isProvider = (v: unknown): v is Provider => (PROVIDERS as readonly unknown[]).includes(v);
/** What a cap form may set: a provider's own cap, or RapidAPI's second one (company sites read per 30 days). */
export type CapTarget = Provider | "rapidapi_sites";
const isCapTarget = (v: unknown): v is CapTarget => isProvider(v) || v === "rapidapi_sites";

/**
 * The bounds of the caps (same as the database): Apify US$/day, Apollo searches/day, Shovels records per rolling 30 days,
 * RapidAPI B2B calls and company sites read per rolling 30 days.
 */
export const CAP_LIMITS = {
  apify: { min: 0.5, max: 50 },
  apollo: { min: 1, max: 200 },
  shovels: { min: 50, max: 50000 },
  rapidapi: { min: 1, max: 5000 },
  rapidapi_sites: { min: 1, max: 50000 },
} as const;

/** Last 4 ALPHANUMERIC characters (the database allows only [A-Za-z0-9]{4}); "" when there are fewer than 4. */
export function last4(key: string): string {
  const alnum = key.replace(/[^A-Za-z0-9]/g, "");
  return alnum.length < 4 ? "" : alnum.slice(-4);
}

/** Trimmed, 16..200 chars, letters, digits, underscore and hyphen only. */
export function validateKeyShape(_p: Provider, key: string): boolean {
  const k = key.trim();
  return k.length >= 16 && k.length <= 200 && /^[A-Za-z0-9_-]+$/.test(k);
}

/** Does the service accept this key? Only an explicit API_INACCESSIBLE (Apollo plan limit) still means the key works; a bare 403 is refused. */
export async function testKey(p: Provider, key: string, http: HttpJson): Promise<"ok" | "refused" | "unreachable"> {
  const k = key.trim();
  if (p === "apify") return apifyClient(k, http).checkKey();
  if (p === "shovels") return shovelsClient(k, http).checkKey();
  // every RapidAPI request spends the plan's quota and there is no free endpoint: the key is checked by shape only
  // (validateKeyShape); a wrong key shows up as "chave recusada" on the first search.
  if (p === "rapidapi") return "ok";
  try {
    await apolloClient(k, http).checkKey();
    return "ok";
  } catch (e) {
    if (e instanceof ApolloKeyError) return "refused";
    if (e instanceof ApolloPlanError) return "ok";
    return "unreachable";
  }
}

export function sealKey(ws: string, p: Provider, key: string): string {
  return encryptSecret(key.trim(), sourceAad(ws, p));
}

export function openKey(ws: string, p: Provider, ciphertext: string): string {
  return decryptSecret(ciphertext, sourceAad(ws, p));
}

export type SourceError = "keyBad" | "keyShape" | "unreachable" | "noKey" | "notAllowed" | "capRange" | "generic";
export type SourceResult = { ok: true } | { error: SourceError };
export const sourceOk: SourceResult = { ok: true };

export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ error: { code?: string } | null }>;

/** "" / missing -> null (keep the cap); otherwise a number in range (integer for Apollo and Shovels), else "capRange". */
export function parseCap(p: CapTarget, raw: unknown): number | null | "capRange" {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const n = Number(String(raw).trim().replace(",", "."));
  const { min, max } = CAP_LIMITS[p];
  if (!Number.isFinite(n) || n < min || n > max) return "capRange";
  if (p !== "apify" && !Number.isInteger(n)) return "capRange";
  return Math.round(n * 100) / 100;
}

type Who = { ws: string; role: Role };
// Cap-only RPCs report a bad cap (23514/22023); set_source_connection can also fail a check on the key columns, so there it is "generic".
const rpcError = (e: { code?: string }, capRpc = true): SourceError =>
  e.code === "42501" ? "notAllowed" : capRpc && (e.code === "23514" || e.code === "22023") ? "capRange" : "generic";

/**
 * Tests the key the user just typed, seals it and stores it. The result never contains the key: every failure
 * is a fixed code. The workspace comes from the session, never from the form.
 */
export async function saveKeyCore(
  who: Who,
  input: { provider: unknown; key: unknown; cap: unknown },
  deps: { http: HttpJson; rpc: Rpc },
): Promise<SourceResult> {
  if (who.role !== "owner") return { error: "notAllowed" };
  if (!isProvider(input.provider) || typeof input.key !== "string") return { error: "generic" };
  const p = input.provider;
  if (!validateKeyShape(p, input.key)) return { error: "keyShape" };
  const cap = parseCap(p, input.cap);
  if (cap === "capRange") return { error: "capRange" };
  const verdict = await testKey(p, input.key, deps.http).catch(() => "unreachable" as const);
  if (verdict === "refused") return { error: "keyBad" };
  if (verdict === "unreachable") return { error: "unreachable" };
  let sealed: string;
  try {
    sealed = sealKey(who.ws, p, input.key);
  } catch (e) {
    return { error: e instanceof MailboxKeyError ? "noKey" : "generic" };
  }
  const tail = last4(input.key);
  if (!tail) return { error: "keyShape" };
  const { error } = await deps.rpc("set_source_connection", { p_ws: who.ws, p_provider: p, p_ciphertext: sealed, p_last4: tail, p_cap: cap });
  return error ? { error: rpcError(error, false) } : sourceOk;
}

export async function saveCapCore(who: Who, input: { provider: unknown; cap: unknown }, deps: { rpc: Rpc }): Promise<SourceResult> {
  if (who.role !== "owner") return { error: "notAllowed" };
  if (!isCapTarget(input.provider)) return { error: "generic" };
  const cap = parseCap(input.provider, input.cap);
  if (cap === "capRange" || cap === null) return { error: "capRange" };
  const { error } = await deps.rpc("set_source_cap", { p_ws: who.ws, p_provider: input.provider, p_cap: cap });
  return error ? { error: rpcError(error) } : sourceOk;
}

export async function deleteKeyCore(who: Who, input: { provider: unknown }, deps: { rpc: Rpc }): Promise<SourceResult> {
  if (who.role !== "owner") return { error: "notAllowed" };
  if (!isProvider(input.provider)) return { error: "generic" };
  const { error } = await deps.rpc("delete_source_connection", { p_ws: who.ws, p_provider: input.provider });
  return error ? { error: rpcError(error) } : sourceOk;
}
