// Client-safe rules of the Caçador chat: no server imports here.
import { z } from "zod";
import { DEFAULT_CAPS, RIGORS, type Rigor } from "@/lib/research/types";
import { ptMessages } from "@/lib/i18n";

// The agent name and the research request are stored data and AI input: always Portuguese, whatever the UI language.
const t = ptMessages;
import { SCHEDULES } from "./types";

export const AUDIENCES = ["builder", "developer", "property_manager", "other"] as const;

export const hunterSetupSchema = z
  .object({
    profileSource: z.enum(["saved", "describe"]),
    companyNote: z.string().trim().max(1400),
    audience: z.enum(AUDIENCES),
    audienceText: z.string().trim().max(500),
    region: z.string().trim().min(1).max(1000),
    // The offer and campaign (hunt_campaigns) this hunter works for; kept in the agent config, the AI run does not read them.
    offer: z.string().regex(/^[a-z][a-z0-9_]{0,59}$/).optional(),
    campaign_id: z.string().uuid().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.profileSource === "describe" && v.companyNote.length < 1) ctx.addIssue({ code: "custom", path: ["companyNote"], message: "required" });
    if (v.audience === "other" && v.audienceText.length < 1) ctx.addIssue({ code: "custom", path: ["audienceText"], message: "required" });
  });
export type HunterSetup = z.infer<typeof hunterSetupSchema>;

export const hunterFinishSchema = z.object({
  name: z.string().trim().min(1).max(80),
  rigor: z.enum(RIGORS),
  schedule: z.enum(SCHEDULES),
});
export type HunterFinish = z.infer<typeof hunterFinishSchema>;

export type HunterConfig = HunterSetup & {
  rigor: Rigor;
  caps: { maxCandidates: number; maxCostUsd: number; maxMinutes: number };
};

function audienceLabel(s: HunterSetup): string {
  return s.audience === "other" ? s.audienceText : t.agents.hunter.audiences[s.audience];
}

export function hunterRequest(s: HunterSetup): string {
  const target = s.audience === "other" ? s.audienceText : t.agents.hunter.audiences[s.audience].toLowerCase();
  const note = s.profileSource === "describe" ? `\n\nSobre a nossa empresa: ${s.companyNote}` : "";
  return `Achar ${target}${note}`;
}

export function defaultAgentName(s: HunterSetup): string {
  const one = `Caçador ${audienceLabel(s)} ${s.region}`.replace(/\s+/g, " ").trim();
  return one.length <= 80 ? one : `${one.slice(0, 79).trimEnd()}…`;
}

export function hunterConfig(s: HunterSetup, f: HunterFinish, runRegion: string): HunterConfig {
  return { ...s, region: runRegion, rigor: f.rigor, caps: { ...DEFAULT_CAPS[f.rigor] } };
}

export function regionOptions(serviceArea: string): string[] {
  const a = serviceArea.trim();
  return a ? [a.slice(0, 1000)] : [];
}
