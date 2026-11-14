import { describe, expect, test } from "vitest";
import { MAX_TEXT, profileSchema, workspaceNameSchema } from "@/lib/profile-schema";

const valid = {
  what_we_do: "Instalamos e mantemos sistemas de HVAC.",
  service_area: "Massachusetts",
  wanted_work: ["multifamily", "commercial"],
  good_customer: "Administradoras com vários prédios",
  not_wanted: "",
};

describe("profileSchema", () => {
  test("accepts valid input and trims text", () => {
    const r = profileSchema.safeParse({ ...valid, what_we_do: "  texto  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.what_we_do).toBe("texto");
  });

  test("accepts empty optional fields and an empty wanted_work list", () => {
    expect(profileSchema.safeParse({ ...valid, good_customer: "", not_wanted: "", wanted_work: [] }).success).toBe(true);
  });

  test("rejects missing or blank required text", () => {
    expect(profileSchema.safeParse({ ...valid, what_we_do: "   " }).success).toBe(false);
    expect(profileSchema.safeParse({ ...valid, service_area: "" }).success).toBe(false);
    const { what_we_do: _omit, ...rest } = valid;
    void _omit;
    expect(profileSchema.safeParse(rest).success).toBe(false);
  });

  test("rejects an unknown wanted-work value", () => {
    const r = profileSchema.safeParse({ ...valid, wanted_work: ["multifamily", "residential"] });
    expect(r.success).toBe(false);
  });

  test("rejects overly long text", () => {
    expect(profileSchema.safeParse({ ...valid, what_we_do: "a".repeat(MAX_TEXT + 1) }).success).toBe(false);
    expect(profileSchema.safeParse({ ...valid, not_wanted: "a".repeat(MAX_TEXT + 1) }).success).toBe(false);
    expect(profileSchema.safeParse({ ...valid, what_we_do: "a".repeat(MAX_TEXT) }).success).toBe(true);
  });
});

describe("workspaceNameSchema", () => {
  test("1 to 80 chars after trim", () => {
    expect(workspaceNameSchema.safeParse("  Air HVAC ").success).toBe(true);
    expect(workspaceNameSchema.safeParse("   ").success).toBe(false);
    expect(workspaceNameSchema.safeParse("a".repeat(81)).success).toBe(false);
  });
});
