import { describe, expect, test } from "vitest";
import { effectiveTemperature } from "@/lib/leads/classify";

describe("effectiveTemperature", () => {
  test("level 4 lifts cold to hot", () => expect(effectiveTemperature(4, "cold")).toBe("hot"));
  test("level 4 keeps very_hot", () => expect(effectiveTemperature(4, "very_hot")).toBe("very_hot"));
  test("level 3 keeps cold", () => expect(effectiveTemperature(3, "cold")).toBe("cold"));
  test("no research + level 4 is hot", () => expect(effectiveTemperature(4, null)).toBe("hot"));
  test("no research + level 2 stays null", () => expect(effectiveTemperature(2, null)).toBeNull());
});
