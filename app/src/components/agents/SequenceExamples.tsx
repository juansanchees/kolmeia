"use client";

import { Notice } from "@/components/ui";
import { buildFooter } from "@/lib/email/compose";
import type { SenderProfile } from "@/lib/email/types";
import type { SequenceExample } from "@/lib/email-agent/types";
import { fill } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

/**
 * The examples exactly as the recipient gets them: subject, body and the CAN-SPAM footer (sender, postal address,
 * unsubscribe line). The link itself is a placeholder here: the real one is made per message at send time.
 */
export function SequenceExamples({ examples, sender, rehearsalOnly }: { examples: SequenceExample[]; sender: SenderProfile | null; rehearsalOnly: boolean }) {
  const t = useT();
  const D = t.emailAgent.detail;
  return (
    <section aria-label={D.examples} className="flex flex-col gap-3">
      <p className="m-0 text-base text-[#4a5361]">{D.examplesHint}</p>
      {rehearsalOnly && <Notice tone="warn">{D.rehearsalOnly}</Notice>}
      {examples.length === 0 && <p className="m-0 text-base text-[#4a5361]">{D.examplesNone}</p>}
      <ol className="m-0 flex list-none flex-col gap-4 p-0">
        {examples.map((ex) => (
          <li key={ex.prospect_id} className="flex flex-col gap-3 rounded-2xl border border-[#e3e6ec] bg-surface p-4">
            <p className="m-0 font-mono text-sm text-[#4a5361]">{fill(D.exampleFor, { company: ex.company, to: ex.to })}</p>
            {ex.steps.map((s) => (
              <article key={s.step} className="flex flex-col gap-1 rounded-[12px] bg-ground px-3.5 py-3" data-example-step={s.step}>
                <span className="font-mono text-[13px] uppercase tracking-wide text-[#4a5361]">{fill(D.stepTitle, { n: s.step })}</span>
                <p className="m-0 text-base font-semibold">{s.subject}</p>
                <pre className="m-0 whitespace-pre-wrap font-body text-[15px]">{s.body}</pre>
                {sender ? (
                  <pre className="m-0 mt-1 whitespace-pre-wrap font-mono text-[13px] text-[#4a5361]" data-footer>
                    {buildFooter(sender, D.unsubLink)}
                  </pre>
                ) : null}
              </article>
            ))}
          </li>
        ))}
      </ol>
    </section>
  );
}
