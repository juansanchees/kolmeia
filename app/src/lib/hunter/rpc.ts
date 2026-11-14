import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** One database function call by name. Production: PostgREST rpc with the scheduler token header. Tests: PGlite. */
export type RpcFn = (fn: string, args: Record<string, unknown>) => Promise<unknown>;

/** A database error. The message is the database's (aiCapErrorFrom needs it); it never carries row data (R10). */
export class RpcError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

/** The hunter path refused the token (42501): the route answers 401, nothing else is tried. */
export class HunterAuthError extends Error {
  constructor(message = "hunter path refused the scheduler token") {
    super(message);
    this.name = "HunterAuthError";
  }
}

export function supabaseRpc(db: SupabaseClient): RpcFn {
  return async (fn, args) => {
    const { data, error } = await db.rpc(fn, args);
    if (error) {
      if (error.code === "42501" && !/ai_cap:/.test(error.message)) throw new HunterAuthError();
      throw new RpcError(error.message, error.code);
    }
    return data;
  };
}
