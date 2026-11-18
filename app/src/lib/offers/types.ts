// An "offer" is a reusable rule: given a base signal (permit, project) it says whether the work fits what a company
// sells, what is confirmed and what is still unknown, and how urgent it is. Pure, deterministic, no I/O.
export type CheckState = "confirmed" | "missing" | "no";
export type CheckKey = "new_build" | "recent" | "hvac_fit" | "responsible_party" | "can_bid";
export type Check = { state: CheckState; evidence?: string; source_url?: string };
export type BuildingKind = "single_family" | "adu" | "multifamily" | "commercial" | "other";

/** Campaign instructions that shape the verdict without code changes per instruction (P4 fills them). */
export type CampaignParams = { preferKinds?: BuildingKind[]; deprioritizeKinds?: BuildingKind[]; minValueUsd?: number; wantBidPath?: boolean; maxAgeDays?: number };

/** The signal columns the rule reads (a kb_signals row, plus `units` when a source gives it). */
export type OfferSignal = {
  kind: "permit" | "project";
  source: string;
  source_ref: string;
  address?: string | null;
  town?: string | null;
  value_usd?: number | null;
  work_class?: string | null;
  use?: string | null;
  issued_on?: string | null;
  description?: string | null;
  source_url?: string | null;
  units?: number | null;
};
/** `*_source_url` = the page each contact was found on; `source_url` is a fallback for older data. */
export type OfferContacts = { phone?: string; bids_url?: string; vendor_portal_url?: string; source_url?: string; phone_source_url?: string; bids_source_url?: string; vendor_portal_source_url?: string };
export type OfferInput = {
  signal: OfferSignal;
  company: { name: string; phone?: string; website?: string } | null;
  link_status: "confirmed" | "pending" | "none";
  contacts: OfferContacts;
};

export type OfferVerdict = {
  fit: "yes" | "maybe" | "no";
  checks: Record<CheckKey, Check>;
  /** Question codes; messages come from P5. */
  openQuestions: string[];
  /** 0..100 */
  priority: number;
  priorityCodes: string[];
  hookEn: string | null;
  buildingKind: BuildingKind;
  /** The evaluation input as JSON, so the app can re-score later without the base. */
  facts: OfferInput;
};

/** The columns of public.company_profiles the offers read. */
export type CompanyProfileLike = { what_we_do?: string; service_area?: string; wanted_work?: string[]; good_customer?: string; not_wanted?: string };

export type OfferMeta = {
  /** Code for who buys / receives this offer. */
  audience: string;
  buyerCodes: string[];
  signalCodes: string[];
  sourceCodes: string[];
  profileFit(profile: CompanyProfileLike): { score: number; reasonCodes: string[]; assumptionCodes: string[]; missing?: string };
};

export interface Offer {
  id: string;
  meta: OfferMeta;
  evaluate(input: OfferInput, now: Date, params?: CampaignParams): OfferVerdict;
}
