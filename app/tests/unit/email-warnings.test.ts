import { describe, expect, test } from "vitest";
import { campaignWarnings, type WarningsInput } from "@/lib/email/warnings";

const mailbox = { id: "m1", email: "a@x.com", status: "ok" as const, health_status: "ok" as const, daily_limit: 30 };
const campaign = { id: "c1", name: "Prédios", status: "active" as const, send_mode: "real" as const, sent: 0, bounced: 0 };
const base: WarningsInput = { mailboxes: [mailbox], campaigns: [campaign], sentToday: { m1: 0 }, prospectsByCampaign: { c1: 10 }, gateOpen: true, sender: { legal_name: "New England Air HVAC Corp", postal_address: "1 Main St, Millbury, MA 01527", sender_name: "Juan" } };
const kinds = (i: Partial<WarningsInput>) => campaignWarnings({ ...base, ...i }).map((w) => w.kind);

describe("warnings", () => {
  test("none when everything is healthy", () => expect(campaignWarnings(base)).toEqual([]));
  test("disconnected mailbox", () => {
    expect(kinds({ mailboxes: [{ ...mailbox, status: "error" }] })).toEqual(["mailbox_error"]);
    expect(kinds({ mailboxes: [{ ...mailbox, status: "unverified" }] })).toEqual(["mailbox_error"]);
  });
  test("mailbox paused by bounces", () => expect(kinds({ mailboxes: [{ ...mailbox, health_status: "paused_bounce" }] })).toEqual(["mailbox_paused"]));
  test("active campaign without leads; draft one is ignored", () => {
    expect(kinds({ prospectsByCampaign: { c1: 0 } })).toEqual(["no_leads"]);
    expect(kinds({ prospectsByCampaign: {} })).toEqual(["no_leads"]);
    expect(kinds({ campaigns: [{ ...campaign, status: "draft" }], prospectsByCampaign: {} })).toEqual([]);
  });
  test("daily limit reached", () => {
    expect(kinds({ sentToday: { m1: 30 } })).toEqual(["daily_limit"]);
    expect(kinds({ sentToday: { m1: 29 } })).toEqual([]);
  });
  test("high bounce: at least 3 and 5 percent", () => {
    expect(kinds({ campaigns: [{ ...campaign, sent: 40, bounced: 3 }] })).toEqual(["high_bounce"]);
    expect(kinds({ campaigns: [{ ...campaign, sent: 100, bounced: 3 }] })).toEqual([]);
    expect(kinds({ campaigns: [{ ...campaign, sent: 10, bounced: 2 }] })).toEqual([]);
  });
  test("rehearsal only while the gate is closed", () => {
    expect(kinds({ gateOpen: false })).toEqual(["rehearsal_only"]);
    expect(kinds({ gateOpen: false, campaigns: [{ ...campaign, status: "draft" }] })).toEqual([]);
  });
  test("sender profile incomplete", () => {
    expect(kinds({ sender: null })).toEqual(["sender_profile_incomplete"]);
    expect(kinds({ sender: { legal_name: "X Corp", postal_address: "", sender_name: "Juan" } })).toEqual(["sender_profile_incomplete"]);
  });
  test("running agent campaign without a mailbox", () => {
    expect(kinds({ campaigns: [{ ...campaign, agent_id: "a1", mailbox_id: null }] })).toEqual(["agent_campaign_no_mailbox"]);
    expect(kinds({ campaigns: [{ ...campaign, agent_id: "a1", mailbox_id: "m1" }] })).toEqual([]);
    expect(kinds({ campaigns: [{ ...campaign, mailbox_id: null }] })).toEqual([]);
    expect(kinds({ campaigns: [{ ...campaign, status: "draft", agent_id: "a1", mailbox_id: null }], prospectsByCampaign: {} })).toEqual([]);
  });
  test("ordered by kind, each with text and href", () => {
    const w = campaignWarnings({
      mailboxes: [{ ...mailbox, status: "error", health_status: "paused_bounce" }],
      campaigns: [{ ...campaign, sent: 40, bounced: 4 }],
      sentToday: { m1: 30 },
      prospectsByCampaign: {},
      gateOpen: false,
      sender: null,
    });
    expect(w.map((x) => x.kind)).toEqual(["mailbox_error", "mailbox_paused", "no_leads", "daily_limit", "high_bounce", "rehearsal_only", "sender_profile_incomplete"]);
    for (const x of w) {
      expect(x.text.length).toBeGreaterThan(5);
      expect(x.href.startsWith("/campanhas")).toBe(true);
    }
  });
});
