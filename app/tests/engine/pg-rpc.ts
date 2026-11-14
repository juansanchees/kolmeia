import { HunterAuthError, RpcError, type RpcFn } from "@/lib/hunter/rpc";
import { anonWithToken, setSchedulerToken, type TestDb } from "../db/helpers";

/**
 * The hunter RPCs over PGlite: every call is one committed statement as `anon` with the scheduler token header,
 * the way PostgREST would run it. Errors mirror supabaseRpc (42501 -> HunterAuthError, except an AI cap refusal).
 */
export function pgRpc(db: TestDb, token: string): RpcFn {
  const actor = anonWithToken(token);
  return async (fn, args) => {
    if (!/^hunter_[a-z_]+$/.test(fn)) throw new Error(`not a hunter function: ${fn}`);
    const keys = Object.keys(args);
    const params = keys.map((k) => {
      const v = args[k];
      return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
    });
    const named = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
    try {
      await setSchedulerToken(db, token);
      const rows = await db.query<{ r: unknown }>(actor, `select public.${fn}(${named}) as r`, params);
      return rows[0]?.r ?? null;
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "42501" && !/ai_cap:/.test(err.message)) throw new HunterAuthError();
      throw new RpcError(err.message, err.code);
    }
  };
}
