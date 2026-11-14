// Every user-facing string lives in this folder, one file per area, so later phases add files instead of
// editing one big dictionary. English can be added later as a sibling folder.
import { agents } from "./agents";
import { ai } from "./ai";
import { areas } from "./areas";
import { common } from "./common";
import { email } from "./email";
import { research } from "./research";

export const pt = { ...common, ...areas, agents, ai, research, email } as const;

export type Messages = typeof pt;
export const t = pt;

/** Replaces {name} placeholders. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}
