import { Badge } from "@/components/ui";
import { date, host } from "@/components/research/format";
import type { OppFacts } from "@/lib/hunt/top-opportunity";
import { word } from "@/lib/hunt/text";
import { getT } from "@/lib/i18n/server";
import { sanitizeUrl } from "@/lib/safe-url";

const label = "font-mono text-[13px] uppercase tracking-wide text-[#4a5361]";

/** The opportunity behind a call: the job, its date and source, why it ranks, the way in, the English hook and the questions. */
export async function OpportunityFacts({ opp }: { opp: OppFacts }) {
  const t = await getT();
  const O = t.hunt.opp;
  const src = sanitizeUrl(opp.source_url);
  const target = sanitizeUrl(opp.contact_value) ?? sanitizeUrl(opp.checks?.contact?.value_source_url);
  const via = sanitizeUrl(opp.checks?.contact?.value_source_url);
  const path =
    opp.contact_path === "phone" ? (
      <span>{O.phone}: <span className="font-mono font-semibold">{opp.contact_value}</span></span>
    ) : opp.contact_path === "none" ? (
      <span>{O.none}</span>
    ) : target ? (
      <a href={target} target="_blank" rel="noopener noreferrer" className="k-link font-semibold underline">{opp.contact_path === "vendor_portal" ? O.vendor : O.bids}</a>
    ) : (
      <span>{opp.contact_path === "vendor_portal" ? O.vendor : O.bids}</span>
    );
  return (
    <div className="flex flex-col gap-3 border-t border-[#e3e6ec] pt-4" data-testid="opportunity-facts">
      <span className={label}>{O.title}</span>
      {opp.title && <p className="m-0 text-lg font-semibold">{opp.title}</p>}
      <p className="m-0 text-base text-[#4a5361]">
        {O.date}: <span className="font-mono">{date(opp.signal_date, t.intl)}</span>
        {src && <> · <a href={src} target="_blank" rel="noopener noreferrer" className="k-link font-medium underline">{host(src)}</a></>}
      </p>
      {opp.priority_codes.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className={label}>{O.why}</span>
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {opp.priority_codes.map((c) => <li key={c}><Badge tone={c.startsWith("fails_") || c.endsWith("_deprioritized") || c.startsWith("below_") || c.startsWith("older_") ? "warn" : "honey"}>{word(t.hunt.priority, c)}</Badge></li>)}
          </ul>
        </div>
      )}
      <p className="m-0 text-base">
        <span className={`${label} block`}>{O.contact}</span>
        {path}
        {via && opp.contact_path !== "none" && <> · <a href={via} target="_blank" rel="noopener noreferrer" className="k-link text-[#4a5361] underline">{O.source}</a></>}
      </p>
      {opp.hook_en && (
        <p className="m-0 rounded-[14px] border-2 border-honey-edge bg-honey-soft px-4 py-3 text-lg leading-normal">
          <span className={`${label} block`}>{O.hook}</span>
          <q lang="en" className="[quotes:none]">{opp.hook_en}</q>
        </p>
      )}
      {opp.open_questions.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className={label}>{O.questions}</span>
          <ul className="m-0 list-disc pl-5 text-base">
            {opp.open_questions.map((q) => <li key={q}>{word(t.hunt.questions, q)}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
