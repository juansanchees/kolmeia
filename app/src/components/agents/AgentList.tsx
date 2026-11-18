import Link from "next/link";
import { agentRowView, type LastRun } from "@/lib/agents/view";
import type { AgentRow } from "@/lib/agents/types";
import { ArchiveButton } from "./ArchiveButton";
import { Paged } from "@/components/Pager";
import { Badge, buttonClass, Chevron, Icon } from "@/components/ui";
import { STATUS_TONE, TYPE_ICON } from "./type-icons";
import { getT } from "@/lib/i18n/server";

/** The agents as a grid of cards: type icon, name, what it is doing now, status badge, open + archive. */
export async function AgentList({ agents, listSizes = {}, lastRuns = {} }: { agents: AgentRow[]; listSizes?: Record<string, number>; lastRuns?: Record<string, LastRun> }) {
  const t = await getT();
  const now = new Date();
  return (
    <Paged as="ul" className="m-0 grid list-none gap-3.5 p-0 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
      {agents.map((a, n) => {
        const v = agentRowView(a, now, t, { listSize: a.type === "call" ? (listSizes[a.id] ?? 0) : undefined, lastRun: lastRuns[a.id] });
        return (
          <li
            key={a.id}
            style={n < 12 ? { animationDelay: `${0.08 + n * 0.04}s` } : undefined}
            className={`flex min-w-0 flex-col gap-3 rounded-2xl border border-[#e3e6ec] bg-surface p-5 shadow-[0_6px_14px_-8px_rgba(15,27,61,0.12)] ${n < 12 ? "k-in" : ""}`}
          >
            <div className="flex items-start gap-3">
              <span className="hxv inline-flex h-[50px] w-11 shrink-0 items-center justify-center bg-honey-soft text-ink">
                <Icon d={TYPE_ICON[a.type]} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Link href={v.href} title={a.name} className="k-link truncate text-[19px] font-semibold text-ink underline-offset-4 decoration-2 decoration-honey hover:underline">
                  {a.name}
                </Link>
                <span className="text-[15px] text-[#4a5361]">
                  {v.type} · {v.metric}
                </span>
              </div>
              <Badge tone={STATUS_TONE[a.status]} dot={a.status === "running"} className="shrink-0">
                {v.status}
              </Badge>
            </div>
            <div className="mt-auto flex flex-wrap items-center gap-2.5">
              <Link href={v.href} className={buttonClass("primary", "sm")}>
                {v.cta} <Chevron size={16} className="k-arrow" />
              </Link>
              {a.status !== "running" && <ArchiveButton agentId={a.id} />}
            </div>
          </li>
        );
      })}
    </Paged>
  );
}
