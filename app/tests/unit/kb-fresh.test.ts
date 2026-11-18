import { describe, expect, test } from "vitest";
import { isFresh, KB_FRESH_DAYS } from "@/lib/kb/fresh";

const now = new Date("2026-11-18T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const D = 86_400_000;

describe("isFresh", () => {
  test("windows", () => expect(KB_FRESH_DAYS).toEqual({ phone: 90, website: 90, signal: 30 }));
  test("phone at 90 d is fresh, 90 d + 1 s is not", () => {
    expect(isFresh("phone", ago(90 * D), now)).toBe(true);
    expect(isFresh("phone", ago(90 * D + 1000), now)).toBe(false);
  });
  test("signal at 30 d + 1 s is stale", () => {
    expect(isFresh("signal", ago(30 * D), now)).toBe(true);
    expect(isFresh("signal", ago(30 * D + 1000), now)).toBe(false);
  });
  test("bad date is stale", () => expect(isFresh("website", "nope", now)).toBe(false));
});
