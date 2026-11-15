import { describe, expect, test } from "vitest";
import { CALL_STATUS_VECTORS } from "../fixtures/call-status-vectors";
import { ANSWERED, CALL_OUTCOMES, callAgentConfigSchema, type CallOutcome } from "@/lib/calls/types";
import { callAgentMetrics, statusAfterCall, telHref } from "@/lib/calls/view";
import type { LeadStatus } from "@/lib/leads/types";
import { t } from "@/messages/pt";

const CALLER = "30000000-0000-4000-8000-000000000003";

describe("F5 calls view", () => {
  test("statusAfterCall matches the shared vectors", () => {
    expect(CALL_STATUS_VECTORS).toHaveLength(56);
    for (const v of CALL_STATUS_VECTORS) {
      expect(statusAfterCall(v.status as LeadStatus, v.outcome as CallOutcome), `${v.status} + ${v.outcome}`).toBe(v.after);
    }
  });

  test("telHref builds tel:+1 and refuses short numbers", () => {
    expect(telHref("(508) 555-0101")).toBe("tel:+15085550101");
    expect(telHref("+1 508.555.0101")).toBe("tel:+15085550101");
    expect(telHref("15085550101")).toBe("tel:+15085550101");
    expect(telHref("555-0101")).toBeNull();
    expect(telHref("")).toBeNull();
  });

  test("metrics count answered as gatekeeper, talked, meeting, not interested, do not call", () => {
    expect([...ANSWERED].sort()).toEqual(["do_not_call", "gatekeeper", "meeting_booked", "not_interested", "talked"]);
    const items = ["a", "b", "c", "d", "e", "f"].map((lead_id) => ({ lead_id }));
    const calls: { lead_id: string; outcome: CallOutcome }[] = [
      { lead_id: "a", outcome: "no_answer" },
      { lead_id: "a", outcome: "talked" },
      { lead_id: "b", outcome: "voicemail" },
      { lead_id: "c", outcome: "meeting_booked" },
      { lead_id: "d", outcome: "gatekeeper" },
      { lead_id: "e", outcome: "wrong_number" },
      { lead_id: "z", outcome: "talked" }, // not on the list
    ];
    expect(callAgentMetrics(items, calls)).toEqual({ inList: 6, called: 5, answered: 3, meetings: 1 });
    expect(callAgentMetrics([], [])).toEqual({ inList: 0, called: 0, answered: 0, meetings: 0 });
  });

  test("the outcomes are spec §7.4, in order, each with its label; no recording and no SMS in the copy", () => {
    expect(CALL_OUTCOMES).toEqual(["no_answer", "voicemail", "gatekeeper", "talked", "meeting_booked", "not_interested", "wrong_number", "do_not_call"]);
    for (const o of CALL_OUTCOMES) expect(t.calls.outcomes[o]).toBeTruthy();
    expect(JSON.stringify(t.calls)).not.toMatch(/sms:/i);
    expect(t.funnel).toEqual({ tab: "Funil", origin: "Origem", total: "Total" });
    expect(t.callAgent.metrics).toEqual({ inList: "na lista", called: "ligados", answered: "atendeu", meetings: "reunião marcada" });
  });

  test("the call agent config is strict and fills the defaults", () => {
    expect(callAgentConfigSchema.parse({ caller_id: CALLER })).toEqual({ caller_id: CALLER, per_day: 20, min_level: 1, temperatures: [] });
    for (const bad of [
      { caller_id: "x" },
      { caller_id: CALLER, per_day: 0 },
      { caller_id: CALLER, per_day: 51 },
      { caller_id: CALLER, per_day: 2.5 },
      { caller_id: CALLER, min_level: 5 },
      { caller_id: CALLER, temperatures: ["boiling"] },
      { caller_id: CALLER, temperatures: ["hot", "hot"] },
      { caller_id: CALLER, extra: 1 },
    ]) {
      expect(callAgentConfigSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
