import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sourceAad, SecretError } from "@/lib/email/crypto";
import { deleteKeyCore, last4, openKey, parseCap, saveCapCore, saveKeyCore, sealKey, testKey, validateKeyShape, type Rpc } from "@/lib/sources/connections";
import { fakeHttp } from "./sources-fakes";

const WS = "11111111-1111-4111-8111-111111111111";
const KEY = "apify_api_TESTKEY0000";
const original = process.env.MAILBOX_ENC_KEY;
beforeAll(() => {
  process.env.MAILBOX_ENC_KEY = randomBytes(32).toString("base64");
});
afterAll(() => {
  if (original === undefined) delete process.env.MAILBOX_ENC_KEY;
  else process.env.MAILBOX_ENC_KEY = original;
});

const recorder = (error: { code?: string } | null = null) => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc: Rpc = async (fn, args) => {
    calls.push({ fn, args });
    return { error };
  };
  return { calls, rpc };
};

describe("F3d connections", () => {
  test("sourceAad binds workspace and provider: a key sealed for apify does not open as apollo", () => {
    expect(sourceAad(WS, "apify")).toBe(`source:${WS}:apify`);
    const ct = sealKey(WS, "apify", KEY);
    expect(openKey(WS, "apify", ct)).toBe(KEY);
    expect(() => openKey(WS, "apollo", ct)).toThrow(SecretError);
    expect(() => openKey("22222222-2222-4222-8222-222222222222", "apify", ct)).toThrow(SecretError);
    expect(ct).not.toContain(KEY);
  });

  test("last4 and masking", () => {
    expect(last4(` ${KEY} `)).toBe("0000");
    expect(validateKeyShape("apify", KEY)).toBe(true);
    expect(validateKeyShape("apollo", "short")).toBe(false);
    expect(validateKeyShape("apify", "has space in the key 123456")).toBe(false);
    expect(validateKeyShape("apify", "a".repeat(201))).toBe(false);
    expect(validateKeyShape("apify", "a".repeat(200))).toBe(true);
  });

  test("caps: apify 0.50..50, apollo whole 1..200, blank keeps", () => {
    expect(parseCap("apify", "2,5")).toBe(2.5);
    expect(parseCap("apify", "0.4")).toBe("capRange");
    expect(parseCap("apify", "51")).toBe("capRange");
    expect(parseCap("apollo", "20.5")).toBe("capRange");
    expect(parseCap("apollo", "200")).toBe(200);
    expect(parseCap("apollo", "")).toBeNull();
  });

  test("saving a refused key returns keyBad and the error carries no key", async () => {
    // the service answers 401 and echoes the request (key included)
    const http = fakeHttp({ "GET https://api.apify.com/v2/users/me": { status: 401, json: { error: { message: `bad token ${KEY}` } } } });
    const { rpc, calls } = recorder();
    const r = await saveKeyCore({ ws: WS, role: "owner" }, { provider: "apify", key: KEY, cap: "" }, { http, rpc });
    expect(r).toEqual({ error: "keyBad" });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(calls).toEqual([]); // nothing stored
    // a thrown transport error that echoes the key is also swallowed
    const boom = fakeHttp({ "GET https://api.apify.com/v2/users/me": new Error(`fetch failed for ${KEY}`) });
    const r2 = await saveKeyCore({ ws: WS, role: "owner" }, { provider: "apify", key: KEY, cap: "" }, { http: boom, rpc });
    expect(r2).toEqual({ error: "unreachable" });
    expect(JSON.stringify(r2)).not.toContain(KEY);
  });

  test("a good key is tested with the typed plaintext, then sealed; the RPC gets ciphertext and last4 only", async () => {
    const http = fakeHttp({ "GET https://api.apify.com/v2/users/me": { status: 200, json: { data: {} } } });
    const { rpc, calls } = recorder();
    const r = await saveKeyCore({ ws: WS, role: "owner" }, { provider: "apify", key: ` ${KEY} `, cap: "3" }, { http, rpc });
    expect(r).toEqual({ ok: true });
    expect(http.calls[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe("set_source_connection");
    expect(calls[0].args).toMatchObject({ p_ws: WS, p_provider: "apify", p_last4: "0000", p_cap: 3 });
    expect(JSON.stringify(calls[0].args)).not.toContain(KEY);
    expect(openKey(WS, "apify", calls[0].args.p_ciphertext as string)).toBe(KEY);
  });

  test("only the owner saves, caps or deletes; bad shape never reaches the network", async () => {
    const http = fakeHttp({});
    const { rpc, calls } = recorder();
    for (const role of ["sdr", "closer"] as const) {
      expect(await saveKeyCore({ ws: WS, role }, { provider: "apify", key: KEY, cap: "" }, { http, rpc })).toEqual({ error: "notAllowed" });
      expect(await saveCapCore({ ws: WS, role }, { provider: "apify", cap: "2" }, { rpc })).toEqual({ error: "notAllowed" });
      expect(await deleteKeyCore({ ws: WS, role }, { provider: "apify" }, { rpc })).toEqual({ error: "notAllowed" });
    }
    expect(await saveKeyCore({ ws: WS, role: "owner" }, { provider: "apify", key: "nope", cap: "" }, { http, rpc })).toEqual({ error: "keyShape" });
    expect(await saveKeyCore({ ws: WS, role: "owner" }, { provider: "other", key: KEY, cap: "" }, { http, rpc })).toEqual({ error: "generic" });
    expect(http.calls).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("apollo key check: is_logged_in false and a bare 403 are refused; explicit API_INACCESSIBLE is ok; true is ok", async () => {
    const url = "GET https://api.apollo.io/";
    const t = (r: { status: number; json: unknown }) => testKey("apollo", KEY, fakeHttp({ [url]: r }));
    expect(await t({ status: 401, json: {} })).toBe("refused");
    expect(await t({ status: 200, json: { is_logged_in: false } })).toBe("refused");
    expect(await t({ status: 200, json: { healthy: true } })).toBe("refused");
    expect(await t({ status: 403, json: {} })).toBe("refused");
    expect(await t({ status: 403, json: { error_code: "API_INACCESSIBLE" } })).toBe("ok");
    expect(await t({ status: 200, json: { is_logged_in: true } })).toBe("ok");
    expect(await t({ status: 500, json: {} })).toBe("unreachable");
  });

  test("shovels: key tested on /usage (401/403 refused, network unreachable), cap is whole records 50..50000", async () => {
    const url = "GET https://api.shovels.ai/v2/usage";
    const t = (r: { status: number; json: unknown } | Error) => testKey("shovels", KEY, fakeHttp({ [url]: r }));
    expect(await t({ status: 200, json: { credits_used: 3, credit_limit: 500 } })).toBe("ok");
    expect(await t({ status: 401, json: {} })).toBe("refused");
    expect(await t({ status: 403, json: {} })).toBe("refused");
    expect(await t(new Error("network"))).toBe("unreachable");
    expect(parseCap("shovels", "500")).toBe(500);
    expect(parseCap("shovels", "49")).toBe("capRange");
    expect(parseCap("shovels", "50001")).toBe("capRange");
    expect(parseCap("shovels", "100.5")).toBe("capRange");
    const http = fakeHttp({ [url]: { status: 200, json: { credits_used: 0, credit_limit: 500 } } });
    const { rpc, calls } = recorder();
    expect(await saveKeyCore({ ws: WS, role: "owner" }, { provider: "shovels", key: KEY, cap: "" }, { http, rpc })).toEqual({ ok: true });
    expect(calls[0].args).toMatchObject({ p_provider: "shovels", p_cap: null });
    expect(openKey(WS, "shovels", calls[0].args.p_ciphertext as string)).toBe(KEY);
  });

  test("last4 uses alphanumerics only: a key ending in a hyphen stores a valid last4", async () => {
    const dashKey = "apify_api_TESTKEY12-";
    expect(last4(dashKey)).toBe("EY12");
    expect(last4(dashKey)).toMatch(/^[A-Za-z0-9]{4}$/);
    expect(last4("----")).toBe("");
    const http = fakeHttp({ "GET https://api.apify.com/v2/users/me": { status: 200, json: { data: {} } } });
    const { rpc, calls } = recorder();
    expect(await saveKeyCore({ ws: WS, role: "owner" }, { provider: "apify", key: dashKey, cap: "" }, { http, rpc })).toEqual({ ok: true });
    expect(calls[0].args.p_last4).toMatch(/^[A-Za-z0-9]{4}$/);
  });

  test("a check violation from set_source_connection is generic, not the cap message", async () => {
    const http = fakeHttp({ "GET https://api.apify.com/v2/users/me": { status: 200, json: { data: {} } } });
    expect(await saveKeyCore({ ws: WS, role: "owner" }, { provider: "apify", key: KEY, cap: "" }, { http, rpc: recorder({ code: "23514" }).rpc })).toEqual({ error: "generic" });
  });

  test("cap and delete go through the owner RPCs with the session workspace", async () => {
    const { rpc, calls } = recorder();
    expect(await saveCapCore({ ws: WS, role: "owner" }, { provider: "apollo", cap: "30" }, { rpc })).toEqual({ ok: true });
    expect(await deleteKeyCore({ ws: WS, role: "owner" }, { provider: "apollo" }, { rpc })).toEqual({ ok: true });
    expect(calls.map((c) => [c.fn, c.args.p_ws])).toEqual([["set_source_cap", WS], ["delete_source_connection", WS]]);
    expect((await saveCapCore({ ws: WS, role: "owner" }, { provider: "apify", cap: "99" }, { rpc })) as object).toEqual({ error: "capRange" });
    expect(await deleteKeyCore({ ws: WS, role: "owner" }, { provider: "apify" }, recorder({ code: "42501" }))).toEqual({ error: "notAllowed" });
  });
});
