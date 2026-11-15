import { as, UUID_A, type TestDb } from "./helpers";

/** The 7 items of the C12 checklist (0018), in screen order. */
export const C12_ITEMS = ["mailboxes", "sending_domain_separate", "spf", "dkim", "dmarc", "warmup", "physical_address"] as const;

/** Test setup: the workspace owner approves every C12 item, as a person would on the campaign page. */
export async function approveAllC12(db: TestDb, ws: string, owner = UUID_A): Promise<void> {
  for (const item of C12_ITEMS) await db.query(as(owner), "select public.approve_c12_item($1,$2,'checked by hand (test)')", [ws, item]);
}
