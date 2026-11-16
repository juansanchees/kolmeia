import { when } from "@/components/email/format";
import type { CallLogRow } from "@/lib/calls/types";
import { t } from "@/messages/pt";
import { Paged } from "@/components/Pager";

const C = t.calls;

export function CallHistory({ calls }: { calls: CallLogRow[] }) {
  return (
    <section aria-labelledby="calls-title" className="flex flex-col gap-3">
      <h2 id="calls-title" className="text-2xl">
        {C.history}
      </h2>
      {calls.length === 0 ? (
        <p className="text-[13px] text-muted">{C.noHistory}</p>
      ) : (
        <Paged as="ul" className="m-0 flex list-none flex-col gap-2 p-0">
          {calls.map((c) => (
            <li key={c.id} className="flex flex-col gap-0.5 border border-line bg-surface p-3 text-sm">
              <span className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold">{C.outcomes[c.outcome]}</span>
                <span className="font-mono text-xs text-muted">{when(c.called_at)}</span>
              </span>
              {c.spoke_to && <span>{c.spoke_to}</span>}
              {c.notes && <span className="text-muted">{c.notes}</span>}
              {c.next_step && (
                <span className="font-semibold">
                  {c.next_step}
                  {c.next_step_at && <span className="font-normal text-muted"> · {when(c.next_step_at)}</span>}
                </span>
              )}
            </li>
          ))}
        </Paged>
      )}
    </section>
  );
}
