import type { results as pt } from "../pt/results";
import type { Widen } from "../widen";

export const results = {
  tab: "Results",
  title: "Contact results",
  subtitle: "Each lead shows up once, under the result of its last logged contact.",
  tabs: {
    label: "Result",
    no_answer: "No answer",
    meeting_booked: "Wants a meeting",
    call_back: "Call back later",
    not_interested: "Not interested",
    do_not_call: "Do not call",
    voicemail: "Voicemail",
    wrong_number: "Wrong number",
  },
  empty: "No contacts logged yet. Log one with the Log contact button on the lead.",
  emptyGroup: "No leads with this result.",
  cols: { lead: "Company", result: "Result", note: "Note", by: "Who", when: "When" },
  callBack: "Call on",
  open: "Open",
  unknown: "—",
  you: "You",
  team: "Team",
} satisfies Widen<typeof pt>;
