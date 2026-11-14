// Client-safe: how Gastos groups the money ledger. No server imports.
import { t } from "@/messages/pt";

const S = t.spend;
const TZ = "America/New_York";

export type SpendCall = {
  id: string;
  run_id: string | null;
  lead_id: string | null;
  task: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  web_searches: number;
  web_fetches: number;
  cost_usd: number;
  reserve_usd: number;
  status: string;
  created_at: string;
};

export type SpendBy = "agent" | "step" | "model" | "lead" | "day";
export type SpendPeriod = "today" | "7d" | "30d";

export type SpendRow = {
  key: string;
  label: string;
  agent: string;
  step: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  searches: number;
  fetches: number;
  usd: number;
  leads: { id: string; name: string; usd: number }[];
};

/** A pending call counts at max(reserve, cost), like the caps do. */
export function callUsd(c: SpendCall): number {
  return c.status === "pending" ? Math.max(c.reserve_usd, c.cost_usd) : c.cost_usd;
}

export function spendTotal(calls: SpendCall[]): number {
  return calls.reduce((s, c) => s + callUsd(c), 0);
}

export function stepLabel(task: string): string {
  const own = S.steps as Record<string, string>;
  return Object.hasOwn(own, task) && task !== "other" ? own[task] : S.steps.other;
}

export function agentLabel(c: SpendCall, runAgent: Map<string, string | null>): string {
  if (c.task.startsWith("qualify_")) return S.agents.qualifier;
  if (c.task === "profile_learn") return S.agents.learned;
  if (c.task.startsWith("email_")) return S.agents.email;
  const name = c.run_id ? runAgent.get(c.run_id) : null;
  return name ? name : S.agents.oneOff;
}

/** The New York calendar day (YYYY-MM-DD) of an instant. */
export function nyDay(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** How far New York's wall clock is ahead of UTC at an instant, in ms (negative in the US). */
function nyOffsetMs(at: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** Start of a period. "today" is midnight in New York (the Qualificador's day); 7d and 30d count back from now. */
export function periodStart(p: SpendPeriod, now: Date): Date {
  if (p === "7d") return new Date(now.getTime() - 7 * 86_400_000);
  if (p === "30d") return new Date(now.getTime() - 30 * 86_400_000);
  const [y, m, d] = nyDay(now).split("-").map(Number);
  const wallMidnight = Date.UTC(y, m - 1, d);
  // Two passes settle the offset even on the days the clocks change.
  let guess = wallMidnight - nyOffsetMs(new Date(wallMidnight));
  guess = wallMidnight - nyOffsetMs(new Date(guess));
  return new Date(guess);
}

type Names = { runAgent: Map<string, string | null>; leads: Map<string, string> };

/** Shown only when every call in the group agrees; else empty. */
const same = (xs: string[]) => (xs.length > 0 && xs.every((x) => x === xs[0]) ? xs[0] : "");

export function spendRows(calls: SpendCall[], by: SpendBy, names: Names): SpendRow[] {
  const groups = new Map<string, { label: string; calls: SpendCall[] }>();
  for (const c of calls) {
    let key: string;
    let label: string;
    if (by === "agent") key = label = agentLabel(c, names.runAgent);
    else if (by === "step") {
      key = c.task;
      label = stepLabel(c.task);
    }
    else if (by === "model") key = label = c.model;
    else if (by === "day") key = label = nyDay(c.created_at);
    else {
      key = c.lead_id ?? "";
      label = c.lead_id ? (names.leads.get(c.lead_id) ?? S.unknownLead) : S.noLead;
    }
    const g = groups.get(key);
    if (g) g.calls.push(c);
    else groups.set(key, { label, calls: [c] });
  }
  const rows: SpendRow[] = [];
  for (const [key, g] of groups) {
    const perLead = new Map<string, number>();
    for (const c of g.calls) if (c.lead_id) perLead.set(c.lead_id, (perLead.get(c.lead_id) ?? 0) + callUsd(c));
    rows.push({
      key,
      label: g.label,
      agent: same(g.calls.map((c) => agentLabel(c, names.runAgent))),
      step: same(g.calls.map((c) => stepLabel(c.task))),
      model: same(g.calls.map((c) => c.model)),
      inputTokens: g.calls.reduce((s, c) => s + c.input_tokens, 0),
      outputTokens: g.calls.reduce((s, c) => s + c.output_tokens, 0),
      searches: g.calls.reduce((s, c) => s + c.web_searches, 0),
      fetches: g.calls.reduce((s, c) => s + c.web_fetches, 0),
      usd: spendTotal(g.calls),
      leads: [...perLead.entries()].map(([id, usd]) => ({ id, name: names.leads.get(id) ?? S.unknownLead, usd })).sort((a, b) => b.usd - a.usd),
    });
  }
  return rows.sort((a, b) => b.usd - a.usd);
}

/** F3d's paid sources (Apify, Apollo): source_runs.cost_usd, or the reserve while the run is still open. */
export type SourceRun = { provider: string; kind: string; status: string; cost_usd: number | null; reserve_usd: number };
export type SourceRow = { provider: string; kind: string; runs: number; usd: number };

export function sourceRows(runs: SourceRun[]): SourceRow[] {
  const m = new Map<string, SourceRow>();
  for (const r of runs) {
    const open = r.status === "queued" || r.status === "running";
    const usd = r.cost_usd ?? (open ? r.reserve_usd : 0);
    const k = `${r.provider}:${r.kind}`;
    const row = m.get(k) ?? { provider: r.provider, kind: r.kind, runs: 0, usd: 0 };
    row.runs += 1;
    row.usd += usd;
    m.set(k, row);
  }
  return [...m.values()].sort((a, b) => b.usd - a.usd);
}
