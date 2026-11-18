import { classifyBuilding } from "./hvac-new-construction";
import type { CheckKey, CompanyProfileLike, Offer, OfferInput, OfferVerdict } from "./types";

// Stub: proposal metadata only. The Falmouth pilot never runs it, so evaluate always says no / not_implemented.
const KEYS: CheckKey[] = ["new_build", "recent", "hvac_fit", "responsible_party", "can_bid"];

export const buildingMaintenance: Offer = {
  id: "building_maintenance",
  meta: {
    audience: "property_managers_condo_associations",
    buyerCodes: ["property_manager", "condo_association", "building_owner"],
    signalCodes: ["portfolio_size", "berdo_covered_building", "aging_equipment"],
    sourceCodes: ["public_building_lists", "management_company_sites", "berdo_reports"],
    profileFit(p: CompanyProfileLike) {
      const does = /\b(hvac|heating|cooling|mechanical|maintenance|manuten\w*|ar condicionado)\b/i.test(`${p.what_we_do ?? ""} ${p.good_customer ?? ""}`);
      const missing = (p.service_area ?? "").trim() ? undefined : "ask_region";
      if (!does) return { score: 0, reasonCodes: [], assumptionCodes: [], ...(missing ? { missing } : {}) };
      const wants = (p.wanted_work ?? []).includes("maintenance");
      return { score: wants ? 70 : 35, reasonCodes: wants ? ["does_hvac", "wants_maintenance"] : ["does_hvac"], assumptionCodes: wants ? [] : ["assume_maintenance_ok"], ...(missing ? { missing } : {}) };
    },
  },
  evaluate(input: OfferInput): OfferVerdict {
    return {
      fit: "no",
      checks: Object.fromEntries(KEYS.map((k) => [k, { state: "missing" as const }])) as OfferVerdict["checks"],
      openQuestions: [],
      priority: 0,
      priorityCodes: ["not_implemented"],
      hookEn: null,
      buildingKind: classifyBuilding(input.signal),
      facts: JSON.parse(JSON.stringify(input)) as OfferInput,
    };
  },
};
