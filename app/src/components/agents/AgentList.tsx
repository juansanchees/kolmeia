import Link from "next/link";
import { agentRowView } from "@/lib/agents/view";
import type { AgentRow } from "@/lib/agents/types";
import { ArchiveButton } from "./ArchiveButton";
import { Paged } from "@/components/Pager";
import { getT } from "@/lib/i18n/server";

export async function AgentList({ agents, listSizes = {} }: { agents: AgentRow[]; listSizes?: Record<string, number> }) {
  const t = await getT();
  const now = new Date();
  return (
    <Paged as="ul" className="m-0 flex list-none flex-col border border-line bg-surface p-0">
      {agents.map((a) => {
        const v = agentRowView(a, now, t, { listSize: a.type === "call" ? (listSizes[a.id] ?? 0) : undefined });
        return (
          <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 last:border-b-0">
            <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
              <Link href={v.href} className="text-base font-semibold text-ink underline-offset-4 hover:underline">
                {a.name}
              </Link>
              <span className="text-[13px] text-muted">
                {v.type} · {v.metric}
              </span>
            </div>
            <span className="inline-block whitespace-nowrap bg-cold px-2 py-0.5 font-mono text-xs text-cold-ink">{v.status}</span>
            <Link
              href={v.href}
              className="inline-flex min-h-11 items-center border border-edge bg-surface px-4 text-[15px] font-medium text-ink no-underline hover:border-ink"
            >
              {v.cta}
            </Link>
            {a.status !== "running" && <ArchiveButton agentId={a.id} />}
          </li>
        );
      })}
    </Paged>
  );
}
