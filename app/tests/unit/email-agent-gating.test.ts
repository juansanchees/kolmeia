import { describe, expect, test, vi } from "vitest";
import { approveBlock } from "@/lib/email-agent/gating";
import { joinsApprovedSequence } from "@/lib/leads/campaign-note";
import { leadFilterSchema } from "@/lib/email-agent/types";

vi.mock("server-only", () => ({}));

const ok = { approved: false, dirty: false, hasPreview: true, examples: 3, hasSender: true };

describe("Approve gating (pure rule used by the agent page)", () => {
  test("only a clean, shown, sender-complete, unapproved draft may be approved", () => {
    expect(approveBlock(ok)).toBeNull();
    expect(approveBlock({ ...ok, approved: true })).toBe("approved");
    expect(approveBlock({ ...ok, dirty: true })).toBe("dirty");
    expect(approveBlock({ ...ok, examples: 0 })).toBe("examples");
    expect(approveBlock({ ...ok, hasPreview: false })).toBe("examples");
    expect(approveBlock({ ...ok, hasSender: false })).toBe("sender");
  });
  test("unsaved text wins over the other reasons (edit then nothing to approve)", () => {
    expect(approveBlock({ ...ok, dirty: true, hasSender: false })).toBe("dirty");
  });
});

describe("Add to campaign note", () => {
  test("only an agent campaign with an approved sequence says mail goes out", () => {
    const base = { id: "c", name: "C" };
    expect(joinsApprovedSequence(undefined)).toBe(false);
    expect(joinsApprovedSequence(base)).toBe(false);
    expect(joinsApprovedSequence({ ...base, agentId: "a", approved: false })).toBe(false);
    expect(joinsApprovedSequence({ ...base, agentId: null, approved: true })).toBe(false);
    expect(joinsApprovedSequence({ ...base, agentId: "a", approved: true })).toBe(true);
  });
});

describe("lead filter", () => {
  test("only new and call_list are accepted by the server schema", () => {
    const f = (statuses: string[]) => leadFilterSchema.safeParse({ statuses, agentId: null, temperature: null, approach: null }).success;
    expect(f(["new", "call_list"])).toBe(true);
    expect(f(["replied"])).toBe(false);
  });
});
