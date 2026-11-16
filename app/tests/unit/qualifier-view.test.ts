import { describe, expect, it } from "vitest";
import { cardLines, levelDots, noteFieldLabel, levelReason, nextStepLabel, type QualifierStatus } from "@/lib/qualifier/view";
import type { LeadFieldRow } from "@/lib/leads/types";
import { t } from "@/messages/pt";

const status: QualifierStatus = {
  status: "on",
  paused_reason: null,
  paused_until: null,
  daily_cap_usd: 5,
  lead_cap_usd: 0.5,
  auto_deep: true,
  queued: 12,
  done_today: 3,
  spent_today: 1.2,
  levels: { "0": 4, "1": 5, "2": 2, "3": 1, "4": 0 },
  steps_today: { free: 7, places: 0, light: 2, deep: 1 },
};

function field(f: Partial<LeadFieldRow> & Pick<LeadFieldRow, "field" | "value">): LeadFieldRow {
  return { id: "f", lead_id: "l", source: "site", source_ref: "https://acme.example", status: "confirmed", excerpt: null, seen_at: "2026-11-01T00:00:00Z", ...f };
}

describe("F3c-2 view", () => {
  it("level dots, names and the next step label", () => {
    expect(levelDots(2)).toBe("●●○○○");
    expect(levelDots(0)).toBe("○○○○○");
    expect(levelDots(9)).toBe("●●●●○");
    expect(levelReason([], 1)).toBe("contactável");
    expect(levelReason([field({ field: "phone", value: "1" })], 4)).toBe("obra ativa confirmada");
    expect(nextStepLabel("p2", null)).toBe(t.qualifier.nextSteps.p2);
    expect(nextStepLabel("done", "lead_cap")).toBe("parou no teto");
    expect(nextStepLabel("done", "dead")).toBe(t.qualifier.done.dead);
    expect(nextStepLabel("done", null)).toBe(t.qualifier.done.complete);
    expect(nextStepLabel("zzz", null)).toBe(t.qualifier.done.complete);
  });

  it("level note fields read in Portuguese, never the raw check kind", () => {
    for (const k of ["has_work", "decision_maker", "exists_active", "candidate", "website", "zzz"]) {
      expect(noteFieldLabel(k)).not.toMatch(/_|^candidate$|^zzz$/);
    }
    expect(noteFieldLabel("has_work")).toBe("obra ativa");
    expect(noteFieldLabel("website")).toBe("Site");
  });

  it("cardLines shows today's spend against the cap, the steps of the day and the Places warning only without a key", () => {
    const off = cardLines(status, false);
    expect(off.spent).toBe("US$ 1,20 de US$ 5,00 hoje");
    expect(off.queued).toBe("12 na fila");
    expect(off.today).toBe("3 prontos hoje");
    expect(off.steps).toBe("Hoje: 7 grátis · 0 Places · 2 IA leve · 1 IA forte");
    expect(off.levels).toEqual([[0, 4], [1, 5], [2, 2], [3, 1], [4, 0]]);
    expect(off.warning).toBe("⚠ Places desligado (sem chave)");
    expect(cardLines(status, true).warning).toBeNull();
  });
});
