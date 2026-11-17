"use client";

import { useRef, useState } from "react";
import { isStaleProof } from "@/lib/leads/view";
import type { CandidateRow } from "@/lib/research/rows";
import type { CheckWithEvidence } from "@/lib/research/store";
import { useT } from "@/lib/i18n/client";
import { Pill } from "./controls";
import { date, host } from "./format";

function StaleTag() {
  const t = useT();
  return <span className="ml-1.5 border border-line px-1 font-mono text-[11px] text-muted">{t.leads.stale}</span>;
}

export function Hook({ text }: { text: string }) {
  const t = useT();
  const L = t.research.list;
  const ref = useRef<HTMLQuoteElement>(null);
  const [label, setLabel] = useState<string>(L.copyHook);
  const copy = () => {
    const fallback = () => {
      if (!ref.current) return;
      const range = document.createRange();
      range.selectNodeContents(ref.current);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      setLabel(L.copyFallback);
    };
    try {
      navigator.clipboard.writeText(text).then(() => {
        setLabel(L.copied);
        setTimeout(() => setLabel(L.copyHook), 1600);
      }, fallback);
    } catch {
      fallback();
    }
  };
  return (
    <div className="flex flex-col gap-2 bg-blue-soft p-3.5">
      <span className="font-mono text-xs text-blue-ink">{L.hook}</span>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <q ref={ref} lang="en" className="min-w-0 flex-[1_1_320px] text-base leading-normal [quotes:none]">
          {text}
        </q>
        <button type="button" onClick={copy} aria-live="polite" className="min-h-11 border border-blue bg-blue px-4 text-sm font-semibold text-white">
          {label}
        </button>
      </div>
    </div>
  );
}

export function ProofList({ c, checks, now }: { c: CandidateRow; checks: CheckWithEvidence[]; now: Date }) {
  const t = useT();
  const L = t.research.list;
  const LB = t.research.labels;
  const K = t.research.plan.checks;
  const secondPass = c.second_pass;
  const byPass = [1, 2].map((p) => checks.filter((k) => k.pass === p));
  return (
    <div className="flex flex-col gap-3">
      {c.found_at_url && (
        <span className="text-[12px] text-muted">
          <span className="font-semibold text-ink">{L.foundAt} </span>
          <a href={c.found_at_url} target="_blank" rel="noopener noreferrer" className="text-blue underline underline-offset-2">
            {c.found_at_title || host(c.found_at_url)}
          </a>
          {c.found_at_seen_at && ` · ${L.seenOn} ${date(c.found_at_seen_at, t.intl)}`}
          {isStaleProof(c.found_at_seen_at, now) && <StaleTag />}
          {c.found_at_excerpt && <span className="block italic">“{c.found_at_excerpt}”</span>}
        </span>
      )}
      {byPass.map((list, i) =>
        list.length ? (
          <div key={i} className="flex flex-col gap-2">
            <span className="font-mono text-[11px] uppercase text-blue-ink">
              {L.pass[(i + 1) as 1 | 2]}
              {i === 1 && secondPass ? ` · ${secondPass === "refuted" ? L.refuted : secondPass === "unsure" ? L.unsure : "ok"}` : ""}
            </span>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {list.map((k) => (
                <li key={k.id} className="flex flex-col gap-1 border-t border-line pt-2">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold">{K[k.kind]}</span>
                    <Pill tone={k.result}>{LB.result[k.result]}</Pill>
                  </span>
                  <span className="text-[13px]">
                    {k.result === "unknown" && <span className="font-semibold">{L.unknownReason} </span>}
                    {k.summary}
                  </span>
                  {k.evidence.map((e) => (
                    <span key={e.url} className="text-[12px] text-muted">
                      <a href={e.url} target="_blank" rel="noopener noreferrer" className="text-blue underline underline-offset-2">
                        {e.title || host(e.url)}
                      </a>{" "}
                      · {L.seenOn} {date(e.seen_at, t.intl)}
                      {isStaleProof(e.seen_at, now) && <StaleTag />}
                      {e.excerpt && <span className="block italic">“{e.excerpt}”</span>}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
    </div>
  );
}
