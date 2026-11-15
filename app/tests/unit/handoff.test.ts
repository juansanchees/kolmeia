import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { draftBrief } from "@/lib/leads/brief";
import { parseCloserBrief } from "@/lib/email/brief";
import { t } from "@/messages/pt";

const src = (p: string) => readFileSync(join(__dirname, "../../src", p), "utf8");

const emailBrief = { who: "Ana, owner", what_they_said: "Asked for a quote.", next_step: "Call Monday", evidence_urls: ["https://a.example.com/x"], model: "claude" };

describe("draftBrief", () => {
  it("uses the e-mail brief when there is one, else ask-for and call notes; at most 4 safe proof URLs; model manual", () => {
    const withEmail = draftBrief({ company: "Acme", askForName: "Bo", askForTitle: "PM", emailBrief, talkedNotes: "ignored", proofUrls: [] });
    expect(withEmail.who).toBe("Ana, owner");
    expect(withEmail.what_they_said).toBe("Asked for a quote.");
    expect(withEmail.model).toBe("manual");

    const urls = ["https://a.example.com/x", "https://b.example.com", "javascript:alert(1)", "http://10.0.0.1/x", "https://c.example.com", "https://d.example.com", "https://e.example.com"];
    const manual = draftBrief({ company: "Acme", askForName: "Bo", askForTitle: "PM", emailBrief: null, talkedNotes: "  Liked the offer.  ", proofUrls: urls });
    expect(manual.who).toContain("Bo");
    expect(manual.who).toContain("PM");
    expect(manual.who).toContain("Acme");
    expect(manual.what_they_said).toBe("Liked the offer.");
    expect(manual.evidence_urls).toHaveLength(4);
    expect(new Set(manual.evidence_urls).size).toBe(4);
    expect(manual.evidence_urls.join(" ")).not.toMatch(/javascript|10\.0\.0\.1/);
    expect(manual.model).toBe("manual");
  });

  it("cuts strings to the SQL limits", () => {
    const b = draftBrief({ company: "x".repeat(900), askForName: null, askForTitle: null, emailBrief: null, talkedNotes: "y".repeat(2000), proofUrls: [] });
    expect(b.who.length).toBeLessThanOrEqual(600);
    expect(b.what_they_said.length).toBeLessThanOrEqual(800);
  });

  it("a lead that never got an e-mail can be handed off", () => {
    const b = draftBrief({ company: "Acme", askForName: null, askForTitle: null, emailBrief: null, talkedNotes: null, proofUrls: [] });
    expect(b.what_they_said).toBe(t.handoff.noTalkYet);
    expect(b.who).toBe("Acme");
    expect(parseCloserBrief(b)).not.toBeNull();
  });
});

describe("hand-off screens", () => {
  it('only "Passar pra closer" is orange', () => {
    expect(src("components/leads/HandOffForm.tsx")).toContain("btn.cta");
    expect(src("components/leads/StatusButtons.tsx")).not.toContain("cta");
    expect(src("components/leads/AddToCallList.tsx")).not.toContain("cta");
  });

  it("the hand-off action is sender-only and needs a next step", () => {
    const code = src("app/(app)/leads/lead-actions.ts");
    const body = code.slice(code.indexOf("export async function handOffLeadAction"), code.indexOf("export async function setLeadStatusAction"));
    expect(body).toContain("requireSender");
    expect(code).toMatch(/next_step: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(400\)/);
    const add = code.slice(code.indexOf("export async function addToCallListAction"));
    expect(add).toContain("requireSender");
  });
});
