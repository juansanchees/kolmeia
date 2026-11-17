import type { funnel as pt } from "../pt/funnel";
import type { Widen } from "../widen";

export const funnel = { tab: "Funnel", origin: "Source", total: "Total" } satisfies Widen<typeof pt>;
