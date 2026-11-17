import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CallOutcome } from "@/lib/calls/types";
import { nyDay } from "@/lib/calls/ny-day";
import { daysAgoStart } from "@/lib/leads/view";
import { parsePlan, type DayPlan, type PlanCalls, type PlanInput, type PlanTask } from "./plan";
import { DEFAULT_HOME_RULE, parseHomeRule, type HomeRule, type HomeRow } from "./rule";

/** The user's own "Ligar agora" rule and day plan (RLS: own row only). A missing row, a read error or a broken value all give the defaults: the Home never crashes on them. */
export async function loadHomeSetup(db: SupabaseClient, workspaceId: string, userId: string): Promise<{ rule: HomeRule; plan: DayPlan }> {
  const { data, error } = await db.from("home_rules").select("rule, plan").eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
  return error || !data ? { rule: DEFAULT_HOME_RULE, plan: parsePlan({}) } : { rule: parseHomeRule(data.rule), plan: parsePlan(data.plan) };
}

export type Blocked = { kind: "address" | "domain"; value: string };
/** `blocked` null = the list could not be read. */
export type PlanData = Omit<PlanInput, "now" | "userId" | "sender" | "rows" | "suppressed"> & { blocked: Blocked[] | null };

const TASK_COLS = "id, lead_id, kind, title, due_at, done_at, assignee_id";
const PAGE = 1000;
const MAX_LEADS = 5000;

/** Per-lead call totals (0037 plan_call_stats; RLS on call_logs decides), paged like the leads list. */
async function callStats(db: SupabaseClient, workspaceId: string, since: string): Promise<Record<string, PlanCalls>> {
  const out: Record<string, PlanCalls> = {};
  for (let from = 0; from < MAX_LEADS; from += PAGE) {
    const { data, error } = await db.rpc("plan_call_stats", { p_ws: workspaceId, p_since: since }).range(from, from + PAGE - 1);
    if (error) throw new Error(`plan_call_stats: ${error.message}`);
    const rows = (data ?? []) as { lead_id: string; no_answer: number; last_outcome: CallOutcome; by_me_since: boolean }[];
    for (const r of rows) out[r.lead_id] = { noAnswer: r.no_answer, last: r.last_outcome, byMeToday: r.by_me_since };
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * Everything the day plan reads besides the leads, as the user (RLS: the closer sees her leads' tasks and calls and no
 * e-mail data); it does not need the leads, so it runs alongside their read. Tasks: open ones and those done today, due
 * before the end of tomorrow (newest first, so years of old overdue ones never push today's out), plus open meetings
 * ahead. E-mail (senders only): leads sent a real e-mail today and the blocked addresses/domains. Marks: own ticks today.
 */
export async function loadPlanData(db: SupabaseClient, workspaceId: string, userId: string, sender: boolean, now: Date): Promise<PlanData> {
  const start = daysAgoStart(0, now).toISOString();
  const endTomorrow = daysAgoStart(-2, now).toISOString();
  const [tasks, meetings, calls, sent, blocked, marks] = await Promise.all([
    db.from("tasks").select(TASK_COLS).eq("workspace_id", workspaceId).or(`done_at.is.null,done_at.gte.${start}`).lt("due_at", endTomorrow).order("due_at", { ascending: false }).order("id").limit(2000),
    db.from("tasks").select(TASK_COLS).eq("workspace_id", workspaceId).eq("kind", "meeting").is("done_at", null).gte("due_at", endTomorrow).order("due_at").limit(1000),
    callStats(db, workspaceId, start),
    sender ? db.from("email_messages").select("email_prospects(lead_id)").eq("workspace_id", workspaceId).eq("status", "sent").gte("sent_at", start).limit(1000) : null,
    sender ? db.from("suppressions").select("kind, value").eq("workspace_id", workspaceId).limit(5000) : null,
    db.from("day_plan_marks").select("item_key").eq("workspace_id", workspaceId).eq("user_id", userId).eq("day", nyDay(now)).limit(500),
  ]);
  if (tasks.error) throw new Error(`loadPlanData tasks: ${tasks.error.message}`);
  if (meetings.error) throw new Error(`loadPlanData meetings: ${meetings.error.message}`);
  const emailedToday = [
    ...new Set(
      (sent?.data ?? []).flatMap((m) => {
        const p = (m as { email_prospects: { lead_id: string | null } | { lead_id: string | null }[] | null }).email_prospects;
        return (Array.isArray(p) ? p : p ? [p] : []).map((x) => x.lead_id).filter((x): x is string => Boolean(x));
      }),
    ),
  ];
  return {
    tasks: [...((tasks.data ?? []) as PlanTask[]), ...((meetings.data ?? []) as PlanTask[])],
    calls,
    emailedToday,
    blocked: blocked?.error ? null : ((blocked?.data ?? []) as Blocked[]),
    marks: ((marks.data ?? []) as { item_key: string }[]).map((m) => m.item_key),
  };
}

const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);

/** Leads whose e-mail address or domain is blocked. An unread list (null) blocks every lead with an e-mail: the e-mail block never lists a blocked address. */
export function suppressedOf(rows: HomeRow[], blocked: Blocked[] | null): string[] {
  if (!blocked) return rows.filter((r) => r.display.email?.trim()).map((r) => r.lead.id);
  const addr = new Set<string>(), dom = new Set<string>();
  for (const s of blocked) (s.kind === "address" ? addr : dom).add(s.value.trim().toLowerCase());
  return rows
    .filter((r) => {
      const e = r.display.email?.trim().toLowerCase();
      return e ? addr.has(e) || dom.has(domainOf(e)) : false;
    })
    .map((r) => r.lead.id);
}
