import { contactPath } from "./row";
import type { BuildingKind, CampaignParams, Check, CheckKey, CompanyProfileLike, Offer, OfferInput, OfferSignal, OfferVerdict } from "./types";

// Offer: HVAC installation in new construction. Deterministic rules, invented thresholds marked (?) until Juan confirms.
//
// Priority points (sum, clamped to 0..100; `fit = no` forces 0):
// | factor                         | points | code                 |
// |--------------------------------|--------|----------------------|
// | issued <= 30 days              | +30    | issued_30d           |
// | issued <= 90 days              | +22    | issued_90d           |
// | issued <= 180 days             | +14    | issued_180d          |
// | issued <= 365 days             | +4     | issued_365d          |
// | value >= 2,000,000             | +25    | value_2m             |
// | value >= 500,000               | +18    | value_500k           |
// | value >= 150,000               | +10    | value_150k           |
// | new building confirmed         | +10    | new_build            |
// | GC / responsible party linked  | +15    | gc_confirmed         |
// | contact path phone             | +10    | contact_phone        |
// | contact path bids / portal     | +15    | contact_bids / contact_vendor_portal |
// | campaign prefers the kind      | +15    | kind_preferred       |
// | campaign deprioritizes the kind| -25    | kind_deprioritized   |
// | below the campaign min value   | -25    | below_min_value      |
// | older than the campaign wants  | -25    | older_than_wanted    |
// Question codes: ask_gc, ask_taking_bids, ask_hvac_scope, confirm_new_build.

const DAY = 86_400_000;
const STRONG_NEW = /\b(new\s+(construction|dwelling|house|home|building|single|two[- ]family|multi[- ]?family|residence|residential|commercial|structure)|adu|accessory dwelling|new\s+(sfd|sfh))\b/i;
const WEAK_NEW_CLASS = /^\s*new\b/i;
const WEAK_NEW_PHRASE = /\bnew construction\b/i;
const NOT_NEW = /\b(repair|re-?roof\w*|roof\w*|solar|photovoltaic|pool|fence|demo(lition|lish)?|deck|siding|windows?|replacement)\b/i;
// Small-scope work is never a new build, whatever "new" word is in front of it.
const SMALL_SCOPE = /\b(service|water heater|electrical|panel|meter|sign|signs|window|windows|door|doors|roof|roofing|deck|fence|pool|solar|siding|generator|furnace|boiler|chimney|gutters?|plumbing)\b/i;
const OTHER_TRADE_HVAC = /\b(hvac|mechanical|heat pump|furnace|air handler)\b/i;

const text = (s: OfferSignal) => `${s.work_class ?? ""} ${s.use ?? ""} ${s.description ?? ""}`;
// Phrases are matched per field: joining fields would invent "new residential" out of work class "New" + use "Residential".
const anyField = (s: OfferSignal, re: RegExp) => [s.work_class, s.use, s.description].some((f) => re.test(f ?? ""));

function units(s: OfferSignal): number | null {
  if (s.units != null) return s.units;
  const m = /(\d+)\s*(?:-\s*)?(?:dwelling\s+)?(?:units?|apartments?)\b/i.exec(s.description ?? "");
  return m ? Number(m[1]) : null;
}

export function classifyBuilding(s: OfferSignal): BuildingKind {
  const t = text(s);
  const u = units(s);
  if ((u != null && u >= 3) || /multi[- ]?family|apartments?|condo(minium)?s?|townhouses?|townhomes?/i.test(t)) return "multifamily";
  if (/commercial|(^|[\s/])comm\b/i.test(`${s.work_class ?? ""} ${s.use ?? ""} ${s.description ?? ""}`)) return "commercial";
  if (/\badu\b|accessory dwelling/i.test(t)) return "adu";
  if (/two[- ]family|2[- ]family|duplex/i.test(t)) return "other";
  if (/single|one[- ]family|1[- ]family|\bsfd\b|\bsfh\b|dwelling|\b(house|home|residence|residential)\b/i.test(t)) return "single_family";
  return "other";
}

function daysSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.slice(0, 10));
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now.getTime() - t) / DAY));
}

/** Work phrase for the hook, picked from a whitelist (never copied free text, so no person's name can leak). */
function workPhrase(s: OfferSignal, kind: BuildingKind, isNew: boolean): string {
  if (isNew) {
    const u = units(s);
    if (kind === "multifamily") return u != null && u >= 3 ? `new ${u}-unit multifamily building` : "new multifamily building";
    if (kind === "commercial") return "new commercial building";
    if (kind === "adu") return "new ADU";
    if (kind === "single_family") return "new single-family home";
    return "new construction";
  }
  const t = text(s);
  if (/\badd(ition)?\b/i.test(t)) return "addition";
  if (/renovat|remodel|alteration|fit-?out/i.test(t)) return "renovation";
  return "";
}
const street = (a: string) => a.split(",")[0].replace(/\s+(apt|unit|ste|suite|#).*$/i, "").replace(/#.*$/, "").trim();
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function hook(s: OfferSignal, kind: BuildingKind, isNew: boolean): string | null {
  const t = s.issued_on ? Date.parse(s.issued_on.slice(0, 10)) : NaN;
  const addr = s.address ? street(s.address) : "";
  if (Number.isNaN(t) || !addr) return null;
  const d = new Date(t);
  const work = workPhrase(s, kind, isNew);
  return `Saw the ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()} permit${work ? ` for ${work}` : ""} at ${addr}${s.town ? ` in ${s.town}` : ""} — who's handling the HVAC?`.slice(0, 300);
}

const chk = (state: Check["state"], evidence?: string, source_url?: string | null): Check => ({ state, ...(evidence ? { evidence } : {}), ...(source_url ? { source_url } : {}) });

function evaluate(input: OfferInput, now: Date, params?: CampaignParams): OfferVerdict {
  const s = input.signal;
  const t = text(s);
  const value = s.value_usd ?? null;
  const kind = classifyBuilding(s);
  const url = s.source_url;

  // new_build: strong words win over a "repair/solar/..." word; a bare "New ..." work class only counts when none of those appear.
  const newBuild: Check = anyField(s, STRONG_NEW) ? chk("confirmed", (s.description || s.work_class || "").slice(0, 120), url)
    : NOT_NEW.test(t) ? chk("no", (s.description || s.work_class || "").slice(0, 120), url)
    : !SMALL_SCOPE.test(t) && (WEAK_NEW_CLASS.test(s.work_class ?? "") || anyField(s, WEAK_NEW_PHRASE)) ? chk("confirmed", (s.work_class || s.description || "").slice(0, 120), url)
    : chk("missing");

  const age = daysSince(s.issued_on, now);
  const recent: Check = age == null ? chk("no", "no issue date") : age <= 180 ? chk("confirmed", `issued ${s.issued_on}`, url) : age <= 365 ? chk("missing", `issued ${s.issued_on}`, url) : chk("no", `issued ${s.issued_on}`, url);

  const hvacFit: Check = newBuild.state === "confirmed" ? chk("confirmed", "new building", url)
    : value != null && value >= 150_000 ? chk("confirmed", `value ${value}`, url)
    : OTHER_TRADE_HVAC.test(s.description ?? "") ? chk("missing", "hvac_by_other_trade", url)
    : chk("missing");

  const party: Check = input.link_status === "confirmed" ? chk("confirmed", input.company?.name, url) : chk("missing");
  const bidUrl = input.contacts.bids_url ?? input.contacts.vendor_portal_url;
  const canBid: Check = bidUrl ? chk("confirmed", bidUrl, input.contacts.bids_url ? (input.contacts.bids_source_url ?? input.contacts.source_url) : (input.contacts.vendor_portal_source_url ?? input.contacts.source_url)) : chk("missing");

  const checks: Record<CheckKey, Check> = { new_build: newBuild, recent, hvac_fit: hvacFit, responsible_party: party, can_bid: canBid };
  const cp = contactPath({ companyPhone: input.company?.phone, contacts: input.contacts }, params);

  const fit: OfferVerdict["fit"] = [newBuild, recent, hvacFit].some((c) => c.state === "no") ? "no"
    : newBuild.state === "confirmed" && recent.state === "confirmed" && cp.path !== "none" ? "yes" : "maybe";

  const q: string[] = [];
  if (newBuild.state === "missing") q.push("confirm_new_build");
  if (hvacFit.state === "missing") q.push("ask_hvac_scope");
  if (party.state === "missing") q.push("ask_gc");
  if (canBid.state === "missing") q.push("ask_taking_bids");
  // A campaign that wants the bid door asks about it first.
  const openQuestions = params?.wantBidPath ? [...q.filter((x) => x === "ask_taking_bids"), ...q.filter((x) => x !== "ask_taking_bids")] : q;

  let priority = 0;
  const codes: string[] = [];
  const add = (pts: number, code: string) => { priority += pts; codes.push(code); };
  if (fit === "no") {
    for (const k of ["new_build", "recent", "hvac_fit"] as const) if (checks[k].state === "no") codes.push(`fails_${k}`);
  } else {
    if (age != null) { if (age <= 30) add(30, "issued_30d"); else if (age <= 90) add(22, "issued_90d"); else if (age <= 180) add(14, "issued_180d"); else if (age <= 365) add(4, "issued_365d"); }
    if (value != null) { if (value >= 2_000_000) add(25, "value_2m"); else if (value >= 500_000) add(18, "value_500k"); else if (value >= 150_000) add(10, "value_150k"); }
    if (newBuild.state === "confirmed") add(10, "new_build");
    if (party.state === "confirmed") add(15, "gc_confirmed");
    // The bid door is worth more than a phone line whichever comes first as the contact path.
    if (input.contacts.bids_url) add(15, "contact_bids");
    else if (input.contacts.vendor_portal_url) add(15, "contact_vendor_portal");
    else if (cp.path === "phone") add(10, "contact_phone");
    if (params?.preferKinds?.includes(kind)) add(15, "kind_preferred");
    if (params?.deprioritizeKinds?.includes(kind)) add(-25, "kind_deprioritized");
    if (params?.minValueUsd != null && (value == null || value < params.minValueUsd)) add(-25, "below_min_value");
    if (params?.maxAgeDays != null && (age == null || age > params.maxAgeDays)) add(-25, "older_than_wanted");
    priority = Math.max(0, Math.min(100, priority));
  }

  return { fit, checks, openQuestions, priority, priorityCodes: codes, hookEn: hook(s, kind, newBuild.state === "confirmed"), buildingKind: kind, facts: JSON.parse(JSON.stringify(input)) as OfferInput };
}

const HVAC_WORDS = /\b(hvac|heating|cooling|heat pumps?|mechanical|ar condicionado|aquecimento|climatiza\w*|bomba de calor)\b/i;

export const hvacNewConstruction: Offer = {
  id: "hvac_new_construction",
  meta: {
    audience: "general_contractors_builders",
    buyerCodes: ["gc", "developer", "custom_home_builder"],
    signalCodes: ["new_building_permit", "project_listing"],
    sourceCodes: ["town_permits", "massbuilds", "company_site"],
    profileFit(p: CompanyProfileLike) {
      const does = HVAC_WORDS.test(`${p.what_we_do ?? ""} ${p.good_customer ?? ""}`);
      const missing = (p.service_area ?? "").trim() ? undefined : "ask_region";
      if (!does) return { score: 0, reasonCodes: [], assumptionCodes: [], ...(missing ? { missing } : {}) };
      let score = 40;
      const reasonCodes = ["does_hvac"];
      const assumptionCodes: string[] = [];
      const w = p.wanted_work ?? [];
      if (w.includes("new_construction")) { score += 30; reasonCodes.push("wants_new_construction"); }
      else if (!w.length) { score += 15; assumptionCodes.push("assume_new_construction_ok"); }
      if (w.includes("multifamily")) { score += 10; reasonCodes.push("wants_multifamily"); }
      if (w.includes("commercial")) { score += 10; reasonCodes.push("wants_commercial"); }
      if (/new construction|obra nova/i.test(p.not_wanted ?? "")) { score -= 40; reasonCodes.push("excluded_by_profile"); }
      return { score: Math.max(0, Math.min(100, score)), reasonCodes, assumptionCodes, ...(missing ? { missing } : {}) };
    },
  },
  evaluate,
};
