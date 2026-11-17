import type { areas as pt } from "../pt/areas";
import type { Widen } from "../widen";

export const areas = {
  settings: {
    title: "Settings",
    nav: { label: "Settings sections", company: "Your company", mailboxes: "Mailboxes", blocked: "Blocked", sources: "Connected sources" },
  },
} satisfies Widen<typeof pt>;
