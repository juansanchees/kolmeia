import type { funnel as pt } from "../pt/funnel";
import type { Widen } from "../widen";

export const funnel = {
  tab: "Funnel",
  origin: "Source",
  total: "Total",
  title: "Funnel by source",
  subtitle: "How many leads from each source are at each stage.",
  overall: "All leads, by stage",
  byOrigin: "By source",
  empty: "No leads yet.",
  emptyHint: "Once the Leads list has companies, the funnel shows up here.",
} satisfies Widen<typeof pt>;
