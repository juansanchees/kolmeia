// Client-safe: the Início day plan ("Plano de hoje"). The user's own setup (zod, defaults, fallback) and the pure
// builder that turns the leads, tasks and calls the user can see into today's numbered blocks. No I/O here: the page
// loads the data (queries.ts), the builder decides what shows, the screen only words it.
import { z } from "zod";
import type { CallOutcome } from "@/lib/calls/types";
import { nyDay } from "@/lib/calls/ny-day";
import { telHref } from "@/lib/calls/view";
import { stageOf } from "@/lib/leads/classify";
import type { Segment } from "@/lib/leads/types";
import { daysAgoStart } from "@/lib/leads/view";
import type { TaskKind, TaskRow } from "@/lib/tasks/view";
import { HOME_SEGMENTS, homeMatches, type HomeRow, type HomeRule } from "./rule";

export const BLOCKS = ["returns", "call", "email", "review"] as const;
export type BlockId = (typeof BLOCKS)[number];
export const REVIEW_KINDS = ["meetingNoDate", "newYesterday", "bigNoContact", "noType"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];
/** Task kinds that are a promised return ("Retornos combinados"). Meetings live on the Agenda. */
export const RETURN_KINDS: readonly TaskKind[] = ["call", "follow_up", "email"];
export const COUNT_MIN = 1;
export const COUNT_MAX = 20;
export const NO_ANSWER_MIN = 2;
export const NO_ANSWER_MAX = 5;
/** "Respondeu e parou de responder": replied, and nothing touched the lead for more than this many days. */
export const SILENT_DAYS = 7;

const count = z.number().int().min(COUNT_MIN).max(COUNT_MAX);
const parts = {
  order: z.array(z.enum(BLOCKS)).length(BLOCKS.length).refine((o) => new Set(o).size === BLOCKS.length),
  hidden: z.array(z.enum(BLOCKS)).max(BLOCKS.length),
  counts: z.object({ returns: count, call: count, email: count, review: count }),
  returns: z.object({ late: z.boolean(), today: z.boolean(), tomorrow: z.boolean(), team: z.boolean() }),
  email: z.object({
    noAnswer: z.boolean(),
    noAnswerN: z.number().int().min(NO_ANSWER_MIN).max(NO_ANSWER_MAX),
    noPhone: z.boolean(),
    silent: z.boolean(),
    /** Empty = any type. */
    segments: z.array(z.enum(HOME_SEGMENTS)).max(HOME_SEGMENTS.length),
  }),
  review: z.object({ meetingNoDate: z.boolean(), newYesterday: z.boolean(), bigNoContact: z.boolean(), noType: z.boolean() }),
};
export const planSchema = z.object(parts);
export type DayPlan = z.infer<typeof planSchema>;

export const DEFAULT_PLAN: DayPlan = {
  order: [...BLOCKS],
  hidden: [],
  counts: { returns: 5, call: 5, email: 5, review: 3 },
  returns: { late: true, today: true, tomorrow: false, team: false },
  email: { noAnswer: true, noAnswerN: 2, noPhone: true, silent: true, segments: [] },
  review: { meetingNoDate: true, newYesterday: true, bigNoContact: true, noType: true },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A stored plan over the default, part by part: a missing key takes the default, a broken part falls back alone. Never throws. */
export function parsePlan(raw: unknown): DayPlan {
  const o = isObj(raw) ? raw : {};
  const one = <K extends keyof DayPlan>(k: K): DayPlan[K] => {
    const d = DEFAULT_PLAN[k];
    const r = (parts[k] as unknown as z.ZodType<DayPlan[K]>).safeParse(isObj(d) && isObj(o[k]) ? { ...d, ...o[k] } : (o[k] ?? d));
    return r.success ? r.data : d;
  };
  return { order: one("order"), hidden: one("hidden"), counts: one("counts"), returns: one("returns"), email: one("email"), review: one("review") };
}

/** A block one step up (-1) or down (+1) in the order; out of range = unchanged. */
export function moveBlock(order: readonly BlockId[], id: BlockId, dir: -1 | 1): BlockId[] {
  const o = [...order];
  const i = o.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= o.length) return o;
  [o[i], o[j]] = [o[j], o[i]];
  return o;
}

// ---------------------------------------------------------------- the data the builder reads

export type PlanTask = Pick<TaskRow, "id" | "lead_id" | "kind" | "title" | "due_at" | "done_at" | "assignee_id"> & { created_at: string };
/** One lead's calls: how many went unanswered (no answer / voicemail), the newest outcome and time, and whether the user called today. */
export type PlanCalls = { noAnswer: number; last: CallOutcome | null; lastAt: string | null; byMeToday: boolean };

export type PlanInput = {
  /** ISO instant; the New York day of it is "today". */
  now: string;
  userId: string;
  sender: boolean;
  /** The leads the user sees, closed ones left out (RLS: the closer only hers). */
  rows: HomeRow[];
  /** Open tasks and tasks done today. */
  tasks: PlanTask[];
  calls: Record<string, PlanCalls>;
  /** Leads a real e-mail went to today. */
  emailedToday: string[];
  /** Leads whose e-mail address or domain is blocked (unsubscribed, bounced, asked to stop, by hand). */
  suppressed: string[];
  /** Item keys the user ticked by hand today. */
  marks: string[];
};

export type Reason =
  | { t: "late"; days: number }
  | { t: "today"; at: string }
  | { t: "tomorrow"; at: string }
  | { t: "fresh" }
  | { t: "noAnswer"; n: number }
  | { t: "noPhone" }
  | { t: "silent" }
  | { t: "review"; kind: ReviewKind; n: number };

/** What the item's button does: call screen, e-mail (lead), look at leads, or the new-meeting dialog. */
export type ItemAction = "call" | "email" | "look" | "meeting";

export type PlanItem = {
  key: string;
  block: BlockId;
  action: ItemAction;
  leadId: string | null;
  /** Company name; "" for a count item ("4 empresas novas"). */
  name: string;
  city: string | null;
  segment: Segment | null;
  /** The task's own text, when there is one. */
  note: string;
  reason: Reason;
  hot: boolean;
  href: string | null;
  done: boolean;
  /** Done by a real action today (call, task, e-mail): it cannot be unticked. */
  real: boolean;
};

export type PlanBlock = { id: BlockId; hidden: boolean; items: PlanItem[]; available: number };
export type BuiltPlan = { blocks: PlanBlock[]; total: number; done: number; next: PlanItem | null; queue: PlanItem[] };

const DAY = 86_400_000;
const dayNum = (ymd: string) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / DAY;
const nyTime = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** "task:<id>", "call:<lead>", "email:<lead>", "review:..." — what a manual tick is saved as. */
export const ITEM_KEY = /^(task|call|email|review):[A-Za-z0-9:_-]{1,100}$/;

/** Today's plan for this user. Every block is built (the setup dialog previews hidden ones too); a lead shows once, in the first visible block that picks it. */
export function buildPlan(input: PlanInput, plan: DayPlan, rule: HomeRule): BuiltPlan {
  const now = new Date(input.now);
  const today = nyDay(now);
  const startToday = daysAgoStart(0, now).getTime();
  const endToday = daysAgoStart(-1, now).getTime();
  const endTomorrow = daysAgoStart(-2, now).getTime();
  const startYesterday = daysAgoStart(1, now).getTime();
  const marks = new Set(input.marks);
  const emailed = new Set(input.emailedToday);
  const suppressed = new Set(input.suppressed);
  const byId = new Map(input.rows.map((r) => [r.lead.id, r]));
  const taken = new Set<string>();
  const hidden = new Set(plan.hidden);
  const calls = (id: string): PlanCalls => input.calls[id] ?? { noAnswer: 0, last: null, lastAt: null, byMeToday: false };
  const free = (r: HomeRow) => !taken.has(r.lead.id);

  const leadItem = (block: BlockId, key: string, r: HomeRow, action: ItemAction, reason: Reason, real: boolean, extra: Partial<PlanItem> = {}): PlanItem => ({
    key, block, action, leadId: r.lead.id, name: r.display.name, city: r.display.city?.trim() || null, segment: r.segment ?? null, note: "",
    reason, hot: false, href: action === "call" ? `/leads/ligar/${r.lead.id}` : `/leads?lead=${r.lead.id}`,
    done: real || marks.has(key), real, ...extra,
  });

  const builders: Record<BlockId, (n: number) => { items: PlanItem[]; available: number; rest?: PlanItem[] }> = {
    returns: (n) => {
      const c = plan.returns;
      // "mine" = assigned to me; a closer also sees every task on the leads she owns, whoever it is assigned to
      const mine = !(c.team && input.sender);
      const picked = input.tasks
        .filter((x) => RETURN_KINDS.includes(x.kind) && byId.has(x.lead_id) && (!mine || x.assignee_id === input.userId || (!input.sender && byId.get(x.lead_id)?.lead.owner_id === input.userId)))
        .map((x) => {
          const due = Date.parse(x.due_at);
          const when: "late" | "today" | "tomorrow" | null = due < startToday ? "late" : due < endToday ? "today" : due < endTomorrow ? "tomorrow" : null;
          return { x, when };
        })
        .filter((p): p is { x: PlanTask; when: "late" | "today" | "tomorrow" } => p.when !== null && c[p.when])
        .sort((a, b) => Date.parse(a.x.due_at) - Date.parse(b.x.due_at) || a.x.id.localeCompare(b.x.id));
      const items = picked.slice(0, n).map(({ x, when }) => {
        const r = byId.get(x.lead_id)!;
        const k = calls(x.lead_id);
        // a call on the lead after the task was written answers it, like the 0027 trigger does for call follow-ups
        const calledAfter = k.lastAt !== null && nyDay(new Date(k.lastAt)) === today && Date.parse(k.lastAt) > Date.parse(x.created_at);
        const reason: Reason = when === "late" ? { t: "late", days: Math.max(1, dayNum(today) - dayNum(nyDay(new Date(x.due_at)))) } : { t: when, at: nyTime(x.due_at) };
        return leadItem("returns", `task:${x.id}`, r, x.kind === "email" ? "email" : "call", reason, x.done_at !== null || calledAfter, { note: x.title, hot: when !== "tomorrow" });
      });
      return { items, available: picked.length };
    },
    call: (n) => {
      const base = input.rows.filter(free);
      const open = homeMatches(base, rule);
      // called today for the first time: they were in this morning's queue, so they stay on the plan, done
      const firstToday = base.filter((r) => calls(r.lead.id).byMeToday && r.lead.first_contacted_at && nyDay(new Date(r.lead.first_contacted_at)) === today);
      const asNew = firstToday.map((r) => ({ ...r, lead: { ...r.lead, status: "new" as const, first_contacted_at: null, do_not_call: false } }));
      const doneIds = new Set(homeMatches(asNew, rule).map((r) => r.lead.id));
      const done = firstToday.filter((r) => doneIds.has(r.lead.id));
      const items = [
        ...done.map((r) => leadItem("call", `call:${r.lead.id}`, r, "call", { t: "fresh" }, true)),
        ...open.map((r) => leadItem("call", `call:${r.lead.id}`, r, "call", { t: "fresh" }, false)),
      ];
      return { items: items.slice(0, n), available: items.length, rest: items.slice(n) };
    },
    email: (n) => {
      const c = plan.email;
      const RANK = { noAnswer: 0, noPhone: 1, silent: 2 } as const;
      const picked: { r: HomeRow; reason: Reason }[] = [];
      for (const r of input.rows) {
        if (!free(r) || !r.display.email?.trim() || r.lead.do_not_call || r.emailQuality === "invalid" || suppressed.has(r.lead.id)) continue;
        if (c.segments.length > 0 && !c.segments.includes(r.segment ?? "none")) continue;
        const stage = stageOf(r.lead);
        if (stage === "closed") continue;
        const k = calls(r.lead.id);
        const touched = r.lead.last_touch_at ?? r.lead.first_seen_at;
        const reason: Reason | null =
          c.noAnswer && k.noAnswer >= c.noAnswerN ? { t: "noAnswer", n: k.noAnswer }
          : c.noPhone && telHref(r.display.phone ?? "") === null ? { t: "noPhone" }
          : c.silent && stage === "replied" && Date.parse(touched) < now.getTime() - SILENT_DAYS * DAY ? { t: "silent" }
          : null;
        if (reason) picked.push({ r, reason });
      }
      picked.sort((a, b) => RANK[a.reason.t as keyof typeof RANK] - RANK[b.reason.t as keyof typeof RANK]); // stable: list order within a reason
      const items = picked.slice(0, n).map(({ r, reason }) => leadItem("email", `email:${r.lead.id}`, r, "email", reason, emailed.has(r.lead.id)));
      return { items, available: picked.length };
    },
    review: (n) => {
      const c = plan.review;
      const open = input.rows.filter((r) => stageOf(r.lead) !== "closed");
      const meetingAhead = new Set(input.tasks.filter((x) => x.kind === "meeting" && !x.done_at && Date.parse(x.due_at) >= startToday).map((x) => x.lead_id));
      const items: PlanItem[] = [];
      const count = (kind: ReviewKind, key: string, rows: HomeRow[], href: string) => {
        if (rows.length === 0) return;
        items.push({ key, block: "review", action: "look", leadId: null, name: "", city: null, segment: null, note: "", reason: { t: "review", kind, n: rows.length }, hot: false, href, done: marks.has(key), real: false });
      };
      if (c.meetingNoDate) {
        for (const r of open.filter((r) => free(r) && calls(r.lead.id).last === "meeting_booked" && !meetingAhead.has(r.lead.id))) {
          items.push(leadItem("review", `review:meet:${r.lead.id}`, r, "meeting", { t: "review", kind: "meetingNoDate", n: 1 }, false, { hot: true, href: null }));
        }
      }
      if (c.newYesterday) {
        count("newYesterday", `review:new:${nyDay(new Date(startYesterday))}`, open.filter((r) => {
          const ms = Date.parse(r.lead.first_seen_at);
          return ms >= startYesterday && ms < startToday;
        }), "/leads?entered=yesterday");
      }
      if (c.bigNoContact) count("bigNoContact", "review:big", open.filter((r) => r.segment === "large" && !r.display.contactName?.trim() && !r.lead.do_not_call), "/leads?segment=large&noName=1");
      if (c.noType) count("noType", "review:notype", open.filter((r) => !r.segment), "/leads?segment=none");
      return { items: items.slice(0, n), available: items.length };
    },
  };

  let queue: PlanItem[] = [];
  const blocks: PlanBlock[] = plan.order.map((id) => {
    const built = builders[id](plan.counts[id]);
    const isHidden = hidden.has(id);
    if (!isHidden) for (const it of built.items) if (it.leadId) taken.add(it.leadId);
    if (id === "call" && !isHidden) queue = (built.rest ?? []).filter((i) => !i.done).slice(0, 3);
    return { id, hidden: isHidden, items: built.items, available: built.available };
  });
  const shown = blocks.filter((b) => !b.hidden).flatMap((b) => b.items);
  return { blocks, total: shown.length, done: shown.filter((i) => i.done).length, next: shown.find((i) => !i.done) ?? null, queue };
}
