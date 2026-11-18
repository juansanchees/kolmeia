// Every user-facing string lives in this folder, one file per area, so later phases add files instead of
// editing one big dictionary. English lives in ../en with the same keys; app code picks one through @/lib/i18n.
import type { Widen } from "../widen";
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
import { calls } from "./calls";
import { results } from "./results";
import { callAgent } from "./callAgent";
import { funnel } from "./funnel";
import { emailAgent } from "./emailAgent";
import { lists } from "./lists";
import { tasks } from "./tasks";
import { home } from "./home";
import { landing } from "./landing";

export const pt = { intl: "pt-BR", ...common, ...areas, leads, agents, ai, research, email, imports, sources, qualifier, spend, profile, coverage, team, handoff, calls, results, callAgent, funnel, emailAgent, lists, tasks, home, landing } as const;

/** The shape every language fills (string values widened). `intl` is the BCP 47 tag for dates and numbers. */
export type Messages = Widen<typeof pt>;
/** Portuguese messages; only tests and @/lib/i18n import this directly. */
export const t = pt;
export { fill } from "../fill";
