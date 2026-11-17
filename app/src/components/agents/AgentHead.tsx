import type { ReactNode } from "react";
import type { AgentRow } from "@/lib/agents/types";
import { Badge, Icon } from "@/components/ui";
import { STATUS_TONE, TYPE_ICON } from "./type-icons";

/** Top of an agent page: type icon in a honey hexagon, the name, type and status badges (+ extra badges). No hooks. */
export function AgentHead({ id, name, type, typeLabel, status, statusLabel, children }: {
  id: string;
  name: string;
  type: AgentRow["type"];
  typeLabel: string;
  status: AgentRow["status"];
  statusLabel: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <span className="hxv inline-flex h-[58px] w-[52px] shrink-0 items-center justify-center bg-honey text-ink">
        <Icon d={TYPE_ICON[type]} size={26} />
      </span>
      <h2 id={id} className="min-w-0 flex-1 text-3xl">
        {name}
      </h2>
      <span className="flex flex-wrap items-center gap-2">
        <Badge tone="honey">{typeLabel}</Badge>
        <Badge tone={STATUS_TONE[status]} dot={status === "running"}>
          {statusLabel}
        </Badge>
        {children}
      </span>
    </div>
  );
}

/** A number tile inside a <dl>: mono label (dt) over a big number (dd). */
export function DlStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-2xl border border-[#e3e6ec] bg-ground p-4">
      <dt className="font-mono text-[13px] uppercase tracking-wide text-[#4a5361]">{label}</dt>
      <dd className="m-0 font-display text-3xl font-bold leading-none">{value}</dd>
    </div>
  );
}
