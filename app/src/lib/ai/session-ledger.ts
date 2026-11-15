import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiLedger } from "./gateway";
import { reserveAiCallRpc, settleAiCallRpc } from "./ledger-rpc";

/** The ledger of a call made in the clicking user's session (no run, no lead): only reserve and settle exist. */
export function sessionLedger(db: SupabaseClient): AiLedger {
  const no = async (): Promise<never> => {
    throw new Error("use_reserve");
  };
  return {
    reserve: (r) => reserveAiCallRpc(db, r),
    settle: (id, row) => settleAiCallRpc(db, id, row),
    record: no,
    dailyCapUsd: no,
    spentTodayUsd: no,
  };
}
