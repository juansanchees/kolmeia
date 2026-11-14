import "server-only";
import { isSender, type Role } from "@/lib/roles";
import { parseAgentSources, parseApolloForm, parseMapsForm, type AgentSourcesInput } from "./view";

// Manual searches and per-agent sources: the testable core of the server actions. Every result is a fixed code:
// never a database or service message (it could carry a key or a query).

export type SearchError = "notAllowed" | "invalid" | "capHit" | "notConnected" | "generic";
export type SearchResult = { ok: true } | { error: SearchError };
export type SearchRpc = (fn: string, args: Record<string, unknown>) => Promise<{ error: { code?: string; message?: string } | null }>;
type Who = { ws: string; role: Role };

/** The two named failures of enqueue_source_run, then the generic ones. The message is only compared, never returned. */
function rpcError(e: { code?: string; message?: string }): SearchError {
  if (e.message === "source_cap") return "capHit";
  if (e.message === "source_not_connected") return "notConnected";
  if (e.code === "42501") return "notAllowed";
  if (e.code === "22023" || e.code === "23514") return "invalid";
  return "generic";
}

async function enqueue(who: Who, kind: "maps" | "apollo", parsed: { ok: true; value: { query: object; max: number } } | { ok: false }, rpc: SearchRpc): Promise<SearchResult> {
  if (!isSender(who.role)) return { error: "notAllowed" };
  if (!parsed.ok) return { error: "invalid" };
  const { error } = await rpc("enqueue_source_run", { p_ws: who.ws, p_kind: kind, p_query: parsed.value.query, p_max: parsed.value.max });
  return error ? { error: rpcError(error) } : { ok: true };
}

export async function enqueueMapsCore(who: Who, input: Parameters<typeof parseMapsForm>[0], deps: { rpc: SearchRpc }): Promise<SearchResult> {
  return enqueue(who, "maps", isSender(who.role) ? parseMapsForm(input) : { ok: false }, deps.rpc);
}

export async function enqueueApolloCore(who: Who, input: Parameters<typeof parseApolloForm>[0], deps: { rpc: SearchRpc }): Promise<SearchResult> {
  return enqueue(who, "apollo", isSender(who.role) ? parseApolloForm(input) : { ok: false }, deps.rpc);
}

export async function saveAgentSourcesCore(who: Who, input: AgentSourcesInput, deps: { rpc: SearchRpc }): Promise<SearchResult> {
  if (!isSender(who.role)) return { error: "notAllowed" };
  const parsed = parseAgentSources(input);
  if (!parsed.ok) return { error: "invalid" };
  const { agent, ...payload } = parsed.value;
  const { error } = await deps.rpc("set_agent_source_settings", { p_agent: agent, p: payload });
  return error ? { error: rpcError(error) } : { ok: true };
}
