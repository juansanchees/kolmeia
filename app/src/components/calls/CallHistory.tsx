import { when } from "@/components/email/format";
import type { CallLogRow } from "@/lib/calls/types";
import { getT } from "@/lib/i18n/server";
import { Paged } from "@/components/Pager";
import { BlockTitle } from "@/components/leads/SectionIntro";
import { Badge } from "@/components/ui";

export async function CallHistory({ calls }: { calls: CallLogRow[] }) {
  const t = await getT();
  const C = t.calls;
  return (
    <section aria-labelledby="calls-title" className="flex flex-col gap-3">
      <BlockTitle id="calls-title">{C.history}</BlockTitle>
      {calls.length === 0 ? (
        <p className="m-0 text-base text-[#4a5361]">{C.noHistory}</p>
      ) : (
        <Paged as="ul" className="m-0 flex list-none flex-col gap-2.5 p-0">
          {calls.map((c) => (
            <li key={c.id} className="flex flex-col gap-1 rounded-2xl border border-[#e3e6ec] bg-surface px-4 py-3 text-base">
              <span className="flex flex-wrap items-center justify-between gap-2">
                <Badge tone="honey">{C.outcomes[c.outcome]}</Badge>
                <span className="font-mono text-sm text-[#4a5361]">{when(c.called_at, t.intl)}</span>
              </span>
              {c.spoke_to && <span className="font-medium">{c.spoke_to}</span>}
              {c.notes && <span className="text-[#4a5361]">{c.notes}</span>}
              {c.next_step && (
                <span className="border-l-4 border-honey pl-3 font-semibold">
                  {c.next_step}
                  {c.next_step_at && <span className="font-normal text-[#4a5361]"> · {when(c.next_step_at, t.intl)}</span>}
                </span>
              )}
            </li>
          ))}
        </Paged>
      )}
    </section>
  );
}
