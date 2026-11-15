import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const AGENT = "00000000-0000-4000-8000-0000000000a1";
const CAMP = "00000000-0000-4000-8000-0000000000c1";
const LEAD = "00000000-0000-4000-8000-0000000000e1";
const MB = "00000000-0000-4000-8000-0000000000b1";
const MB_NEW = "00000000-0000-4000-8000-0000000000b2";

const cfg = (over: Record<string, unknown> = {}) => ({
  filter: { statuses: ["new"], agentId: null, temperature: null, approach: null },
  tone: "direct",
  steps: 3,
  delays: { step2: 3, step3: 7 },
  mailboxIds: [MB],
  ...over,
});

const calls = { agentInsert: 0, rpc: [] as string[], mailboxInsert: 0 };
let storedConfig: unknown;
let sequences = 0;
let failSave = false;
const writeSequence = vi.fn();

// a tiny chainable stand-in for the Supabase client: only what the action touches
function table(name: string) {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  for (const m of ["select", "eq", "is", "update", "delete"]) q[m] = chain;
  q.insert = () => {
    if (name === "agents") calls.agentInsert++;
    if (name === "campaign_mailboxes") calls.mailboxInsert++;
    return q;
  };
  q.single = async () => ({ data: { id: AGENT }, error: null });
  q.maybeSingle = async () => ({ data: name === "agents" ? { id: AGENT, config: storedConfig } : { id: CAMP }, error: null });
  q.then = (res: (v: unknown) => unknown) => res({ data: null, error: null, count: name === "email_sequences" ? sequences : 0 });
  return q;
}
const db = {
  from: (n: string) => table(n),
  rpc: async (fn: string) => {
    calls.rpc.push(fn);
    if (fn === "save_sequence_draft") {
      if (failSave) return { data: null, error: { message: "db down" } };
      sequences++;
    }
    return { data: fn === "create_email_agent_campaign" ? CAMP : {}, error: null };
  },
};

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => db }));
vi.mock("@/lib/workspace", () => ({ requireSender: async () => ({ id: "w1", name: "W", role: "owner" }) }));
vi.mock("@/lib/ai/gateway", () => ({ defaultTransport: () => ({}) }));
vi.mock("@/lib/ai/session-ledger", () => ({ sessionLedger: () => ({}) }));
vi.mock("@/lib/ai/email-tasks", () => ({ writeSequence: (...a: unknown[]) => writeSequence(...a) }));
vi.mock("@/lib/email/supabase-store", () => ({
  SupabaseEmailStore: class {
    getSender = async () => ({ sender_name: "Ana", postal_address: "10 Main St" });
    getProfile = async () => ({});
  },
}));
vi.mock("@/lib/email-agent/queries", () => ({
  pickLeads: async () => [{ lead: { id: LEAD }, best: null, display: { email: "a@b.example", city: null } }],
  selectLeads: async () => ({ ids: [], withEmail: 0, withoutEmail: 0 }),
  audienceOf: () => ({ count: 1, types: [], towns: [] }),
}));

const { createEmailAgentAction } = await import("@/app/(app)/agentes/novo/email/actions");
const draft = { steps: [{ step: 1, subject: "Hi {{company}}", body: "Hello {{first_name}}." }], model: "claude-sonnet", promptVersion: "v1" };

beforeEach(() => {
  calls.agentInsert = 0;
  calls.rpc = [];
  calls.mailboxInsert = 0;
  sequences = 0;
  failSave = false;
  storedConfig = cfg();
  writeSequence.mockReset();
});

describe("retry after an AI failure", () => {
  test("the second call reuses the agent, ignores new choices and calls the AI once more (twice in all)", async () => {
    writeSequence.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ data: draft });
    const first = await createEmailAgentAction(cfg() as never, "My agent");
    expect(first.ok).toBe(false);
    const agentId = !first.ok ? first.agentId : undefined;
    expect(agentId).toBe(AGENT);
    expect(calls.agentInsert).toBe(1);
    expect(calls.rpc.filter((r) => r === "create_email_agent_campaign")).toHaveLength(1);
    expect(calls.rpc.filter((r) => r === "add_leads_to_campaign")).toHaveLength(1);

    // the user changed tone, steps, mailboxes and name meanwhile: all ignored
    const changed = cfg({ tone: "friendly", steps: 1, mailboxIds: [MB_NEW] });
    const second = await createEmailAgentAction(changed as never, "Other name", agentId ?? null);
    expect(second.ok).toBe(true);
    expect(calls.agentInsert).toBe(1);
    expect(calls.mailboxInsert).toBe(1); // only the first call's mailbox
    expect(calls.rpc.filter((r) => r === "create_email_agent_campaign")).toHaveLength(1);
    expect(calls.rpc.filter((r) => r === "add_leads_to_campaign")).toHaveLength(1);
    expect(writeSequence).toHaveBeenCalledTimes(2);
    // the AI was asked with the stored config, not the changed one
    expect((writeSequence.mock.calls[1][1] as { tone: string; steps: number }).tone).toBe("direct");
    expect((writeSequence.mock.calls[1][1] as { steps: number }).steps).toBe(3);
  });

  test("a failed save after a paid AI call keeps the text; the retry saves it without a new AI call", async () => {
    writeSequence.mockResolvedValueOnce({ data: draft });
    failSave = true;
    const first = await createEmailAgentAction(cfg() as never, "My agent");
    expect(first.ok).toBe(false);
    expect(!first.ok && first.draft).toEqual(draft);
    failSave = false;
    const second = await createEmailAgentAction(cfg() as never, "x", AGENT, !first.ok ? (first.draft ?? null) : null);
    expect(second.ok).toBe(true);
    expect(writeSequence).toHaveBeenCalledTimes(1);
  });

  test("a campaign that already has a sequence is not paid for again", async () => {
    sequences = 1;
    const r = await createEmailAgentAction(cfg() as never, "x", AGENT);
    expect(r.ok).toBe(true);
    expect(writeSequence).not.toHaveBeenCalled();
  });
});
