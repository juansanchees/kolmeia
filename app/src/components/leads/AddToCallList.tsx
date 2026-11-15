"use client";

import { useState } from "react";
import { addToCallListAction } from "@/app/(app)/leads/lead-actions";
import { ActionButton } from "@/components/email/ActionButton";
import { Field } from "@/components/ui";
import { t } from "@/messages/pt";

const H = t.handoff;

/** Puts the lead on the list of a running call agent. */
export function AddToCallList({ leadId, agents }: { leadId: string; agents: { id: string; name: string }[] }) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  if (agents.length === 0) return <p className="text-sm text-muted">{H.noCallAgent}</p>;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label={H.listAgent} htmlFor="call-agent">
        <select id="call-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} className="min-h-11 min-w-0 border border-line bg-surface px-2.5 text-sm text-ink">
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
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
