import { describe, expect, test } from "vitest";
import { estimateQualifyUsd } from "@/lib/qualifier/estimate";

const C = { leadCapUsd: 0.5, placesUsd: 0.04, lightUsd: 0.01, deepUsd: 0.85 };

describe("estimateQualifyUsd", () => {
  test("the estimate is the worst case per lead, capped by what the lead has left; Places only below level 2 and with a key; level 4 has no deep step; rounded up to the cent", () => {
    // worst case 0.90 is capped by the lead cap 0.50
    expect(estimateQualifyUsd([{ level: 0, spentUsd: 0 }], C)).toBe(0.5);
    // what the lead already spent comes off its cap
    expect(estimateQualifyUsd([{ level: 1, spentUsd: 0.3 }], C)).toBe(0.2);
    expect(estimateQualifyUsd([{ level: 1, spentUsd: 0.7 }], C)).toBe(0);
    // Places counts only below level 2 and only with a key (a small deep step shows the difference)
    const small = { ...C, leadCapUsd: 5, deepUsd: 0.1 };
    expect(estimateQualifyUsd([{ level: 1, spentUsd: 0 }], small)).toBe(0.15);
    expect(estimateQualifyUsd([{ level: 2, spentUsd: 0 }], small)).toBe(0.11);
    expect(estimateQualifyUsd([{ level: 0, spentUsd: 0 }], { ...small, placesUsd: null })).toBe(0.11);
    // a dead lead counts like any other (a request revives it); a level-4 lead has no deep step; the sum is rounded up
    expect(estimateQualifyUsd([{ level: 0, spentUsd: 0 }, { level: 2, spentUsd: 0 }], small)).toBe(0.26);
    expect(estimateQualifyUsd([{ level: 4, spentUsd: 0 }], small)).toBe(0.01);
    expect(estimateQualifyUsd([{ level: 2, spentUsd: 0 }], { ...small, lightUsd: 0.001, deepUsd: 0.0021 })).toBe(0.01);
    expect(estimateQualifyUsd([], C)).toBe(0);
  });
});
