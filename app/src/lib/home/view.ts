// Client-safe numbers and words of the Home: greeting, date line, HOJE cards, funnel strip, origin bars.
import { telHref } from "@/lib/calls/view";
import { stageOf } from "@/lib/leads/classify";
import { LEAD_STAGES, type LeadStage } from "@/lib/leads/types";
import { enteredOk, originKeysOf } from "@/lib/leads/view";
import { taskTab } from "@/lib/tasks/view";
import { fill, t } from "@/messages/pt";
import type { HomeRow } from "./rule";

const TZ = "America/New_York";

/** "Bom dia" from 05:00, "Boa tarde" from 12:00, "Boa noite" from 18:00 until 05:00, by the hour in New York. */
export function greetingOf(now: Date): string {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(now));
  return h >= 12 && h < 18 ? t.home.greeting.afternoon : h >= 5 && h < 12 ? t.home.greeting.morning : t.home.greeting.evening;
}

/** "TERÇA, 17 DE NOVEMBRO" (New York date). */
export function dateLineOf(now: Date): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" }).format(now).replace("-feira", "").toLocaleUpperCase("pt-BR");
}

/** The user's first name: the profile name when there is one, else the part of the e-mail before the @. */
export function firstNameOf(user: { email?: string | null; user_metadata?: Record<string, unknown> | null } | null): string {
  const meta = user?.user_metadata ?? {};
  const raw = [meta.full_name, meta.name].find((v): v is string => typeof v === "string" && v.trim() !== "") ?? (user?.email ?? "").split("@")[0];
  const first = raw.trim().split(/[\s._-]+/)[0] ?? "";
  return first ? first[0].toLocaleUpperCase("pt-BR") + first.slice(1).toLocaleLowerCase("pt-BR") : "";
}

export const readyLine = (n: number) => (n === 0 ? t.home.readyNone : n === 1 ? t.home.readyOne : fill(t.home.ready, { n: n.toLocaleString("pt-BR") }));

/** Stage Novo, not "do not call", with a phone a call can use: what "Prontas para ligar" counts. */
export const isReady = (r: HomeRow) => stageOf(r.lead) === "new" && !r.lead.do_not_call && telHref(r.display.phone ?? "") !== null;

export type TodayCounts = { ready: number; tasks: number; replied: number; meetings: number };

/** The four HOJE cards. `taskDues` = due_at of the open tasks; today or overdue (New York day) counts. */
export function todayCounts(rows: HomeRow[], taskDues: string[], now: Date): TodayCounts {
  const c: TodayCounts = { ready: 0, tasks: 0, replied: 0, meetings: 0 };
  for (const r of rows) {
    if (isReady(r)) c.ready++;
    const s = stageOf(r.lead);
    if (s === "replied") c.replied++;
    if (s === "meeting") c.meetings++;
  }
  c.tasks = taskDues.filter((d) => taskTab(d, now) !== "next").length;
  return c;
}

export const PERIODS = ["7", "30", "all"] as const;
export type Period = (typeof PERIODS)[number];
/** Default "Tudo". */
export const parsePeriod = (raw: unknown): Period => (PERIODS.find((p) => p === raw) ?? "all");

export type FunnelTile = { stage: LeadStage; n: number; note: string };

/** The funnel strip: leads per stage among those that entered (first_seen_at) in the period. */
export function funnelOf(rows: HomeRow[], period: Period, now: Date): FunnelTile[] {
  const inPeriod = rows.filter((r) => enteredOk(r.lead.first_seen_at, period === "all" ? "all" : period, now));
  const n = Object.fromEntries(LEAD_STAGES.map((s) => [s, 0])) as Record<LeadStage, number>;
  let large = 0, residential = 0;
  for (const r of inPeriod) {
    const s = stageOf(r.lead);
    n[s]++;
    if (s === "new") {
      if (r.segment === "large") large++;
      if (r.segment === "residential") residential++;
    }
  }
  const share = (k: number) => (inPeriod.length === 0 ? t.home.funnel.notes.shareNone : fill(t.home.funnel.notes.share, { pct: Math.round((k / inPeriod.length) * 100) }));
  const note: Record<LeadStage, string> = {
    new: fill(t.home.funnel.notes.new, { large, residential }),
    contacted: share(n.contacted),
    replied: share(n.replied),
    meeting: share(n.meeting),
    closed: t.home.funnel.notes.closed,
  };
  return LEAD_STAGES.map((stage) => ({ stage, n: n[stage], note: note[stage] }));
}

/** The origins with the most leads (each lead counts once per origin it has). */
export function topOrigins(rows: Pick<HomeRow, "lead" | "origins" | "agentName" | "importName">[], top = 5): { name: string; n: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) for (const k of originKeysOf(r)) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, top);
}
