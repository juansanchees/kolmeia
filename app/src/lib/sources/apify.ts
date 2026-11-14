// Apify REST client. The token travels only in the Authorization header: never in a URL, a log line or an error.
import { SourceHttpError, type HttpJson } from "./http";
import type { ApifyStatus } from "./types";

const BASE = "https://api.apify.com/v2";
const TIMEOUT_MS = 10_000;
export const APIFY_RUN_TIMEOUT_SECS = 600;

export type ApifyErrorCode = "refused" | `http_${number}` | "bad_response";

/** The message is the code only (the response body can echo the request, token included). */
export class ApifyError extends Error {
  readonly code: ApifyErrorCode;
  constructor(code: ApifyErrorCode) {
    super(`apify_${code}`);
    this.name = "ApifyError";
    this.code = code;
  }
}

const STATUSES: readonly string[] = ["READY", "RUNNING", "SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT", "ABORTING", "TIMING-OUT"];

const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function apifyClient(token: string, http: HttpJson) {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };

  /** Never lets a transport error through with anything but its code. */
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    try {
      return await http.request(method, `${BASE}${path}`, { headers, body, timeoutMs: TIMEOUT_MS });
    } catch (e) {
      throw e instanceof SourceHttpError ? e : new SourceHttpError("network");
    }
  }

  function ok(r: { status: number; json: unknown }): unknown {
    if (r.status === 401 || r.status === 403) throw new ApifyError("refused");
    if (r.status < 200 || r.status >= 300) throw new ApifyError(`http_${r.status}`);
    return r.json;
  }

  return {
    async checkKey(): Promise<"ok" | "refused" | "unreachable"> {
      try {
        const r = await call("GET", "/users/me");
        if (r.status === 401 || r.status === 403) return "refused";
        return r.status >= 200 && r.status < 300 ? "ok" : "unreachable";
      } catch {
        return "unreachable";
      }
    },

    async start(actor: string, input: object, maxChargeUsd: number): Promise<{ runId: string; datasetId: string }> {
      const q = `maxTotalChargeUsd=${encodeURIComponent(String(maxChargeUsd))}&timeout=${APIFY_RUN_TIMEOUT_SECS}`;
      const data = asObj(asObj(ok(await call("POST", `/acts/${encodeURIComponent(actor)}/runs?${q}`, input)))?.data);
      const runId = data?.id;
      const datasetId = data?.defaultDatasetId;
      if (typeof runId !== "string" || !runId || typeof datasetId !== "string" || !datasetId) throw new ApifyError("bad_response");
      return { runId, datasetId };
    },

    async status(runId: string): Promise<{ status: ApifyStatus; usageUsd: number | null }> {
      const data = asObj(asObj(ok(await call("GET", `/actor-runs/${encodeURIComponent(runId)}`)))?.data);
      const status = data?.status;
      if (typeof status !== "string" || !STATUSES.includes(status)) throw new ApifyError("bad_response");
      const u = data?.usageTotalUsd;
      return { status: status as ApifyStatus, usageUsd: typeof u === "number" && Number.isFinite(u) && u >= 0 ? u : null };
    },

    async items(datasetId: string, limit: number): Promise<unknown[]> {
      const json = ok(await call("GET", `/datasets/${encodeURIComponent(datasetId)}/items?clean=true&format=json&limit=${Math.max(1, Math.floor(limit))}`));
      if (!Array.isArray(json)) throw new ApifyError("bad_response");
      return json;
    },

    async abort(runId: string): Promise<void> {
      ok(await call("POST", `/actor-runs/${encodeURIComponent(runId)}/abort`));
    },
  };
}
