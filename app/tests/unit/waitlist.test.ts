import { beforeEach, describe, expect, it, vi } from "vitest";
import { pt } from "@/messages/pt";
import { parseWaitlist } from "@/lib/waitlist";

const rpc = vi.fn();
let configured = true;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => (configured ? { rpc } : null) }));
import { joinWaitlist } from "@/app/site/actions";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const t = pt.landing.waitlist;

describe("parseWaitlist", () => {
  it("accepts a normal e-mail and trims it", () => {
    expect(parseWaitlist(form({ email: "  voce@exemplo.com " }))).toEqual({ ok: true, email: "voce@exemplo.com" });
  });
  it("refuses empty, malformed and too long e-mails", () => {
    for (const email of ["", "sem-arroba", "a@b", "a b@exemplo.com", "x@exemplo..com", `${"a".repeat(250)}@exemplo.com`]) {
      expect(parseWaitlist(form({ email })), email).toEqual({ ok: false, reason: "invalid" });
    }
    expect(parseWaitlist(new FormData())).toEqual({ ok: false, reason: "invalid" });
  });
  it("flags a filled honeypot before anything else", () => {
    expect(parseWaitlist(form({ email: "voce@exemplo.com", website: "http://spam" }))).toEqual({ ok: false, reason: "honeypot" });
  });
});

describe("joinWaitlist", () => {
  beforeEach(() => {
    rpc.mockReset();
    configured = true;
  });
  it("calls the RPC with the e-mail and locale and returns the success message", async () => {
    rpc.mockResolvedValue({ error: null });
    expect(await joinWaitlist({ status: "idle" }, form({ email: "voce@exemplo.com" }))).toEqual({ status: "success", message: t.success });
    expect(rpc).toHaveBeenCalledWith("join_waitlist", { p_email: "voce@exemplo.com", p_locale: "pt" });
  });
  it("returns the same success for an e-mail that is already on the list (the RPC says nothing)", async () => {
    rpc.mockResolvedValue({ error: null });
    const a = await joinWaitlist({ status: "idle" }, form({ email: "voce@exemplo.com" }));
    const b = await joinWaitlist({ status: "idle" }, form({ email: "VOCE@exemplo.com" }));
    expect(b).toEqual(a);
  });
  it("answers a bot with a fake success and never calls the database", async () => {
    expect(await joinWaitlist({ status: "idle" }, form({ email: "voce@exemplo.com", website: "x" }))).toEqual({ status: "success", message: t.success });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("answers an invalid e-mail without calling the database", async () => {
    expect(await joinWaitlist({ status: "idle" }, form({ email: "nope" }))).toEqual({ status: "error", message: t.invalid });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("shows a friendly error when the RPC is missing or the database is not configured", async () => {
    rpc.mockResolvedValue({ error: { code: "PGRST202", message: "Could not find the function" } });
    expect(await joinWaitlist({ status: "idle" }, form({ email: "voce@exemplo.com" }))).toEqual({ status: "error", message: t.unavailable });
    configured = false;
    expect(await joinWaitlist({ status: "idle" }, form({ email: "voce@exemplo.com" }))).toEqual({ status: "error", message: t.unavailable });
  });
  it("maps the database's own e-mail refusal to the invalid message", async () => {
    rpc.mockResolvedValue({ error: { code: "22023", message: "invalid email" } });
    expect(await joinWaitlist({ status: "idle" }, form({ email: "voce@exemplo.com" }))).toEqual({ status: "error", message: t.invalid });
  });
});
