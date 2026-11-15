import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chipLocal, leadPhone, logCallSchema, nyLocalToIso } from "@/lib/calls/call-input";

const read = (p: string) => readFileSync(`${__dirname}/../../src/${p}`, "utf8");
const ids = { leadId: "11111111-1111-4111-8111-111111111111", agentId: null, spokeTo: "", notes: "", nextStep: "", nextAt: null };

describe("call screen", () => {
  it("one tap picks the outcome; only the outcome is required", () => {
    expect(logCallSchema.safeParse({ ...ids, outcome: "no_answer" }).success).toBe(true);
    expect(logCallSchema.safeParse({ ...ids, outcome: "shouted" }).success).toBe(false);
    expect(logCallSchema.safeParse({ ...ids, outcome: "talked", notes: "x".repeat(501) }).success).toBe(false);
    expect(logCallSchema.safeParse({ ...ids, outcome: "talked", notes: "x".repeat(500) }).success).toBe(true);
  });

  it("no recording, no SMS, no AI voice on the call screen", () => {
    for (const f of ["components/calls/CallForm.tsx", "components/calls/CallFacts.tsx", "app/(app)/leads/ligar/[id]/page.tsx"]) {
      const s = read(f);
      expect(s, f).not.toMatch(/sms:|getUserMedia|MediaRecorder|type="file"|recorded|name="record/i);
    }
    const facts = read("components/calls/CallFacts.tsx");
    expect(facts).toContain("noRecording");
    expect(facts).toContain("b2bOnly");
  });

  it("the number is a tel: link and also shown as text", () => {
    const facts = read("components/calls/CallFacts.tsx");
    expect(facts).toContain("telHref");
    expect(facts).toContain("rawPhone");
  });

  it("the form shows the status the lead will get", () => {
    const form = read("components/calls/CallForm.tsx");
    expect(form).toContain("statusAfterCall");
    expect(form).toContain("statusWillBe");
  });

  it("do_not_call hides the form", () => {
    expect(read("app/(app)/leads/ligar/[id]/page.tsx")).toMatch(/blocked \? .*calls\.blocked/);
  });

  it("next step time is read as New York time", () => {
    expect(nyLocalToIso("2026-11-16T09:00")).toBe("2026-11-16T14:00:00.000Z"); // EST
    expect(nyLocalToIso("2026-07-16T09:00")).toBe("2026-07-16T13:00:00.000Z"); // EDT
    expect(nyLocalToIso("2026-02-31T09:00")).toBeNull();
    expect(chipLocal(1, new Date("2026-11-15T03:00:00Z"))).toBe("2026-11-15T09:00"); // still Nov 14 evening in NY
    expect(chipLocal(7, new Date("2026-11-15T15:00:00Z"))).toBe("2026-11-22T09:00");
  });

  it("the phone follows lead_phone: best candidate, else newest non-refuted value", () => {
    const f = (value: string, seen: string, status: "unverified" | "refuted" = "unverified") => ({ field: "phone" as const, value, status, seen_at: seen });
    expect(leadPhone("508-555-0101", [])).toBe("508-555-0101");
    expect(leadPhone("123", [f("508-555-0102", "2026-01-01T00:00:00Z"), f("508-555-0103", "2026-02-01T00:00:00Z")])).toBe("508-555-0103");
    expect(leadPhone(null, [f("508-555-0104", "2026-02-01T00:00:00Z", "refuted")])).toBeNull();
  });
});
