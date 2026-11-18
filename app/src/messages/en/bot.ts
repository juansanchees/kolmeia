import type { bot as pt } from "../pt/bot";
import type { Widen } from "../widen";

export const bot = {
  title: "Kolmeia robot",
  intro: "This page explains the robot that reads public company pages. It identifies itself with the address of this page.",
  whoTitle: "Who runs it",
  who: "The robot is run by Kolmeia (kolmeia.solutions), a research tool for construction and service companies.",
  readsTitle: "What it reads",
  reads: "Public pages of company websites (business phone, services, bids or vendor page) and public records, such as town permits.",
  rulesTitle: "How it behaves",
  robots: "It honours each site's robots.txt: if the site does not allow it, the robot does not read.",
  rate: "At most 1 request per second for each site.",
  noLogin: "It does not log in, fill in forms or use cookies.",
  uaTitle: "Identification (User-Agent)",
  uaLabel: "The robot sends this text with every request:",
} as const satisfies Widen<typeof pt>;
