"use client";

import { useState } from "react";
import { addToCallListAction } from "@/app/(app)/leads/lead-actions";
import { ActionButton } from "@/components/email/ActionButton";
import { Field, Select } from "@/components/ui";
import { useT } from "@/lib/i18n/client";

/** Puts the lead on the list of a running call agent. */
export function AddToCallList({ leadId, agents }: { leadId: string; agents: { id: string; name: string }[] }) {
  const t = useT();
  const H = t.handoff;
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  if (agents.length === 0) return <p className="m-0 text-base text-[#4a5361]">{H.noCallAgent}</p>;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label={H.listAgent} htmlFor="call-agent">
        <Select id="call-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} className="w-auto! min-w-56">
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      </Field>
      <ActionButton
        action={async () => {
          const r = await addToCallListAction(leadId, agentId);
          return { ok: r.status === "success", message: r.message };
        }}
        label={H.addToList}
      />
    </div>
  );
}
