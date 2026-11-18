import { Badge, Field, HexButton, HexPanel, TextInput } from "@/components/ui";
import { startCampaignAction } from "@/app/(app)/agentes/campanhas/actions";
import type { Proposal } from "@/lib/hunt/proposals";
import { word } from "@/lib/hunt/text";
import { getT } from "@/lib/i18n/server";

const dt = "font-mono text-[13px] uppercase tracking-wide text-[#4a5361]";
const list = (map: Readonly<Record<string, string>>, codes: string[]) => codes.map((c) => word(map, c)).join(" · ");

/** One suggested search in business words, with a one-click start and an optional adjustment. */
export async function ProposalCard({ p, request, needRegion }: { p: Proposal; request: string; needRegion: boolean }) {
  const t = await getT();
  const P = t.hunt.proposals;
  const rows: [string, string][] = [
    [P.who, list(P.buyers, p.buyerCodes)],
    [P.why, list(P.whyFit, p.whyFitCodes)],
    [P.signal, list(P.signals, p.signalCodes)],
    [P.where, list(P.sources, p.sourceCodes)],
  ];
  if (p.assumptionCodes.length) rows.push([P.assumes, list(P.assumptions, p.assumptionCodes)]);
  if (p.recommendReasonCodes.length) rows.push([P.reason, list(P.reasons, p.recommendReasonCodes)]);
  const id = `p-${p.offer}`;
  return (
    <HexPanel as="article" aria-labelledby={`${id}-t`} tone={p.recommended ? "honey" : "white"} raised={p.recommended} className="flex flex-col gap-4 py-6" wrapClassName="k-in">
      <div className="flex flex-wrap items-center gap-3">
        <h3 id={`${id}-t`} className="m-0 min-w-0 font-body text-xl font-semibold normal-case tracking-normal">{word(P.titles, p.titleCode)}</h3>
        {p.recommended && <Badge tone="navy">{P.recommended}</Badge>}
      </div>
      <dl className="m-0 grid gap-3">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-0.5">
            <dt className={dt}>{k}</dt>
            <dd className="m-0 text-base">{v}</dd>
          </div>
        ))}
      </dl>
      <form action={startCampaignAction} className="flex max-w-xl flex-col gap-3">
        <input type="hidden" name="offer" value={p.offer} />
        <input type="hidden" name="request" value={request} />
        {needRegion && (
          <Field label={p.question ? word(P.questions, p.question) : P.regionLabel} htmlFor={`${id}-region`}>
            <TextInput id={`${id}-region`} name="region" placeholder={P.regionPlaceholder} maxLength={200} />
          </Field>
        )}
        <Field label={P.adjustLabel} htmlFor={`${id}-adjust`} hint={P.adjustHint}>
          <TextInput id={`${id}-adjust`} name="adjust" maxLength={300} />
        </Field>
        <div><HexButton type="submit" tone={p.recommended ? "navy" : "honey"}>{P.start}</HexButton></div>
      </form>
    </HexPanel>
  );
}
