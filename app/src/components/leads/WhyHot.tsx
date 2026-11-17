"use client";

import { useState, useTransition } from "react";
import { summarizeWhyHotAction } from "@/app/(app)/leads/why-hot-actions";
import { btn, Notice } from "@/components/email/bits";
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
    <section aria-labelledby="why-title" className="flex flex-col gap-2 border border-line bg-surface p-4">
      <h2 id="why-title" className="text-xl">{W.title}</h2>
      <ol className="m-0 flex flex-col gap-1 pl-6 text-sm">
        {facts.map((f, n) => (
          <li key={`${n}-${f.text}`}>
            {f.text}
            {f.url && (
              <>
                {" "}
                <a href={f.url} target="_blank" rel="noopener noreferrer nofollow" className="text-[13px] text-blue underline underline-offset-2">{host(f.url)} ↗</a>
              </>
            )}
          </li>
        ))}
      </ol>
      {thin && <p className="m-0 text-[13px] text-muted">{W.none}</p>}
      {canSummarize && !thin && !summary && (
        <button
          type="button"
          disabled={pending}
          onClick={() => start(async () => {
            const r = await summarizeWhyHotAction(leadId);
            if (r.ok) setSummary(r.summary);
            else setError(r.error);
          })}
          className={`${btn.ghost} w-fit`}
        >
          {fill(W.summarize, { usd: `US$ ${usd(reserveUsd, t.intl)}` })}
        </button>
      )}
      {summary && (
        <div className="flex flex-col gap-1 border-l-2 border-blue pl-3">
          <span className="font-mono text-xs text-muted">{W.summary}</span>
          <p className="m-0 text-sm">{summary}</p>
        </div>
      )}
      {error && <Notice tone="warn" role="alert">{error}</Notice>}
    </section>
  );
}
