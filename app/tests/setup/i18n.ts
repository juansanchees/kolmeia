// Tests run outside a Next request, where cookies() throws: server code reads Portuguese, the default locale.
import { vi } from "vitest";

vi.mock("@/lib/i18n/server", async () => {
  const { ptMessages } = await import("@/lib/i18n");
  return { getLocale: async () => "pt", getT: async () => ptMessages };
});
