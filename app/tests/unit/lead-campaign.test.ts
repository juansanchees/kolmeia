import { beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const rpc = vi.fn();
const requireSender = vi.fn(async () => ({ id: "w", role: "sdr" }));
vi.mock("@/lib/workspace", () => ({ requireSender: () => requireSender(), getCurrentWorkspace: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const C = "11111111-1111-4111-8111-111111111111";
const L = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  rpc.mockReset();
  requireSender.mockClear();
});

describe("F4 Pôr em campanha", () => {
  test("Pôr em campanha is sender-only and reports every count", async () => {
    const { addLeadsToCampaignAction } = await import("@/app/(app)/leads/campaign-actions");
    rpc.mockResolvedValue({ data: { added: 2, no_email: 1, blocked: 3, in_other_campaign: 4, suppressed: 0, already: 0 }, error: null });
    const r = await addLeadsToCampaignAction(C, [L]);
    expect(requireSender).toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("add_leads_to_campaign", { p_campaign: C, p_leads: [L] });
    expect(r).toEqual({ ok: true, counts: { added: 2, no_email: 1, blocked: 3, in_other_campaign: 4, suppressed: 0, already: 0 } });

    const src = read("src/components/leads/AddToCampaign.tsx");
    for (const k of ["noEmail", "otherCampaign", "blocked"]) expect(src, k).toContain(k);
    const page = read("src/app/(app)/leads/[id]/page.tsx");
    expect(page).toContain("<AddToCampaign");
    expect(page).toContain("sender &&");
    for (const keep of ["HandOffForm", "StatusButtons", "AddToCallList"]) expect(page).toContain(`<${keep}`);
  });

  test("bad ids and more than 500 leads never reach the database", async () => {
    const { addLeadsToCampaignAction } = await import("@/app/(app)/leads/campaign-actions");
    expect((await addLeadsToCampaignAction("x", [L])).ok).toBe(false);
    expect((await addLeadsToCampaignAction(C, ["nope"])).ok).toBe(false);
    expect((await addLeadsToCampaignAction(C, [])).ok).toBe(false);
    expect((await addLeadsToCampaignAction(C, Array.from({ length: 501 }, () => L))).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  test("database errors become pt-BR messages", async () => {
    const { addLeadsToCampaignAction } = await import("@/app/(app)/leads/campaign-actions");
    rpc.mockResolvedValue({ data: null, error: { code: "55000", message: "campaign archived" } });
    const a = await addLeadsToCampaignAction(C, [L]);
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "not allowed" } });
    const b = await addLeadsToCampaignAction(C, [L]);
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom internal" } });
    const c = await addLeadsToCampaignAction(C, [L]);
    for (const r of [a, b, c]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).not.toMatch(/archived|allowed|boom/);
    }
    if (!a.ok && !b.ok) expect(a.error).not.toBe(b.error);
  });

  test("adding never sends: the action calls only the add RPC", () => {
    const src = read("src/app/(app)/leads/campaign-actions.ts");
    expect(src).not.toMatch(/smtp|transport|sendStep|runTick/i);
    expect(src.match(/\.rpc\(/g)?.length).toBe(1);
  });
});
