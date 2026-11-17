import { describe, expect, it, vi } from "vitest";

// The setup file mocks this module for every other test; here the real one reads a mocked cookie jar.
vi.unmock("@/lib/i18n/server");
const jar = vi.hoisted(() => ({ value: undefined as string | undefined, set: [] as unknown[][] }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "kolmeia_locale" && jar.value !== undefined ? { name, value: jar.value } : undefined),
    set: (...a: unknown[]) => jar.set.push(a),
  }),
}));

describe("getLocale / getT", () => {
  it("reads kolmeia_locale; missing or invalid is Portuguese", async () => {
    for (const [value, want] of [[undefined, "pt"], ["en", "en"], ["pt", "pt"], ["xx", "pt"]] as const) {
      jar.value = value;
      vi.resetModules();
      const { getLocale, getT } = await import("@/lib/i18n/server");
      expect(await getLocale()).toBe(want);
      expect((await getT()).intl).toBe(want === "en" ? "en-US" : "pt-BR");
    }
  });
});

describe("setLocaleAction (PT | EN switch)", () => {
  it("stores the choice for a year on the whole site; anything but en stores pt", async () => {
    const { setLocaleAction } = await import("@/lib/i18n/actions");
    jar.set = [];
    await setLocaleAction("en");
    await setLocaleAction("<script>");
    expect(jar.set).toEqual([
      ["kolmeia_locale", "en", { path: "/", maxAge: 31_536_000, sameSite: "lax", secure: process.env.NODE_ENV === "production" }],
      ["kolmeia_locale", "pt", { path: "/", maxAge: 31_536_000, sameSite: "lax", secure: process.env.NODE_ENV === "production" }],
    ]);
  });
});
