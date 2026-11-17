import { describe, expect, test } from "vitest";
import { nextSendLabel, scheduleParts } from "@/lib/email/schedule";
import type { ClaimOutcome } from "@/lib/email/types";
import { fill, t } from "@/messages/pt";
import { en } from "@/messages/en";

const d = { send_days: [1, 2, 3, 4, 5], window_start: "09:00:00", window_end: "18:00:00", timezone: "America/New_York", daily_limit: 30 };
describe("E2 schedule line and outcome messages", () => {
  test("the default campaign reads as one line", () => {
    expect(fill(t.email.campaign.schedule, scheduleParts(d, t))).toBe("Envia seg a sex, das 09:00 às 18:00 (America/New_York), até 30 por dia");
    expect(scheduleParts({ ...d, send_days: [5, 1, 3] }, t).days).toBe("seg, qua, sex");
    expect(scheduleParts({ ...d, send_days: [6, 7] }, t).days).toBe("sáb, dom");
    expect(scheduleParts({ ...d, send_days: [1, 2, 3, 4, 5, 6, 7] }, t).days).toBe("seg a dom");
    expect(scheduleParts({ ...d, window_start: "00:00:00", window_end: "24:00:00" }, t)).toMatchObject({ start: "00:00", end: "24:00" });
  });
  test("every claim outcome has a pt-BR message", () => {
    const all: Record<Exclude<ClaimOutcome, "claimed">, string> = t.email.send.outcomes;
    expect(fill(all.outside_window, { time: "segunda às 09:00" })).toBe("Fora do horário de envio desta campanha. Volta a enviar segunda às 09:00.");
    expect(fill(all.campaign_limit, { time: "às 09:00" })).toBe("Limite diário desta campanha atingido. Volta a enviar às 09:00.");
    expect(fill(all.daily_limit, { time: "terça às 09:00" })).toBe("Limite do dia atingido. Volta a enviar terça às 09:00.");
    for (const k of ["outside_window", "campaign_limit", "daily_limit"] as const) expect(all[k]).not.toMatch(/amanhã|\d\d:\d\d/);
  });
  test("nextSendLabel: today shows only the hour; another day shows the weekday, in the campaign's zone", () => {
    const NY = "America/New_York";
    const now = new Date("2026-11-13T15:00:00Z");                                   // Friday 10:00 in New York
    expect(nextSendLabel("2026-11-13T22:00:00Z", NY, t, now)).toBe("às 17:00");         // same local day
    expect(nextSendLabel("2026-11-16T14:00:00Z", NY, t, now)).toBe("segunda às 09:00");
    expect(nextSendLabel("2026-11-14T14:00:00Z", NY, t, now)).toBe("sábado às 09:00");
    expect(nextSendLabel("2026-11-14T03:30:00Z", NY, t, now)).toBe("às 22:30");          // Fri 22:30 NY is still today, though Saturday in UTC
    expect(nextSendLabel("2026-11-14T15:00:00Z", "Asia/Tokyo", t, now)).toBe("domingo às 00:00");
    expect(nextSendLabel(undefined, NY, t, now)).toBe("?");
    expect(nextSendLabel("not a date", NY, t, now)).toBe("?");
  });
  test("in English: the weekday and 'at'", () => {
    const now = new Date("2026-11-13T15:00:00Z");
    expect(nextSendLabel("2026-11-13T22:00:00Z", "America/New_York", en, now)).toBe("at 17:00");
    expect(nextSendLabel("2026-11-16T14:00:00Z", "America/New_York", en, now)).toBe("Monday at 09:00");
    expect(scheduleParts(d, en).days).toBe("Mon to Fri");
  });
});
