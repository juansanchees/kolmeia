import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

let claims: { sub: string } | null = null;
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-test" } }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getClaims: async () => ({ data: claims ? { claims } : null }) } }) }));
import { updateSession } from "@/lib/supabase/proxy";

const run = (path: string) => updateSession(new NextRequest(`http://localhost:3000${path}`));
const rewritten = (res: Response) => res.headers.get("x-middleware-rewrite");
const location = (res: Response) => res.headers.get("location");

describe("proxy: landing at / for anonymous visitors", () => {
  beforeEach(() => {
    claims = null;
  });
  it("rewrites / to /site (no redirect)", async () => {
    const res = await run("/");
    expect(rewritten(res)).toBe("http://localhost:3000/site");
    expect(location(res)).toBeNull();
  });
  it("serves /site itself without a redirect", async () => {
    const res = await run("/site");
    expect(location(res)).toBeNull();
    expect(rewritten(res)).toBeNull();
  });
  it("still sends every other anonymous path to /login", async () => {
    for (const p of ["/leads", "/inicio", "/campanhas/abc", "/api/research/x/advance", "/sitemap"]) {
      expect(location(await run(p)), p).toBe("http://localhost:3000/login");
    }
  });
  it("keeps the other public paths public", async () => {
    for (const p of ["/login", "/u/token", "/api/unsubscribe/token", "/api/scheduler/tick", "/api/hunter/tick"]) {
      expect(location(await run(p)), p).toBeNull();
    }
  });
  it("leaves signed-in people on the app: no rewrite at /, and /login still bounces to /", async () => {
    claims = { sub: "user-1" };
    const home = await run("/");
    expect(rewritten(home)).toBeNull();
    expect(location(home)).toBeNull();
    expect(location(await run("/login"))).toBe("http://localhost:3000/");
  });
});
