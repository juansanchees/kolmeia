import { describe, expect, test } from "vitest";
import { OUTCOME_GROUPS, latestOutcomeGroups } from "@/lib/calls/outcome-groups";
import type { CallOutcome } from "@/lib/calls/types";

const log = (id: string, lead_id: string, outcome: CallOutcome, called_at: string) => ({ id, lead_id, outcome, called_at });
const sizes = (g: ReturnType<typeof latestOutcomeGroups>) => Object.fromEntries(OUTCOME_GROUPS.map((k) => [k, g[k].length]));

describe("latestOutcomeGroups", () => {
  test("empty input: every group exists and is empty", () => {
    expect(Object.values(sizes(latestOutcomeGroups([]))).every((n) => n === 0)).toBe(true);
    expect(OUTCOME_GROUPS).toHaveLength(7);
  });
  test("latest call wins; a lead with two calls appears once", () => {
    const g = latestOutcomeGroups([log("a", "L1", "no_answer", "2026-11-01T10:00:00Z"), log("b", "L1", "meeting_booked", "2026-11-02T10:00:00Z")]);
    expect(g.no_answer).toEqual([]);
    expect(g.meeting_booked.map((l) => l.id)).toEqual(["b"]);
    expect(Object.values(sizes(g)).reduce((a, b) => a + b, 0)).toBe(1);
  });
  test("input order does not matter", () => {
    const g = latestOutcomeGroups([log("b", "L1", "meeting_booked", "2026-11-02T10:00:00Z"), log("a", "L1", "no_answer", "2026-11-01T10:00:00Z")]);
    expect(g.meeting_booked).toHaveLength(1);
  });
  test("same called_at: the higher id wins", () => {
    const g = latestOutcomeGroups([log("1", "L1", "voicemail", "2026-11-02T10:00:00Z"), log("2", "L1", "wrong_number", "2026-11-02T10:00:00Z")]);
    expect(g.wrong_number.map((l) => l.id)).toEqual(["2"]);
    expect(g.voicemail).toEqual([]);
  });
  test("gatekeeper counts as Não atendeu; talked is Ligar depois", () => {
    const g = latestOutcomeGroups([log("a", "L1", "gatekeeper", "2026-11-02T10:00:00Z"), log("b", "L2", "talked", "2026-11-02T11:00:00Z")]);
    expect(g.no_answer.map((l) => l.lead_id)).toEqual(["L1"]);
    expect(g.call_back.map((l) => l.lead_id)).toEqual(["L2"]);
  });
  test("each group is newest first", () => {
    const g = latestOutcomeGroups([log("a", "L1", "not_interested", "2026-11-01T10:00:00Z"), log("b", "L2", "not_interested", "2026-11-03T10:00:00Z"), log("c", "L3", "do_not_call", "2026-11-02T10:00:00Z")]);
    expect(g.not_interested.map((l) => l.lead_id)).toEqual(["L2", "L1"]);
    expect(g.do_not_call).toHaveLength(1);
  });
});
