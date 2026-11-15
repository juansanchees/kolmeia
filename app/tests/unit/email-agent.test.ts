import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { LeadListItem } from "@/lib/leads/types";
import { emailAgentConfigSchema } from "@/lib/email-agent/types";

vi.mock("server-only", () => ({}));
const { audienceOf } = await import("@/lib/email-agent/queries");

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cfg = (over: Record<string, unknown> = {}) => ({
  filter: { statuses: ["new"], agentId: null, temperature: null, approach: null },
  tone: "direct",
  steps: 3,
  delays: { step2: 3, step3: 7 },
  mailboxIds: [UUID(1)],
  ...over,
});

const item = (i: number, type: string, city: string | null): LeadListItem =>
  ({ lead: { id: UUID(i) }, best: { company_type: type }, display: { name: `Co ${i}`, city, phone: null, website: null, email: null }, agentName: null, importName: null, proofOk: 0 }) as unknown as LeadListItem;

describe("F4 E-mail agent creation chat", () => {
  test("the config schema accepts a good config, refuses 0 or 11 mailboxes and bad delays", () => {
    expect(emailAgentConfigSchema.safeParse(cfg()).success).toBe(true);
    expect(emailAgentConfigSchema.safeParse(cfg({ mailboxIds: [] })).success).toBe(false);
    expect(emailAgentConfigSchema.safeParse(cfg({ mailboxIds: Array.from({ length: 11 }, (_, i) => UUID(i + 1)) })).success).toBe(false);
    expect(emailAgentConfigSchema.safeParse(cfg({ mailboxIds: Array.from({ length: 10 }, (_, i) => UUID(i + 1)) })).success).toBe(true);
    expect(emailAgentConfigSchema.safeParse(cfg({ delays: { step2: 7, step3: 3 } })).success).toBe(false);
    expect(emailAgentConfigSchema.safeParse(cfg({ delays: { step2: 0, step3: 7 } })).success).toBe(false);
    expect(emailAgentConfigSchema.safeParse(cfg({ steps: 4 })).success).toBe(false);
    expect(emailAgentConfigSchema.safeParse(cfg({ tone: "rude" })).success).toBe(false);
  });

  test("audienceOf keeps 10 types, 10 towns and counts every lead", () => {
    const types = Array.from({ length: 14 }, (_, i) => `type${i}`);
    const items = Array.from({ length: 30 }, (_, i) => item(i + 1, types[i % 14], i % 3 === 0 ? null : `Town ${i % 13}`));
    const a = audienceOf(items);
    expect(a.count).toBe(30);
    expect(a.types).toHaveLength(10);
    expect(a.towns).toHaveLength(10);
    expect(new Set(a.towns).size).toBe(10);
    expect(Object.keys(a).sort()).toEqual(["count", "towns", "types"]);
  });

  test("audienceOf drops the 'other' type and leaves out nothing it was not given", () => {
    const a = audienceOf([item(1, "other", "Boston"), item(2, "builder", "Boston")]);
    expect(a).toEqual({ count: 2, types: ["builder"], towns: ["Boston"] });
  });

  test("the wizard writes with AI only on the click; the estimate is shown before it", () => {
    const w = read("src/components/agents/EmailAgentWizard.tsx");
    const call = w.indexOf("createEmailAgentAction(");
    expect(call).toBeGreaterThan(0);
    expect(w.slice(0, call).lastIndexOf("const submit")).toBeGreaterThan(0);
    expect(w.match(/createEmailAgentAction\(/g)).toHaveLength(1);
    const effect = w.slice(w.indexOf("useEffect(() =>"), w.indexOf("const fresh"));
    expect(effect).toContain("countLeadsAction");
    expect(effect).not.toContain("createEmailAgentAction");
    expect(w).toContain("estimateUsd");
    const page = read("src/app/(app)/agentes/novo/email/page.tsx");
    expect(page).toContain("requireSender()");
    expect(page).toContain("reserveFor(sequenceDef)");
  });

  test("the action derives workspace and user from the session and never sends mail", () => {
    const a = read("src/app/(app)/agentes/novo/email/actions.ts");
    expect(a.startsWith('"use server"')).toBe(true);
    expect(a.match(/requireSender\(\)/g)!.length).toBeGreaterThanOrEqual(2);
    expect(a).toContain("save_sequence_draft");
    expect(a).toContain("add_leads_to_campaign");
    expect(a).toContain("sessionLedger");
    expect(a).not.toMatch(/smtp|Smtp|sendMail|send_mode|real/);
    expect(a).not.toMatch(/input\.workspace|cfg\.workspace/);
  });
});

describe("F4 E-mail agent creation through RPCs", () => {
  test("the campaign comes from create_email_agent_campaign, all mailboxes are inserted, no delays on the campaign", () => {
    const a = read("src/app/(app)/agentes/novo/email/actions.ts");
    expect(a).toContain('rpc("create_email_agent_campaign"');
    expect(a).not.toMatch(/from\("email_campaigns"\)\s*\.insert/);
    expect(a).not.toContain("step2_delay_days");
    expect(a).toContain("of c.mailboxIds)");
    expect(a).not.toContain("slice(1)");
  });
  test("only new and call_list leads are pickable", async () => {
    const { PICKABLE_STATUSES } = await import("@/lib/email-agent/types");
    expect([...PICKABLE_STATUSES]).toEqual(["new", "call_list"]);
  });
  test("a retry reuses the draft agent; the button is disabled while pending", () => {
    const a = read("src/app/(app)/agentes/novo/email/actions.ts");
    expect(a).toContain("reuseAgentId");
    expect(a).toMatch(/eq\("status", "draft"\)/);
    const w = read("src/components/agents/EmailAgentWizard.tsx");
    expect(w).toContain("error?.agentId ?? null");
    expect(w).toMatch(/disabled=\{pending \|\| !ready\}/);
  });
  test("delays change through set_campaign_delays and the form is hidden once a sequence exists", () => {
    const a = read("src/app/(app)/campanhas/actions.ts");
    expect(a).toContain('rpc("set_campaign_delays"');
    expect(a).toContain("55000");
    expect(a).not.toMatch(/update\(\{ step2_delay_days/);
    expect(read("src/app/(app)/campanhas/[id]/page.tsx")).toContain("!hasSequence && <DelaysForm");
  });
});
