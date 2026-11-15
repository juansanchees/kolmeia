export type CampaignChoice = {
  id: string;
  name: string;
  status?: string;
  /** Set when the campaign belongs to an e-mail agent. */
  agentId?: string | null;
  /** The campaign has an approved sequence version. */
  approved?: boolean;
  sendMode?: "dry_run" | "real";
};

/** A lead added here joins the approved sequence: step 1 is queued right away (D6), so the plain "nothing is sent" note is false. */
export function joinsApprovedSequence(c: CampaignChoice | undefined): boolean {
  return Boolean(c?.agentId && c.approved);
}
