"use client";

import { useEffect, useRef, useState } from "react";
import { Button, HexPanel } from "@/components/ui";
import { isEmptyNl, parseLeadQuery, type NlFilters } from "@/lib/leads/nl-search";
import { fill, type Messages } from "@/lib/i18n";
import { useT } from "@/lib/i18n/client";

const RULES_MS = 200;
const AI_MS = 800;

/** The chips of the detected filters, in the order the panel shows them. */
export function nlChips(f: NlFilters, t: Messages): string[] {
  const N = t.leads.nlSearch;
  const c = N.chips;
  return [
    ...(f.cities ?? []).map((v) => fill(c.city, { v })),
    ...(f.companyTypes ?? []).map((v) => fill(c.type, { v: N.types[v] })),
    ...(f.temperature && f.temperature !== "all" && f.temperature !== "none" ? [fill(c.temperature, { v: t.research.labels.temperature[f.temperature] })] : []),
    ...(f.levels ?? []).map((v) => fill(c.level, { v })),
    ...(f.minLevel ? [fill(c.minLevel, { v: f.minLevel })] : []),
    ...(f.hasPhone ? [c.phone] : []),
    ...(f.hasEmail ? [c.email] : []),
    ...(f.emailQuality ?? []).map((v) => fill(c.emailQuality, { v: t.leads.emailQuality.labels[v] })),
    ...(f.contact && f.contact !== "all" ? [fill(c.contact, { v: t.leads.contactTabs[f.contact] })] : []),
  ];
}

/**
 * "Descreva quem você quer": local rules after 200 ms, then (only when words were left over) the AI after 800 ms,
 * which replaces the rules' result. Each keystroke aborts the previous AI request. Nothing is applied until
 * "Aplicar filtros".
 */
export function NlSearch({ cities, onApply, initialText = "" }: { cities: string[]; onApply: (f: NlFilters) => void; initialText?: string }) {
  const t = useT();
  const N = t.leads.nlSearch;
  const [text, setText] = useState(initialText);
  const [found, setFound] = useState<NlFilters | null>(null);
  const [thinking, setThinking] = useState(false);
  const [aiOff, setAiOff] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    abort.current?.abort();
    const q = text.trim();
    if (!q) return; // an empty box shows nothing (see `active`)
    let unparsed: string[] = [];
    const rules = setTimeout(() => {
      const r = parseLeadQuery(q, cities);
      unparsed = r.unparsed;
      setFound(r.filters);
      setAiOff(false);
      setThinking(r.unparsed.length > 0); // the AI layer will run: do not say "nothing found" yet
    }, RULES_MS);
    const ai = setTimeout(async () => {
      if (unparsed.length === 0) return;
      const ctl = new AbortController();
      abort.current = ctl;
      try {
        const res = await fetch("/api/leads/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: q, cities: cities.slice(0, 300) }), signal: ctl.signal });
        const j = (await res.json()) as { filters?: NlFilters; error?: string };
        if (ctl.signal.aborted) return;
        if (j.filters && !isEmptyNl(j.filters)) setFound(j.filters);
        else if (j.error) setAiOff(true);
      } catch {
        if (!ctl.signal.aborted) setAiOff(true);
      } finally {
        if (!ctl.signal.aborted) setThinking(false);
      }
    }, AI_MS);
    return () => {
      clearTimeout(rules);
      clearTimeout(ai);
    };
  }, [text, cities]);

  const active = text.trim() !== "";
  const chips = active && found ? nlChips(found, t) : [];
  const settled = active && found !== null && !thinking;
  return (
    <HexPanel tone="honey" c={20} cSm={10} className="flex flex-col gap-3 py-5" wrapClassName="k-in">
      <label className="flex flex-col gap-2">
        <span className="flex items-center gap-2.5 text-lg font-semibold">
          <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden className="shrink-0">
            <path className="fill-honey stroke-honey" strokeWidth="1.6" strokeLinejoin="round" d="M12 2 20.7 7v10L12 22 3.3 17V7Z" />
            <path d="M9 10.5a3 3 0 1 0 6 0 3 3 0 1 0-6 0M14.2 12.7 16 14.5" className="fill-none stroke-ink" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          {N.label}
        </span>
        <span className="k-field flex min-h-[58px] items-center rounded-[16px] border-2 border-line bg-surface px-[18px]">
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={N.placeholder}
            maxLength={200}
            className="min-w-0 flex-1 bg-transparent text-[17px] text-ink placeholder:text-[#4a5361]"
          />
        </span>
      </label>
      <div aria-live="polite" className="flex flex-col gap-2">
        {active && thinking && <p className="m-0 text-base text-[#4a5361]">{N.thinking}</p>}
        {chips.length > 0 && (
          <div className="k-fade flex flex-wrap items-center gap-2">
            <span className="mr-1 text-base text-[#4a5361]">{N.detected}</span>
            {chips.map((c) => (
              <span key={c} className="inline-flex min-h-10 items-center rounded-full border-2 border-honey bg-honey-light px-4 text-[15px] font-medium text-ink">
                {c}
              </span>
            ))}
            <Button type="button" onClick={() => found && onApply(found)} className="ml-auto">
              {N.apply}
            </Button>
          </div>
        )}
        {settled && chips.length > 0 && aiOff && <p className="m-0 text-[15px] text-[#4a5361]">{N.aiOff}</p>}
        {settled && chips.length === 0 && <p className="m-0 text-[15px] text-[#4a5361]">{N.nothing}</p>}
      </div>
    </HexPanel>
  );
}
