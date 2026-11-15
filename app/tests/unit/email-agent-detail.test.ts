import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { AgentRow } from "@/lib/agents/types";
import { emailAgentMetrics, type SequenceExample } from "@/lib/email-agent/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/(app)/agentes/[id]/email-actions", () => ({
  approveSequenceAction: vi.fn(),
  rewriteSequenceAction: vi.fn(),
  saveSequenceEditAction: vi.fn(),
  setEmailAgentRunningAction: vi.fn(),
}));

const { SequenceExamples } = await import("@/components/agents/SequenceExamples");
const { EmailAgentDetail } = await import("@/components/agents/EmailAgentDetail");
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

const sender = { sender_name: "Ana Souza", legal_name: "Acme HVAC LLC", postal_address: "10 Main St\nBoston, MA 02110" };
const examples: SequenceExample[] = [1, 2, 3].map((n) => ({
  prospect_id: `p${n}`,
  company: `Co ${n}`,
  to: `c${n}@co${n}.com`,
  steps: [
    { step: 1, subject: `Hi Co ${n}`, body: "Short text." },
    { step: 2, subject: "Following up", body: "Second text." },
  ],
}));
const agent = { id: "a1", name: "Agent", type: "email", status: "paused", config: {} } as unknown as AgentRow;
const sequence = {
  id: "s1",
  version: 2,
  status: "draft" as const,
  tone: "direct" as const,
  steps: [{ step: 1 as const, subject: "Hi {{company}}", body: "Hello {{first_name}}." }],
  step2_delay_days: 3,
  step3_delay_days: 7,
  human_edited: false,
  ai_model: null,
  approved_at: null,
};
const props = (over: Record<string, unknown> = {}) => ({
  agent,
  campaignId: "c1",
  sequence,
  preview: { digest: "d".repeat(64), examples },
  metrics: emailAgentMetrics([], []),
  sender,
  c12Ready: false,
  isOwner: true,
  estimateUsd: 0.1,
  ...over,
});
const html = (over?: Record<string, unknown>) => renderToStaticMarkup(createElement(EmailAgentDetail, props(over) as never));

describe("F4 E-mail agent review (Task 8)", () => {
  test("every example shows the footer with sender name, postal address and the unsubscribe line", () => {
    const out = renderToStaticMarkup(createElement(SequenceExamples, { examples, sender, rehearsalOnly: true }));
    // 3 leads x 2 steps, each with its own footer
    expect(out.match(/data-footer/g)).toHaveLength(6);
    expect(out).toContain("Ana Souza");
    expect(out).toContain("Acme HVAC LLC");
    expect(out).toContain("10 Main St");
    expect(out).toContain("Boston, MA 02110");
    expect(out).toContain("If you&#x27;d rather not hear from us, unsubscribe here: (link de descadastro)");
    expect(out).toContain("c2@co2.com");
    expect(out).toContain("Envio real bloqueado até o checklist C12");
  });

  test("approving sends the digest the page rendered", () => {
    const src = read("src/components/agents/EmailAgentDetail.tsx");
    expect(src).toContain("approveSequenceAction(sequence.id, preview.digest)");
    // the action asks the database for exactly that digest and says what to do on 40001
    const act = read("src/app/(app)/agentes/[id]/email-actions.ts");
    expect(act).toContain('rpc("approve_email_sequence", { p_sequence: sequenceId, p_digest: digest })');
    expect(act).toContain('error.code === "40001"');
    expect(read("src/messages/pt/emailAgent.ts")).toContain("A sequência mudou, revise de novo");
  });

  test("the approve button is owner-only on screen and in the database", () => {
    expect(html({ isOwner: true })).toContain("Aprovar sequência e exemplos");
    const sdr = html({ isOwner: false });
    expect(sdr).not.toContain("Aprovar sequência e exemplos");
    expect(sdr).toContain("Só o dono aprova a sequência.");
    // server side: the action refuses a non-owner before calling the database, and the RPC is owner-only (0023 test)
    expect(read("src/app/(app)/agentes/[id]/email-actions.ts")).toContain('ws.role !== "owner"');
    expect(read("supabase/migrations/0023_email_sequences.sql")).toContain("J1: only the owner approves");
  });

  test("the banner says real sending is blocked until C12 and goes away when it is ready", () => {
    expect(html({ c12Ready: false })).toContain("Envio real bloqueado até o checklist C12");
    expect(html({ c12Ready: true })).not.toContain("Envio real bloqueado até o checklist C12");
  });

  test("Ligar needs an approved sequence", () => {
    const ligar = (h: string) => /<button[^>]*>Ligar<\/button>/.exec(h)?.[0] ?? "";
    expect(ligar(html())).toContain('disabled=""');
    expect(ligar(html({ sequence: { ...sequence, status: "approved" } }))).not.toContain('disabled=""');
  });

  test("metrics count drafts, approved, sent, replies, unsubscribes and bounces", () => {
    const messages = ["draft", "draft", "approved", "approved", "approved", "sent", "sent", "sent", "sent", "cancelled", "dry_run"].map((status) => ({ status }));
    const replies = [
      { is_bounce: false, classification: "interested" },
      { is_bounce: false, classification: "unsubscribe" },
      { is_bounce: false, classification: null },
      { is_bounce: true, classification: null },
      { is_bounce: true, classification: "other" },
    ];
    expect(emailAgentMetrics(messages, replies)).toEqual({ drafts: 2, approved: 3, sent: 4, replies: 3, unsubscribed: 1, bounced: 2 });
    expect(emailAgentMetrics([], [])).toEqual({ drafts: 0, approved: 0, sent: 0, replies: 0, unsubscribed: 0, bounced: 0 });
  });

  test("the e-mail agent page never sends mail", () => {
    for (const f of ["src/app/(app)/agentes/[id]/email-actions.ts", "src/components/agents/EmailAgentDetail.tsx", "src/lib/email-agent/queries.ts"]) {
      expect(read(f)).not.toMatch(/GmailSmtp|nodemailer|sendMail|claim_next_email/);
    }
  });
});
