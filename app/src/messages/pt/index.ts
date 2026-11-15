// Every user-facing string lives in this folder, one file per area, so later phases add files instead of
// editing one big dictionary. English can be added later as a sibling folder.
import { agents } from "./agents";
import { ai } from "./ai";
import { areas } from "./areas";
import { common } from "./common";
import { coverage } from "./coverage";
import { email } from "./email";
import { imports } from "./imports";
import { leads } from "./leads";
import { profile } from "./profile";
import { qualifier } from "./qualifier";
import { research } from "./research";
import { sources } from "./sources";
import { spend } from "./spend";
import { handoff } from "./handoff";
import { team } from "./team";

export const pt = { ...common, ...areas, leads, agents, ai, research, email, imports, sources, qualifier, spend, profile, coverage, team, handoff } as const;

export type Messages = typeof pt;
export const t = pt;

/** Replaces {name} placeholders. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}
