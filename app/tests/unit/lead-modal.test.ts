import { describe, expect, it, vi } from "vitest";
import { closeLead } from "@/components/leads/LeadModal";

describe("closeLead", () => {
  it("goes back when there is history", () => {
    const router = { back: vi.fn(), push: vi.fn() };
    closeLead(router, 3);
    expect(router.back).toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });
  it("falls back to the list without history", () => {
    const router = { back: vi.fn(), push: vi.fn() };
    closeLead(router, 1);
    expect(router.push).toHaveBeenCalledWith("/leads");
    expect(router.back).not.toHaveBeenCalled();
  });
});
