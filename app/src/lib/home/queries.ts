import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { callResultLogs } from "@/lib/calls/call-queries";
import { nyDay } from "@/lib/calls/ny-day";
import { daysAgoStart } from "@/lib/leads/view";
import { parsePlan, type DayPlan, type PlanCalls, type PlanInput, type PlanTask } from "./plan";
import { DEFAULT_HOME_RULE, parseHomeRule, type HomeRule, type HomeRow } from "./rule";

/** The user's own "Ligar agora" rule and day plan (RLS: own row only). A missing row, a read error or a broken value all give the defaults: the Home never crashes on them. */
export async function loadHomeSetup(db: SupabaseClient, workspaceId: string, userId: string): Promise<{ rule: HomeRule; plan: DayPlan }> {
  const { data, error } = await db.from("home_rules").select("rule, plan").eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
  return error || !data ? { rule: DEFAULT_HOME_RULE, plan: parsePlan({}) } : { rule: parseHomeRule(data.rule), plan: parsePlan(data.plan) };
}

const NO_ANSWER = new Set(["no_answer", "voicemail"]);
const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);

/**
 * Everything the day plan reads besides the leads, as the user (RLS: the closer sees her leads' tasks and calls and no
 * e-mail data). Tasks: open ones plus those done today. Calls: summed per lead. E-mail: leads sent a real e-mail today
 * and leads whose address or domain is blocked. Marks: the user's own ticks today.
 */
export async function loadPlanData(db: SupabaseClient, workspaceId: string, userId: string, rows: HomeRow[], now: Date): Promise<Omit<PlanInput, "now" | "userId" | "sender" | "rows">> {
  const start = daysAgoStart(0, now).toISOString();
  const today = nyDay(now);
  const [tasks, logs, sent, blocked, marks] = await Promise.all([
    db
      .from("tasks")
      .select("id, lead_id, kind, title, due_at, done_at, assignee_id, created_at")
      .eq("workspace_id", workspaceId)
      .or(`done_at.is.null,done_at.gte.${start}`)
      .order("due_at")
      .order("id")
      .limit(2000),
    callResultLogs(db, workspaceId),
    db.from("email_messages").select("email_prospects(lead_id)").eq("workspace_id", workspaceId).eq("status", "sent").gte("sent_at", start).limit(1000),
    db.from("suppressions").select("kind, value").eq("workspace_id", workspaceId).limit(5000),
    db.from("day_plan_marks").select("item_key").eq("workspace_id", workspaceId).eq("user_id", userId).eq("day", today).limit(500),
  ]);
  if (tasks.error) throw new Error(`loadPlanData tasks: ${tasks.error.message}`);

  const calls: Record<string, PlanCalls> = {};
  // newest first: the first call seen per lead is its latest
  for (const c of logs) {
    const k = (calls[c.lead_id] ??= { noAnswer: 0, last: c.outcome, lastAt: c.called_at, byMeToday: false });
    if (NO_ANSWER.has(c.outcome)) k.noAnswer++;
    if (c.called_by === userId && nyDay(new Date(c.called_at)) === today) k.byMeToday = true;
  }
  const emailedToday = [
    ...new Set(
      (sent.data ?? []).flatMap((m) => {
        const p = (m as { email_prospects: { lead_id: string | null } | { lead_id: string | null }[] | null }).email_prospects;
        return (Array.isArray(p) ? p : p ? [p] : []).map((x) => x.lead_id).filter((x): x is string => Boolean(x));
      }),
    ),
  ];
  const addr = new Set<string>(), dom = new Set<string>();
  for (const s of (blocked.data ?? []) as { kind: "address" | "domain"; value: string }[]) (s.kind === "address" ? addr : dom).add(s.value.trim().toLowerCase());
  const suppressed = rows
    .filter((r) => {
      const e = r.display.email?.trim().toLowerCase();
      return e ? addr.has(e) || dom.has(domainOf(e)) : false;
    })
    .map((r) => r.lead.id);
  return {
    tasks: (tasks.data ?? []) as PlanTask[],
    calls,
    emailedToday,
    suppressed,
    marks: ((marks.data ?? []) as { item_key: string }[]).map((m) => m.item_key),
  };
}
