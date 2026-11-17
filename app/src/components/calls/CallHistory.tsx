import { when } from "@/components/email/format";
import type { CallLogRow } from "@/lib/calls/types";
import { getT } from "@/lib/i18n/server";
import { Paged } from "@/components/Pager";

export async function CallHistory({ calls }: { calls: CallLogRow[] }) {
  const t = await getT();
  const C = t.calls;
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
                <span className="font-mono text-xs text-muted">{when(c.called_at, t.intl)}</span>
              </span>
              {c.spoke_to && <span>{c.spoke_to}</span>}
              {c.notes && <span className="text-muted">{c.notes}</span>}
              {c.next_step && (
                <span className="font-semibold">
                  {c.next_step}
                  {c.next_step_at && <span className="font-normal text-muted"> · {when(c.next_step_at, t.intl)}</span>}
                </span>
              )}
            </li>
          ))}
        </Paged>
      )}
    </section>
  );
}
