// Maps an offer verdict 1:1 onto a lead_opportunities row (0041 + 0042 `facts`): exactly the keys kb_deliver accepts.
// `campaign_id` (0042) is added by the caller that runs a campaign.
import type { CampaignParams, OfferContacts, OfferInput, OfferVerdict } from "./types";

export type ContactPath = "phone" | "bids" | "vendor_portal" | "none";

/** Which way in: a call by default; the bid door first when the campaign wants a bid path. */
export function contactPath(i: { companyPhone?: string; contacts: OfferContacts }, params?: CampaignParams): { path: ContactPath; value?: string; source_url?: string } {
  const phone = i.contacts.phone ?? i.companyPhone;
  const c = i.contacts;
  const opts: [ContactPath, string | undefined, string | undefined][] = [["phone", phone, c.phone_source_url ?? c.source_url], ["bids", c.bids_url, c.bids_source_url ?? c.source_url], ["vendor_portal", c.vendor_portal_url, c.vendor_portal_source_url ?? c.source_url]];
  const hit = (params?.wantBidPath ? [opts[1], opts[2], opts[0]] : opts).find(([, v]) => !!v);
  return hit ? { path: hit[0], value: hit[1]!.slice(0, 300), ...(hit[2] ? { source_url: hit[2] } : {}) } : { path: "none" };
}

export function toOpportunityRow(v: OfferVerdict, offer: string, input: OfferInput, params?: CampaignParams, kbSignalId?: string) {
  const s = input.signal;
  const c = contactPath({ companyPhone: input.company?.phone, contacts: input.contacts }, params);
  return {
    ...(kbSignalId ? { kb_signal_id: kbSignalId } : {}),
    offer,
    title: (s.description || s.work_class || s.address || "").slice(0, 200) || null,
    signal_date: s.issued_on ?? null,
    source: s.source,
    source_url: s.source_url ? s.source_url.slice(0, 500) : null,
    priority: v.priority,
    priority_codes: v.priorityCodes,
    hook_en: v.hookEn ? v.hookEn.slice(0, 300) : null,
    // The contact's own proof rides in checks (no extra column): which path and the page its value was found on.
    checks: { ...v.checks, contact: { path: c.path, value_source_url: c.source_url ?? null } },
    open_questions: v.openQuestions,
    contact_path: c.path,
    contact_value: c.value ?? null,
    facts: v.facts,
  };
}
