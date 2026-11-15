import { buildFooter } from "@/lib/email/compose";
import type { SenderProfile } from "@/lib/email/types";
import type { SequenceExample } from "@/lib/email-agent/types";
import { fill, t } from "@/messages/pt";

const D = t.emailAgent.detail;

/**
 * The examples exactly as the recipient gets them: subject, body and the CAN-SPAM footer (sender, postal address,
 * unsubscribe line). The link itself is a placeholder here: the real one is made per message at send time.
 */
export function SequenceExamples({ examples, sender, rehearsalOnly }: { examples: SequenceExample[]; sender: SenderProfile | null; rehearsalOnly: boolean }) {
  return (
    <section aria-labelledby="examples-title" className="flex flex-col gap-3">
      <h3 id="examples-title" className="text-base font-semibold">
        {D.examples}
      </h3>
      <p className="text-sm text-muted">{D.examplesHint}</p>
      {rehearsalOnly && (
        <p role="status" className="bg-warn-soft px-3 py-2.5 text-sm text-warn">
          {D.rehearsalOnly}
        </p>
      )}
      {examples.length === 0 && <p className="text-sm text-muted">{D.examplesNone}</p>}
      <ol className="m-0 flex list-none flex-col gap-4 p-0">
        {examples.map((ex) => (
          <li key={ex.prospect_id} className="flex flex-col gap-3 border border-line p-3">
            <p className="font-mono text-xs text-muted">{fill(D.exampleFor, { company: ex.company, to: ex.to })}</p>
            {ex.steps.map((s) => (
              <article key={s.step} className="flex flex-col gap-1 border-t border-line pt-2" data-example-step={s.step}>
                <span className="font-mono text-xs text-muted">{fill(D.stepTitle, { n: s.step })}</span>
                <p className="text-sm font-semibold">{s.subject}</p>
                <pre className="m-0 whitespace-pre-wrap font-sans text-sm">{s.body}</pre>
                {sender ? (
                  <pre className="m-0 whitespace-pre-wrap font-mono text-xs text-muted" data-footer>
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
