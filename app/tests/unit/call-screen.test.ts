import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { callBackAt, callBackRange, chipLocal, CONTACT_EXTRA_OUTCOMES, CONTACT_OUTCOMES, contactSchema, leadPhone, nyLocalToIso } from "@/lib/calls/call-input";

const read = (p: string) => readFileSync(`${__dirname}/../../src/${p}`, "utf8");
const ids = { leadId: "11111111-1111-4111-8111-111111111111", note: "", callBackOn: null };

describe("call screen", () => {
  it("one tap records; the note is optional; Ligar depois needs a day", () => {
    expect(CONTACT_OUTCOMES).toEqual(["no_answer", "meeting_booked", "talked", "not_interested", "do_not_call"]);
    expect(contactSchema.safeParse({ ...ids, outcome: "no_answer" }).success).toBe(true);
    // the small second row keeps wrong_number (0020 lead_callable) and voicemail; gatekeeper is recorded as Não atendeu
    expect(CONTACT_EXTRA_OUTCOMES).toEqual(["voicemail", "wrong_number"]);
    expect(contactSchema.safeParse({ ...ids, outcome: "voicemail" }).success).toBe(true);
    expect(contactSchema.safeParse({ ...ids, outcome: "wrong_number" }).success).toBe(true);
    expect(contactSchema.safeParse({ ...ids, outcome: "gatekeeper" }).success).toBe(false);
    expect(contactSchema.safeParse({ ...ids, outcome: "talked" }).success).toBe(false);
    expect(contactSchema.safeParse({ ...ids, outcome: "talked", callBackOn: "2026-11-19" }).success).toBe(true);
    expect(contactSchema.safeParse({ ...ids, outcome: "not_interested", note: "x".repeat(201) }).success).toBe(false);
    expect(contactSchema.safeParse({ ...ids, outcome: "not_interested", note: "x".repeat(200) }).success).toBe(true);
  });

  it("Ligar depois is due at 9:00 New York time; the default day is today + 3", () => {
    expect(callBackAt("2026-11-19")).toBe("2026-11-19T14:00:00.000Z");
    expect(callBackAt("2026-02-31")).toBeNull();
    expect(chipLocal(3, new Date("2026-11-16T15:00:00Z")).slice(0, 10)).toBe("2026-11-19");
    expect(callBackRange(new Date("2026-11-16T15:00:00Z"))).toEqual({ min: "2026-11-16", max: "2027-05-15" });
  });

  it("the record form has the second row (Caixa postal, Número errado) and the day bounds", () => {
    const form = read("components/calls/ContactRecord.tsx");
    expect(form).toContain("CONTACT_EXTRA_OUTCOMES.map");
    expect(form).toMatch(/min=\{range\.min\} max=\{range\.max\}/);
  });

  it("no recording, no SMS, no AI voice on the call screen", () => {
    for (const f of ["components/calls/ContactRecord.tsx", "components/calls/CallFacts.tsx", "app/(app)/leads/ligar/[id]/page.tsx"]) {
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

  it("one form for every screen: the lead modal (sender) and the call screen both use ContactRecord", () => {
    expect(read("components/leads/LeadDetail.tsx")).toMatch(/sender && phone && open && !lead\.do_not_call && \(/);
    expect(read("components/leads/LeadDetail.tsx")).toContain('<ContactRecord leadId={lead.id} afterSave="stay"');
    expect(read("app/(app)/leads/ligar/[id]/page.tsx")).toContain('<ContactRecord leadId={id} afterSave="next"');
    expect(read("components/calls/ContactRecord.tsx")).toContain("R.dncHint");
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
