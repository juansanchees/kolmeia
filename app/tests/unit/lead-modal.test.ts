import { describe, expect, it, vi } from "vitest";
import { closeLead } from "@/components/leads/LeadModal";

describe("closeLead", () => {
  it("goes back when opened from the list", () => {
    const router = { back: vi.fn(), replace: vi.fn() };
    closeLead(router, true, "/leads");
    expect(router.back).toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });
  it("drops ?lead on a direct visit", () => {
    const router = { back: vi.fn(), replace: vi.fn() };
    closeLead(router, false, "/leads?lista=1");
    expect(router.replace).toHaveBeenCalledWith("/leads?lista=1", { scroll: false });
    expect(router.back).not.toHaveBeenCalled();
  });
});
