import { describe, expect, test, vi } from "vitest";
import { pickSignal } from "@/lib/email/signal";
import { campaignWarnings, contentChecks, hasContentProblem, type WarningsInput } from "@/lib/email/warnings";

vi.mock("server-only", () => ({}));
const { draftDef, draftStrongDef } = await import("@/lib/ai/email-tasks");
const { buildDraftUser } = await import("@/lib/ai/prompts/email");
const { MODELS } = await import("@/lib/ai/models");
const { reserveFor } = await import("@/lib/ai/gateway");

// Fase 3 items 10-12: the draft signal, the local spam check, and the model per task.
const GOOD = { subject: "your 4-unit permit on E St", body: "Hi David,\n\nSaw your permit for the new 4-unit building at 363 E St. Who's handling the HVAC on that one?\n\nJuan", step: 1 };
const failing = (i: Parameters<typeof contentChecks>[0]) => contentChecks(i).filter((c) => !c.ok).map((c) => c.kind);

describe("spam check (local rules)", () => {
  test("a clean first e-mail passes every check", () => {
    expect(failing(GOOD)).toEqual([]);
    expect(contentChecks(GOOD).map((c) => c.kind)).toEqual(["spam_words", "links", "length", "caps", "exclaims"]);
  });
  test("spam words, whole words only", () => {
    expect(failing({ ...GOOD, body: "Get a FREE quote, guaranteed. Act now." })).toContain("spam_words");
    expect(contentChecks({ ...GOOD, body: "Act now for a free estimate" })[0].text).toMatch(/free, act now/);
    expect(failing({ ...GOOD, body: "We work freely across Freetown." })).not.toContain("spam_words");
  });
  test("links count only in the first e-mail", () => {
    expect(failing({ ...GOOD, body: "See https://x.example and www.y.example" })).toContain("links");
    expect(failing({ ...GOOD, step: 2, body: "See https://x.example" })).not.toContain("links");
  });
  test("over 90 words", () => {
    expect(failing({ ...GOOD, body: Array(91).fill("word").join(" ") })).toEqual(["length"]);
    expect(failing({ ...GOOD, body: Array(90).fill("word").join(" ") })).toEqual([]);
  });
  test("ALL CAPS: two shouted words or a shouted subject; HVAC and company suffixes are fine", () => {
    expect(failing({ ...GOOD, body: "This is HUGE and URGENT news" })).toContain("caps");
    expect(failing({ ...GOOD, subject: "QUICK QUESTION" })).toContain("caps");
    expect(failing({ ...GOOD, body: "HVAC for ACME LLC projects" })).not.toContain("caps");
  });
  test("exclamation marks: two or more, or any in the subject", () => {
    expect(failing({ ...GOOD, body: "Great! Thanks!" })).toContain("exclaims");
    expect(failing({ ...GOOD, subject: "hello!" })).toContain("exclaims");
    expect(failing({ ...GOOD, body: "Great! Who handles HVAC?" })).toEqual([]);
  });
  test("recipient: only a verifier-checked address is OK; domain_ok-only and unchecked warn", () => {
    expect(failing({ ...GOOD, recipient: "verified" })).toEqual([]);
    expect(failing({ ...GOOD, recipient: "domain_ok" })).toEqual(["recipient"]);
    expect(contentChecks({ ...GOOD, recipient: "domain_ok" }).at(-1)!.text).toMatch(/só o domínio/);
    expect(failing({ ...GOOD, recipient: null })).toEqual(["recipient"]);
    // left out = not checked (the campaign strip judges only the text)
    expect(hasContentProblem(GOOD)).toBe(false);
  });
  test("the campaign warnings strip shows drafts at risk, linking to the review", () => {
    const base: WarningsInput = {
      mailboxes: [], campaigns: [{ id: "c1", name: "Prédios", status: "draft", send_mode: "dry_run", sent: 0, bounced: 0 }], sentToday: {}, prospectsByCampaign: {}, gateOpen: true,
      sender: { legal_name: "New England Air HVAC Corp", postal_address: "1 Main St, Millbury, MA 01527", sender_name: "Juan" },
    };
    expect(campaignWarnings(base)).toEqual([]);
    const w = campaignWarnings({ ...base, spamDrafts: { c1: 2 } });
    expect(w).toEqual([{ kind: "spam_risk", text: expect.stringMatching(/Prédios: 2 rascunho/), href: "/campanhas/c1/revisar" }]);
  });
});

describe("opener signal", () => {
  const cand = { permit_count: null, last_permit_date: null, biggest_job_address: null, biggest_job_type: null, hook: null };
  test("permit first, then active project, then a work note, then the hook", () => {
    expect(pickSignal({ candidate: { ...cand, biggest_job_address: "363 E St, South Boston", biggest_job_type: "new 4-unit", last_permit_date: "2026-03-10" }, fields: [], hook: "x" })).toBe(
      "Alvará · 363 E St, South Boston · new 4-unit · mar/2026",
    );
    expect(pickSignal({ candidate: { ...cand, permit_count: 5 }, fields: [], hook: null })).toBe("Alvará · 5 alvarás");
    const fields = [
      { field: "note", value: "Building 12 units in Quincy", status: "unverified", source: "import" },
      { field: "active_project", value: "Mill St condos", status: "refuted", source: "import" },
    ];
    expect(pickSignal({ candidate: null, fields, hook: "Saw your site" })).toBe("Nota · Building 12 units in Quincy");
    expect(pickSignal({ candidate: null, fields: [{ ...fields[1], status: "confirmed" }], hook: null })).toBe("Obra · Mill St condos");
    expect(pickSignal({ candidate: null, fields: [{ field: "note", value: "Called, no answer", status: "unverified", source: "import" }], hook: "Saw your site" })).toBe("Gancho · Saw your site");
    expect(pickSignal({ candidate: null, fields: [], hook: null })).toBeNull();
  });
  test("the signal reaches the draft prompt inside the untrusted prospect block", () => {
    const user = buildDraftUser({
      workspaceName: "NEAir", senderName: "Juan", profile: null, delays: { step2: 3, step3: 7 },
      prospect: { company: "Cedarwood", contactName: "David", contactTitle: null, hook: null, evidence: [], signal: "Alvará · 363 E St" },
    });
    expect(user).toMatch(/<untrusted_prospect>[\s\S]*"signal_to_open_with": "Alvará · 363 E St"[\s\S]*<\/untrusted_prospect>/);
  });
});

describe("model per task", () => {
  test("drafts use the cheap model; the strong redraft uses Sonnet and reserves more; same task", () => {
    expect(draftDef).toMatchObject({ task: "email_draft", model: MODELS.haiku });
    expect(draftStrongDef).toMatchObject({ task: "email_draft", model: MODELS.sonnet, promptVersion: draftDef.promptVersion });
    expect(reserveFor(draftStrongDef)).toBeGreaterThan(reserveFor(draftDef));
  });
});
