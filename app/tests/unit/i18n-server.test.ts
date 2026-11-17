import { describe, expect, it, vi } from "vitest";

// The setup file mocks this module for every other test; here the real one reads a mocked cookie jar.
vi.unmock("@/lib/i18n/server");
const jar = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "kolmeia_locale" && jar.value !== undefined ? { name, value: jar.value } : undefined) }),
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
