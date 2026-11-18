import { Badge, Button, HexPanel } from "@/components/ui";
import { preferenceAction } from "@/app/(app)/agentes/campanhas/actions";
import { word } from "@/lib/hunt/text";
import { fill } from "@/lib/i18n";
import { getT } from "@/lib/i18n/server";
import type { CampaignParams } from "@/lib/offers/types";

export type PreferenceView = { id: string; status: "proposed" | "approved"; rule: CampaignParams; expected_effect: { up: number; down: number }; examples: string[] };

/** A lasting rule: the proposed one (Aprovar / Agora não) or an approved one (Desfazer). Nothing applies before approval. */
export async function PreferenceCard({ campaignId, pref }: { campaignId: string; pref: PreferenceView }) {
  const t = await getT();
  const P = t.hunt.pref;
  const rules = (["preferKinds", "deprioritizeKinds"] as const).flatMap((k) => (pref.rule[k]?.length ? [fill(P.ruleText[k], { kinds: pref.rule[k]!.map((x) => word(P.kinds, x)).join(", ") })] : []));
  const proposed = pref.status === "proposed";
  return (
    <HexPanel as="section" aria-label={P.title} tone={proposed ? "honey" : "white"} c={16} cSm={8} className="flex flex-col gap-3 py-5" data-testid={`pref-${pref.status}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 font-body text-lg font-semibold normal-case tracking-normal">{proposed ? P.title : P.approvedTitle}</h3>
        {!proposed && <Badge tone="ok">OK</Badge>}
      </div>
      {proposed && <p className="m-0 text-base text-[#4a5361]">{P.hint}</p>}
      <p className="m-0 text-base"><span className="block font-mono text-[13px] uppercase tracking-wide text-[#4a5361]">{P.rule}</span>{rules.join(" · ")}</p>
      {proposed && (
        <>
          {pref.examples.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="font-mono text-[13px] uppercase tracking-wide text-[#4a5361]">{P.examples}</span>
              <ul className="m-0 list-disc pl-5 text-base">{pref.examples.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </div>
          )}
          <p className="m-0 text-base"><span className="block font-mono text-[13px] uppercase tracking-wide text-[#4a5361]">{P.effect}</span>{fill(P.effectValue, pref.expected_effect)}</p>
        </>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {proposed ? (
          <>
            <form action={preferenceAction.bind(null, campaignId, pref.id, "approved")}><Button type="submit">{P.approve}</Button></form>
            <form action={preferenceAction.bind(null, campaignId, pref.id, "later")}><Button type="submit" variant="ghost">{P.later}</Button></form>
          </>
        ) : (
          <form action={preferenceAction.bind(null, campaignId, pref.id, "undone")}><Button type="submit" variant="secondary">{P.undo}</Button></form>
        )}
      </div>
    </HexPanel>
  );
}
