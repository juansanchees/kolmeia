import type { tasks as pt } from "../pt/tasks";
import type { Widen } from "../widen";

export const tasks = {
  title: "Tasks",
  subtitle: "Created on their own from the dated \"next step\" you write when logging a call.",
  tabs: { label: "When", today: "Today", late: "Overdue", next: "Upcoming" },
  kinds: { call: "Call", email: "Email", follow_up: "Follow-up", other: "Other" },
  defaultTitle: { call: "Return the call", email: "Send an email", follow_up: "Follow up", other: "Task" },
  done: "Done",
  postpone: "Push 1 day",
  lead: "Lead",
  empty: { today: "Nothing for today.", late: "No overdue tasks.", next: "No tasks scheduled for the next few days." },
  failed: "That did not work. Try again.",
} satisfies Widen<typeof pt>;
