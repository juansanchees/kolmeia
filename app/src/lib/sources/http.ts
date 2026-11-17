// The one HTTP seam for external sources. Tests inject a fake; production uses fetchHttpJson.
export interface HttpJson {
  request(
    method: "GET" | "POST",
    url: string,
    o: { headers: Record<string, string>; body?: unknown; timeoutMs: number },
  ): Promise<{ status: number; json: unknown; headers?: Record<string, string> }>;
}

export type SourceHttpCode = "timeout" | "network" | "bad_json";

/** The message is the code only: never a URL (it can carry a query), a header or a body. */
export class SourceHttpError extends Error {
  readonly code: SourceHttpCode;
  constructor(code: SourceHttpCode) {
    super(`source_http_${code}`);
    this.name = "SourceHttpError";
    this.code = code;
  }
}

export const fetchHttpJson: HttpJson = {
  async request(method, url, o) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { ...(o.body !== undefined ? { "Content-Type": "application/json" } : {}), ...o.headers },
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
        signal: AbortSignal.timeout(o.timeoutMs),
        cache: "no-store",
      });
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      throw new SourceHttpError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
    }
    let json: unknown = null;
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new SourceHttpError("network");
    }
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // An error status with a non-JSON body is still an error status for the caller; only a 2xx must be JSON.
        if (res.ok) throw new SourceHttpError("bad_json");
      }
    }
    return { status: res.status, json, headers: Object.fromEntries(res.headers) }; // keys lower-case (quota headers)
  },
};
