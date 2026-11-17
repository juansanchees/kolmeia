"use client";

import { useState, useTransition } from "react";
import { summarizeWhyHotAction } from "@/app/(app)/leads/why-hot-actions";
import { Button, HexIcon, Notice } from "@/components/ui";
import { BlockTitle } from "@/components/leads/SectionIntro";
import { host, usd } from "@/components/research/format";
import type { WhyFact } from "@/lib/leads/why-hot";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

/** "Por que este lead é quente?": the numbered facts with their sources; senders may ask a capped AI summary of them. */
export function WhyHot({ leadId, facts, canSummarize, reserveUsd }: { leadId: string; facts: WhyFact[]; canSummarize: boolean; reserveUsd: number }) {
  const t = useT();
  const W = t.leads.whyHot;
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const thin = facts.length <= 1;
  return (
    <section aria-labelledby="why-title" className="flex min-w-0 flex-col gap-4 rounded-2xl border border-[#e3e6ec] bg-surface p-5 shadow-[0_6px_14px_-8px_rgba(15,27,61,0.12)] md:p-6">
      <BlockTitle id="why-title">{W.title}</BlockTitle>
      <ol className="m-0 flex list-none flex-col gap-2.5 p-0 text-base">
        {facts.map((f, n) => (
          <li key={`${n}-${f.text}`} className="flex items-start gap-3">
            <HexIcon n={n + 1} size={28} />
            <span className="min-w-0 pt-0.5">
              {f.text}
              {f.url && (
                <>
                  {" "}
                  <a href={f.url} target="_blank" rel="noopener noreferrer nofollow" className="k-link text-[15px] underline">{host(f.url)} ↗</a>
                </>
              )}
            </span>
          </li>
        ))}
      </ol>
      {thin && <p className="m-0 text-[15px] text-[#4a5361]">{W.none}</p>}
      {canSummarize && !thin && !summary && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={() => start(async () => {
            const r = await summarizeWhyHotAction(leadId);
            if (r.ok) setSummary(r.summary);
            else setError(r.error);
          })}
          className="w-fit"
        >
          {fill(W.summarize, { usd: `US$ ${usd(reserveUsd, t.intl)}` })}
        </Button>
      )}
      {summary && (
        <div className="k-fade flex flex-col gap-1 rounded-[14px] border-l-4 border-honey bg-honey-soft px-4 py-3">
          <span className="font-mono text-[13px] font-medium uppercase tracking-wide text-[#4a5361]">{W.summary}</span>
          <p className="m-0 text-base">{summary}</p>
        </div>
      )}
      {error && <Notice tone="danger" role="alert">{error}</Notice>}
    </section>
  );
}
